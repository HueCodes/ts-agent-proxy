import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CircuitBreaker,
  CircuitState,
  CircuitOpenError,
  createCircuitBreaker,
  withCircuitBreaker,
} from '../src/proxy/circuit-breaker.js';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      successThreshold: 2,
      resetTimeout: 1000,
      failureWindow: 5000,
    });
  });

  describe('initial state', () => {
    it('should start in closed state', () => {
      expect(breaker.getState('test')).toBe(CircuitState.CLOSED);
    });

    it('should allow execution in closed state', () => {
      const result = breaker.canExecute('test');
      expect(result.allowed).toBe(true);
      expect(result.state).toBe(CircuitState.CLOSED);
    });
  });

  describe('failure tracking', () => {
    it('should trip after failure threshold', () => {
      const key = 'api.example.com:443';

      // Record failures up to threshold
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure(key, new Error(`Failure ${i}`));
      }

      expect(breaker.getState(key)).toBe(CircuitState.OPEN);
    });

    it('should not trip below threshold', () => {
      const key = 'api.example.com:443';

      breaker.recordFailure(key, new Error('Failure 1'));
      breaker.recordFailure(key, new Error('Failure 2'));

      expect(breaker.getState(key)).toBe(CircuitState.CLOSED);
    });

    it('should reject requests when open', () => {
      const key = 'api.example.com:443';

      // Trip the circuit
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure(key, new Error(`Failure ${i}`));
      }

      const result = breaker.canExecute(key);
      expect(result.allowed).toBe(false);
      expect(result.state).toBe(CircuitState.OPEN);
      expect(result.resetIn).toBeDefined();
    });
  });

  describe('recovery', () => {
    it('should transition to half-open after timeout', async () => {
      const key = 'api.example.com:443';

      // Trip the circuit
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure(key, new Error(`Failure ${i}`));
      }

      expect(breaker.getState(key)).toBe(CircuitState.OPEN);

      // Wait for reset timeout
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const result = breaker.canExecute(key);
      expect(result.allowed).toBe(true);
      expect(result.state).toBe(CircuitState.HALF_OPEN);
    });

    it('should close after success threshold in half-open', async () => {
      const key = 'api.example.com:443';

      // Trip and wait
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure(key, new Error(`Failure ${i}`));
      }
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // First request transitions to half-open
      breaker.canExecute(key);

      // Record successes
      breaker.recordSuccess(key, 100);
      expect(breaker.getState(key)).toBe(CircuitState.HALF_OPEN);

      breaker.recordSuccess(key, 100);
      expect(breaker.getState(key)).toBe(CircuitState.CLOSED);
    });

    it('should reopen on failure in half-open', async () => {
      const key = 'api.example.com:443';

      // Trip and wait
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure(key, new Error(`Failure ${i}`));
      }
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Transition to half-open
      breaker.canExecute(key);
      expect(breaker.getState(key)).toBe(CircuitState.HALF_OPEN);

      // Failure reopens
      breaker.recordFailure(key, new Error('Still failing'));
      expect(breaker.getState(key)).toBe(CircuitState.OPEN);
    });
  });

  describe('half-open concurrency', () => {
    it('should limit concurrent requests in half-open', async () => {
      const breakerLimited = new CircuitBreaker({
        failureThreshold: 3,
        resetTimeout: 100,
        halfOpenMaxConcurrent: 1,
      });

      const key = 'test';

      // Trip
      for (let i = 0; i < 3; i++) {
        breakerLimited.recordFailure(key, new Error('fail'));
      }

      await new Promise((resolve) => setTimeout(resolve, 150));

      // First request allowed
      const first = breakerLimited.canExecute(key);
      expect(first.allowed).toBe(true);

      // Second request blocked (concurrent limit)
      const second = breakerLimited.canExecute(key);
      expect(second.allowed).toBe(false);
      expect(second.state).toBe(CircuitState.HALF_OPEN);
    });
  });

  describe('failure window', () => {
    it('should not count old failures', async () => {
      const breakerShortWindow = new CircuitBreaker({
        failureThreshold: 3,
        failureWindow: 100,
        resetTimeout: 1000,
      });

      const key = 'test';

      // First failure
      breakerShortWindow.recordFailure(key, new Error('fail'));

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      // More failures (old one should be gone)
      breakerShortWindow.recordFailure(key, new Error('fail'));
      breakerShortWindow.recordFailure(key, new Error('fail'));

      // Should still be closed (only 2 recent failures)
      expect(breakerShortWindow.getState(key)).toBe(CircuitState.CLOSED);
    });
  });

  describe('callbacks', () => {
    it('should call onStateChange callback', () => {
      const onStateChange = vi.fn();
      const breakerWithCallback = new CircuitBreaker({
        failureThreshold: 2,
        onStateChange,
      });

      const key = 'test';

      breakerWithCallback.recordFailure(key, new Error('fail'));
      breakerWithCallback.recordFailure(key, new Error('fail'));

      expect(onStateChange).toHaveBeenCalledWith(
        key,
        CircuitState.CLOSED,
        CircuitState.OPEN
      );
    });

    it('should call onFailure callback', () => {
      const onFailure = vi.fn();
      const breakerWithCallback = new CircuitBreaker({ onFailure });

      const key = 'test';
      const error = new Error('test error');

      breakerWithCallback.recordFailure(key, error);

      expect(onFailure).toHaveBeenCalledWith(key, error);
    });

    it('should call onSuccess callback', () => {
      const onSuccess = vi.fn();
      const breakerWithCallback = new CircuitBreaker({ onSuccess });

      const key = 'test';

      breakerWithCallback.canExecute(key);
      breakerWithCallback.recordSuccess(key, 150);

      expect(onSuccess).toHaveBeenCalledWith(key, 150);
    });
  });

  describe('manual control', () => {
    it('should force state', () => {
      const key = 'test';

      breaker.forceState(key, CircuitState.OPEN);
      expect(breaker.getState(key)).toBe(CircuitState.OPEN);

      breaker.forceState(key, CircuitState.CLOSED);
      expect(breaker.getState(key)).toBe(CircuitState.CLOSED);
    });

    it('should reset circuit', () => {
      const key = 'test';

      // Trip
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure(key, new Error('fail'));
      }
      expect(breaker.getState(key)).toBe(CircuitState.OPEN);

      // Reset
      breaker.reset(key);
      expect(breaker.getState(key)).toBe(CircuitState.CLOSED);
    });

    it('should reset all circuits', () => {
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure('key1', new Error('fail'));
        breaker.recordFailure('key2', new Error('fail'));
      }

      expect(breaker.getState('key1')).toBe(CircuitState.OPEN);
      expect(breaker.getState('key2')).toBe(CircuitState.OPEN);

      breaker.resetAll();

      expect(breaker.getState('key1')).toBe(CircuitState.CLOSED);
      expect(breaker.getState('key2')).toBe(CircuitState.CLOSED);
    });

    it('should remove circuit', () => {
      const key = 'test';
      breaker.recordFailure(key, new Error('fail'));

      expect(breaker.remove(key)).toBe(true);
      expect(breaker.remove(key)).toBe(false);
    });
  });

  describe('statistics', () => {
    it('should track statistics', () => {
      const key = 'test';

      breaker.canExecute(key);
      breaker.recordSuccess(key, 100);
      breaker.recordSuccess(key, 200);
      breaker.recordFailure(key, new Error('fail'));

      const stats = breaker.getCircuitStats(key);

      expect(stats).not.toBeNull();
      expect(stats!.totalRequests).toBe(3);
      expect(stats!.totalFailures).toBe(1);
      expect(stats!.averageLatency).toBe(100); // (100 + 200 + 0) / 3
    });

    it('should get all stats', () => {
      breaker.canExecute('key1');
      breaker.recordSuccess('key1', 100);

      for (let i = 0; i < 3; i++) {
        breaker.recordFailure('key2', new Error('fail'));
      }

      const stats = breaker.getStats();

      expect(stats.totalCircuits).toBe(2);
      expect(stats.stateCount[CircuitState.CLOSED]).toBe(1);
      expect(stats.stateCount[CircuitState.OPEN]).toBe(1);
    });
  });
});

describe('withCircuitBreaker', () => {
  it('should execute function when circuit is closed', async () => {
    const breaker = createCircuitBreaker();
    const fn = vi.fn().mockResolvedValue('success');

    const result = await withCircuitBreaker(breaker, 'test', fn);

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalled();
  });

  it('should throw CircuitOpenError when open', async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 1 });

    breaker.recordFailure('test', new Error('fail'));

    await expect(
      withCircuitBreaker(breaker, 'test', () => Promise.resolve('success'))
    ).rejects.toThrow(CircuitOpenError);
  });

  it('should record failure on function error', async () => {
    const breaker = createCircuitBreaker();
    const error = new Error('test error');

    await expect(
      withCircuitBreaker(breaker, 'test', () => Promise.reject(error))
    ).rejects.toThrow(error);

    const stats = breaker.getCircuitStats('test');
    expect(stats!.totalFailures).toBe(1);
  });
});

describe('CircuitOpenError', () => {
  it('should have correct properties', () => {
    const error = new CircuitOpenError('test-key', CircuitState.OPEN, 5000);

    expect(error.name).toBe('CircuitOpenError');
    expect(error.key).toBe('test-key');
    expect(error.state).toBe(CircuitState.OPEN);
    expect(error.resetIn).toBe(5000);
    expect(error.message).toContain('test-key');
  });
});
