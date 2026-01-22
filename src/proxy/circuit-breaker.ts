/**
 * Circuit breaker for upstream targets.
 *
 * Implements the circuit breaker pattern to protect the proxy from
 * failing upstreams by detecting failures and temporarily stopping
 * requests to unhealthy targets.
 *
 * @module proxy/circuit-breaker
 */

/**
 * Circuit breaker states.
 */
export enum CircuitState {
  /** Normal operation, requests flow through */
  CLOSED = 'closed',
  /** Circuit is open, requests are rejected */
  OPEN = 'open',
  /** Testing if upstream has recovered */
  HALF_OPEN = 'half_open',
}

/**
 * Circuit breaker configuration.
 */
export interface CircuitBreakerConfig {
  /** Number of failures to trip the circuit (default: 5) */
  failureThreshold?: number;
  /** Number of successes in half-open to close (default: 2) */
  successThreshold?: number;
  /** Time in ms before trying again (default: 30000) */
  resetTimeout?: number;
  /** Time window in ms to count failures (default: 60000) */
  failureWindow?: number;
  /** Maximum concurrent requests in half-open state (default: 1) */
  halfOpenMaxConcurrent?: number;
  /** Optional callback on state change */
  onStateChange?: (key: string, oldState: CircuitState, newState: CircuitState) => void;
  /** Optional callback on failure */
  onFailure?: (key: string, error: Error) => void;
  /** Optional callback on success */
  onSuccess?: (key: string, latency: number) => void;
}

/**
 * Circuit state for a single upstream.
 */
interface CircuitEntry {
  state: CircuitState;
  failures: FailureRecord[];
  successCount: number;
  lastFailure: number;
  openedAt: number;
  halfOpenConcurrent: number;
  totalRequests: number;
  totalFailures: number;
  totalLatency: number;
}

/**
 * Individual failure record.
 */
interface FailureRecord {
  timestamp: number;
  error: string;
}

/**
 * Circuit breaker statistics.
 */
export interface CircuitBreakerStats {
  /** Total circuits being tracked */
  totalCircuits: number;
  /** Circuits by state */
  stateCount: Record<CircuitState, number>;
  /** Per-circuit statistics */
  circuits: Map<string, CircuitStats>;
}

/**
 * Individual circuit statistics.
 */
export interface CircuitStats {
  key: string;
  state: CircuitState;
  failureCount: number;
  successCount: number;
  totalRequests: number;
  totalFailures: number;
  averageLatency: number;
  lastFailure: number | null;
  openedAt: number | null;
}

/**
 * Circuit breaker result.
 */
export interface CircuitBreakerResult {
  /** Whether request is allowed */
  allowed: boolean;
  /** Current circuit state */
  state: CircuitState;
  /** Time until reset (if open) */
  resetIn?: number;
}

/**
 * Circuit breaker class.
 *
 * Protects against cascade failures by monitoring upstream health
 * and temporarily blocking requests to failing upstreams.
 *
 * States:
 * - CLOSED: Normal operation, all requests pass through
 * - OPEN: Circuit tripped, all requests are rejected
 * - HALF_OPEN: Testing recovery, limited requests allowed
 *
 * @example
 * ```typescript
 * const breaker = new CircuitBreaker({
 *   failureThreshold: 5,
 *   resetTimeout: 30000,
 * });
 *
 * // Before making request
 * const result = breaker.canExecute('api.example.com:443');
 * if (!result.allowed) {
 *   return new Error('Circuit open, try again later');
 * }
 *
 * // After request
 * try {
 *   const response = await makeRequest();
 *   breaker.recordSuccess('api.example.com:443', latency);
 * } catch (error) {
 *   breaker.recordFailure('api.example.com:443', error);
 *   throw error;
 * }
 * ```
 */
export class CircuitBreaker {
  private readonly config: Required<Omit<CircuitBreakerConfig, 'onStateChange' | 'onFailure' | 'onSuccess'>> &
    Pick<CircuitBreakerConfig, 'onStateChange' | 'onFailure' | 'onSuccess'>;
  private readonly circuits: Map<string, CircuitEntry> = new Map();

  constructor(config: CircuitBreakerConfig = {}) {
    this.config = {
      failureThreshold: config.failureThreshold ?? 5,
      successThreshold: config.successThreshold ?? 2,
      resetTimeout: config.resetTimeout ?? 30000,
      failureWindow: config.failureWindow ?? 60000,
      halfOpenMaxConcurrent: config.halfOpenMaxConcurrent ?? 1,
      onStateChange: config.onStateChange,
      onFailure: config.onFailure,
      onSuccess: config.onSuccess,
    };
  }

  /**
   * Check if a request can be executed.
   */
  canExecute(key: string): CircuitBreakerResult {
    const circuit = this.getOrCreateCircuit(key);
    const now = Date.now();

    switch (circuit.state) {
      case CircuitState.CLOSED:
        return { allowed: true, state: CircuitState.CLOSED };

      case CircuitState.OPEN: {
        const elapsed = now - circuit.openedAt;
        if (elapsed >= this.config.resetTimeout) {
          // Transition to half-open
          this.transitionState(key, circuit, CircuitState.HALF_OPEN);
          circuit.halfOpenConcurrent++;
          return { allowed: true, state: CircuitState.HALF_OPEN };
        }
        return {
          allowed: false,
          state: CircuitState.OPEN,
          resetIn: this.config.resetTimeout - elapsed,
        };
      }

      case CircuitState.HALF_OPEN: {
        if (circuit.halfOpenConcurrent < this.config.halfOpenMaxConcurrent) {
          circuit.halfOpenConcurrent++;
          return { allowed: true, state: CircuitState.HALF_OPEN };
        }
        return { allowed: false, state: CircuitState.HALF_OPEN };
      }
    }
  }

  /**
   * Record a successful request.
   */
  recordSuccess(key: string, latencyMs: number = 0): void {
    const circuit = this.circuits.get(key);
    if (!circuit) return;

    circuit.totalRequests++;
    circuit.totalLatency += latencyMs;

    if (this.config.onSuccess) {
      this.config.onSuccess(key, latencyMs);
    }

    switch (circuit.state) {
      case CircuitState.HALF_OPEN:
        circuit.halfOpenConcurrent = Math.max(0, circuit.halfOpenConcurrent - 1);
        circuit.successCount++;

        if (circuit.successCount >= this.config.successThreshold) {
          // Recovered, close circuit
          this.transitionState(key, circuit, CircuitState.CLOSED);
          circuit.failures = [];
          circuit.successCount = 0;
        }
        break;

      case CircuitState.CLOSED:
        // Remove old failures outside the window
        this.cleanupOldFailures(circuit);
        break;
    }
  }

  /**
   * Record a failed request.
   */
  recordFailure(key: string, error: Error): void {
    const circuit = this.getOrCreateCircuit(key);
    const now = Date.now();

    circuit.totalRequests++;
    circuit.totalFailures++;
    circuit.lastFailure = now;

    if (this.config.onFailure) {
      this.config.onFailure(key, error);
    }

    switch (circuit.state) {
      case CircuitState.CLOSED:
        // Clean up old failures and add new one
        this.cleanupOldFailures(circuit);
        circuit.failures.push({ timestamp: now, error: error.message });

        if (circuit.failures.length >= this.config.failureThreshold) {
          // Trip the circuit
          this.transitionState(key, circuit, CircuitState.OPEN);
          circuit.openedAt = now;
        }
        break;

      case CircuitState.HALF_OPEN:
        circuit.halfOpenConcurrent = Math.max(0, circuit.halfOpenConcurrent - 1);
        // Any failure in half-open reopens the circuit
        this.transitionState(key, circuit, CircuitState.OPEN);
        circuit.openedAt = now;
        circuit.successCount = 0;
        break;
    }
  }

  /**
   * Get the current state of a circuit.
   */
  getState(key: string): CircuitState {
    const circuit = this.circuits.get(key);
    return circuit?.state ?? CircuitState.CLOSED;
  }

  /**
   * Force a circuit to a specific state.
   */
  forceState(key: string, state: CircuitState): void {
    const circuit = this.getOrCreateCircuit(key);
    this.transitionState(key, circuit, state);

    if (state === CircuitState.CLOSED) {
      circuit.failures = [];
      circuit.successCount = 0;
    } else if (state === CircuitState.OPEN) {
      circuit.openedAt = Date.now();
    }
  }

  /**
   * Reset a circuit to closed state.
   */
  reset(key: string): void {
    const circuit = this.circuits.get(key);
    if (circuit) {
      this.transitionState(key, circuit, CircuitState.CLOSED);
      circuit.failures = [];
      circuit.successCount = 0;
      circuit.halfOpenConcurrent = 0;
    }
  }

  /**
   * Reset all circuits.
   */
  resetAll(): void {
    for (const key of this.circuits.keys()) {
      this.reset(key);
    }
  }

  /**
   * Remove a circuit from tracking.
   */
  remove(key: string): boolean {
    return this.circuits.delete(key);
  }

  /**
   * Get statistics for all circuits.
   */
  getStats(): CircuitBreakerStats {
    const stateCount: Record<CircuitState, number> = {
      [CircuitState.CLOSED]: 0,
      [CircuitState.OPEN]: 0,
      [CircuitState.HALF_OPEN]: 0,
    };

    const circuits = new Map<string, CircuitStats>();

    for (const [key, circuit] of this.circuits) {
      stateCount[circuit.state]++;

      circuits.set(key, {
        key,
        state: circuit.state,
        failureCount: circuit.failures.length,
        successCount: circuit.successCount,
        totalRequests: circuit.totalRequests,
        totalFailures: circuit.totalFailures,
        averageLatency: circuit.totalRequests > 0
          ? circuit.totalLatency / circuit.totalRequests
          : 0,
        lastFailure: circuit.lastFailure || null,
        openedAt: circuit.state === CircuitState.OPEN ? circuit.openedAt : null,
      });
    }

    return {
      totalCircuits: this.circuits.size,
      stateCount,
      circuits,
    };
  }

  /**
   * Get statistics for a single circuit.
   */
  getCircuitStats(key: string): CircuitStats | null {
    const circuit = this.circuits.get(key);
    if (!circuit) return null;

    return {
      key,
      state: circuit.state,
      failureCount: circuit.failures.length,
      successCount: circuit.successCount,
      totalRequests: circuit.totalRequests,
      totalFailures: circuit.totalFailures,
      averageLatency: circuit.totalRequests > 0
        ? circuit.totalLatency / circuit.totalRequests
        : 0,
      lastFailure: circuit.lastFailure || null,
      openedAt: circuit.state === CircuitState.OPEN ? circuit.openedAt : null,
    };
  }

  /**
   * Get or create a circuit entry.
   */
  private getOrCreateCircuit(key: string): CircuitEntry {
    let circuit = this.circuits.get(key);
    if (!circuit) {
      circuit = {
        state: CircuitState.CLOSED,
        failures: [],
        successCount: 0,
        lastFailure: 0,
        openedAt: 0,
        halfOpenConcurrent: 0,
        totalRequests: 0,
        totalFailures: 0,
        totalLatency: 0,
      };
      this.circuits.set(key, circuit);
    }
    return circuit;
  }

  /**
   * Transition circuit to a new state.
   */
  private transitionState(key: string, circuit: CircuitEntry, newState: CircuitState): void {
    if (circuit.state !== newState) {
      const oldState = circuit.state;
      circuit.state = newState;

      if (this.config.onStateChange) {
        this.config.onStateChange(key, oldState, newState);
      }
    }
  }

  /**
   * Remove failures outside the time window.
   */
  private cleanupOldFailures(circuit: CircuitEntry): void {
    const cutoff = Date.now() - this.config.failureWindow;
    circuit.failures = circuit.failures.filter((f) => f.timestamp >= cutoff);
  }
}

/**
 * Create a circuit breaker.
 */
export function createCircuitBreaker(config?: CircuitBreakerConfig): CircuitBreaker {
  return new CircuitBreaker(config);
}

/**
 * Wrapper to execute a function with circuit breaker protection.
 */
export async function withCircuitBreaker<T>(
  breaker: CircuitBreaker,
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  const result = breaker.canExecute(key);

  if (!result.allowed) {
    throw new CircuitOpenError(key, result.state, result.resetIn);
  }

  const startTime = Date.now();

  try {
    const value = await fn();
    breaker.recordSuccess(key, Date.now() - startTime);
    return value;
  } catch (error) {
    breaker.recordFailure(key, error as Error);
    throw error;
  }
}

/**
 * Error thrown when circuit is open.
 */
export class CircuitOpenError extends Error {
  readonly key: string;
  readonly state: CircuitState;
  readonly resetIn?: number;

  constructor(key: string, state: CircuitState, resetIn?: number) {
    super(`Circuit breaker open for ${key}`);
    this.name = 'CircuitOpenError';
    this.key = key;
    this.state = state;
    this.resetIn = resetIn;
  }
}
