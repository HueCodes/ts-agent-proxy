/**
 * Metrics collection for the proxy server.
 *
 * Tracks request counts, latency, and other operational metrics.
 *
 * @module admin/metrics
 */

/**
 * Metrics data for a single rule.
 */
export interface RuleMetrics {
  /** Number of requests allowed by this rule */
  allowed: number;
  /** Number of requests denied by this rule */
  denied: number;
  /** Number of requests rate limited */
  rateLimited: number;
}

/**
 * Complete proxy server metrics.
 */
export interface ProxyMetrics {
  /** Total requests received */
  requestsTotal: number;
  /** Requests allowed through */
  requestsAllowed: number;
  /** Requests denied */
  requestsDenied: number;
  /** Requests rate limited */
  requestsRateLimited: number;
  /** Current active connections */
  activeConnections: number;
  /** Server uptime in seconds */
  uptimeSeconds: number;
  /** Number of configured rules */
  rulesCount: number;
  /** Metrics broken down by rule */
  byRule: Record<string, RuleMetrics>;
  /** Timestamp when metrics were collected */
  timestamp: string;
}

/**
 * Metrics collector for tracking proxy operations.
 *
 * Thread-safe counter operations for tracking requests,
 * connections, and per-rule statistics.
 *
 * @example
 * ```typescript
 * const metrics = new MetricsCollector();
 *
 * // Track a request
 * metrics.recordRequest('allowed', 'openai-api');
 *
 * // Get current metrics
 * const snapshot = metrics.getMetrics(config.allowlist.rules.length);
 * console.log(`Total requests: ${snapshot.requestsTotal}`);
 * ```
 */
export class MetricsCollector {
  private requestsTotal = 0;
  private requestsAllowed = 0;
  private requestsDenied = 0;
  private requestsRateLimited = 0;
  private activeConnections = 0;
  private readonly byRule: Map<string, RuleMetrics> = new Map();
  private readonly startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  /**
   * Record a request with its outcome.
   *
   * @param decision - The decision made for the request
   * @param ruleId - Optional rule ID that matched
   */
  recordRequest(
    decision: 'allowed' | 'denied' | 'rate_limited',
    ruleId?: string
  ): void {
    this.requestsTotal++;

    switch (decision) {
      case 'allowed':
        this.requestsAllowed++;
        break;
      case 'denied':
        this.requestsDenied++;
        break;
      case 'rate_limited':
        this.requestsRateLimited++;
        break;
    }

    if (ruleId) {
      const ruleMetrics = this.byRule.get(ruleId) ?? {
        allowed: 0,
        denied: 0,
        rateLimited: 0,
      };

      switch (decision) {
        case 'allowed':
          ruleMetrics.allowed++;
          break;
        case 'denied':
          ruleMetrics.denied++;
          break;
        case 'rate_limited':
          ruleMetrics.rateLimited++;
          break;
      }

      this.byRule.set(ruleId, ruleMetrics);
    }
  }

  /**
   * Increment active connection count.
   */
  connectionOpened(): void {
    this.activeConnections++;
  }

  /**
   * Decrement active connection count.
   */
  connectionClosed(): void {
    this.activeConnections = Math.max(0, this.activeConnections - 1);
  }

  /**
   * Get current metrics snapshot.
   *
   * @param rulesCount - Number of configured rules
   * @returns Current metrics snapshot
   */
  getMetrics(rulesCount: number): ProxyMetrics {
    const byRule: Record<string, RuleMetrics> = {};
    for (const [ruleId, metrics] of this.byRule) {
      byRule[ruleId] = { ...metrics };
    }

    return {
      requestsTotal: this.requestsTotal,
      requestsAllowed: this.requestsAllowed,
      requestsDenied: this.requestsDenied,
      requestsRateLimited: this.requestsRateLimited,
      activeConnections: this.activeConnections,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      rulesCount,
      byRule,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Reset all metrics to zero.
   */
  reset(): void {
    this.requestsTotal = 0;
    this.requestsAllowed = 0;
    this.requestsDenied = 0;
    this.requestsRateLimited = 0;
    this.activeConnections = 0;
    this.byRule.clear();
  }
}

/**
 * Create a new metrics collector.
 *
 * @returns New MetricsCollector instance
 */
export function createMetricsCollector(): MetricsCollector {
  return new MetricsCollector();
}
