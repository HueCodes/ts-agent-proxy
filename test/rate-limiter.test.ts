import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter, createRateLimiter } from '../src/filter/rate-limiter.js';
import type { AllowlistRule } from '../src/types/allowlist.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(10); // 10 requests per minute default
  });

  describe('basic limiting', () => {
    it('should allow requests within limit', async () => {
      const result = await limiter.consume('test-key');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);
    });

    it('should deny requests over limit', async () => {
      // Consume all allowed requests
      for (let i = 0; i < 10; i++) {
        await limiter.consume('test-key');
      }

      const result = await limiter.consume('test-key');
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.resetMs).toBeGreaterThan(0);
    });
  });

  describe('per-key limiting', () => {
    it('should track limits per key', async () => {
      for (let i = 0; i < 10; i++) {
        await limiter.consume('key-1');
      }

      const result1 = await limiter.consume('key-1');
      const result2 = await limiter.consume('key-2');

      expect(result1.allowed).toBe(false);
      expect(result2.allowed).toBe(true);
    });
  });

  describe('rule-specific limits', () => {
    it('should use rule-specific limits', async () => {
      const rules: AllowlistRule[] = [
        {
          id: 'strict-rule',
          domain: 'strict.com',
          rateLimit: { requestsPerMinute: 2 },
        },
      ];

      limiter.registerRules(rules);

      await limiter.consume('key', 'strict-rule');
      await limiter.consume('key', 'strict-rule');
      const result = await limiter.consume('key', 'strict-rule');

      expect(result.allowed).toBe(false);
    });

    it('should fall back to default for unknown rules', async () => {
      const result = await limiter.consume('key', 'unknown-rule');
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(10);
    });
  });

  describe('getStatus', () => {
    it('should get status without consuming', async () => {
      await limiter.consume('test-key');
      const status = await limiter.getStatus('test-key');

      expect(status.remaining).toBe(9);

      // Status shouldn't change
      const status2 = await limiter.getStatus('test-key');
      expect(status2.remaining).toBe(9);
    });

    it('should return full limit for new keys', async () => {
      const status = await limiter.getStatus('new-key');
      expect(status.remaining).toBe(10);
      expect(status.allowed).toBe(true);
    });
  });

  describe('reset', () => {
    it('should reset limit for a key', async () => {
      for (let i = 0; i < 10; i++) {
        await limiter.consume('test-key');
      }

      await limiter.reset('test-key');

      const result = await limiter.consume('test-key');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);
    });
  });
});

describe('createRateLimiter', () => {
  it('should create limiter with pre-registered rules', async () => {
    const rules: AllowlistRule[] = [
      {
        id: 'test-rule',
        domain: 'test.com',
        rateLimit: { requestsPerMinute: 5 },
      },
    ];

    const limiter = createRateLimiter(rules, 100);

    // Use rule-specific limit
    for (let i = 0; i < 5; i++) {
      await limiter.consume('key', 'test-rule');
    }
    const ruleResult = await limiter.consume('key', 'test-rule');
    expect(ruleResult.allowed).toBe(false);

    // Default limit should still work
    const defaultResult = await limiter.consume('key2');
    expect(defaultResult.allowed).toBe(true);
    expect(defaultResult.limit).toBe(100);
  });
});

describe('RateLimiter headers', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(10);
  });

  it('should include rate limit headers in result', async () => {
    const result = await limiter.consume('test-key');

    expect(result.headers).toBeDefined();
    expect(result.headers['X-RateLimit-Limit']).toBe('10');
    expect(result.headers['X-RateLimit-Remaining']).toBe('9');
    expect(result.headers['X-RateLimit-Reset']).toBeDefined();
  });

  it('should include Retry-After header when rate limited', async () => {
    // Consume all allowed requests
    for (let i = 0; i < 10; i++) {
      await limiter.consume('test-key');
    }

    const result = await limiter.consume('test-key');

    expect(result.allowed).toBe(false);
    expect(result.headers['Retry-After']).toBeDefined();
    expect(parseInt(result.headers['Retry-After']!, 10)).toBeGreaterThan(0);
  });

  it('should not include Retry-After when allowed', async () => {
    const result = await limiter.consume('test-key');

    expect(result.allowed).toBe(true);
    expect(result.headers['Retry-After']).toBeUndefined();
  });

  it('should include headers in getStatus result', async () => {
    await limiter.consume('test-key');
    const status = await limiter.getStatus('test-key');

    expect(status.headers).toBeDefined();
    expect(status.headers['X-RateLimit-Limit']).toBe('10');
    expect(status.headers['X-RateLimit-Remaining']).toBe('9');
  });
});

describe('RateLimiter statistics', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(5);
  });

  it('should track total requests', async () => {
    await limiter.consume('key1');
    await limiter.consume('key2');
    await limiter.consume('key1');

    const stats = limiter.getStats();
    expect(stats.totalRequests).toBe(3);
  });

  it('should track allowed requests', async () => {
    await limiter.consume('key1');
    await limiter.consume('key2');

    const stats = limiter.getStats();
    expect(stats.totalAllowed).toBe(2);
  });

  it('should track rejected requests', async () => {
    for (let i = 0; i < 7; i++) {
      await limiter.consume('key');
    }

    const stats = limiter.getStats();
    expect(stats.totalRejected).toBe(2);
  });

  it('should calculate rejection rate', async () => {
    for (let i = 0; i < 10; i++) {
      await limiter.consume('key');
    }

    const stats = limiter.getStats();
    expect(stats.rejectionRate).toBe(0.5); // 5 allowed, 5 rejected
  });

  it('should track registered rules', async () => {
    limiter.registerRule('rule1', { requestsPerMinute: 10 });
    limiter.registerRule('rule2', { requestsPerMinute: 20 });

    const stats = limiter.getStats();
    expect(stats.registeredRules).toBe(2);
  });

  it('should reset statistics', async () => {
    await limiter.consume('key');
    await limiter.consume('key');

    limiter.resetStats();

    const stats = limiter.getStats();
    expect(stats.totalRequests).toBe(0);
    expect(stats.totalAllowed).toBe(0);
    expect(stats.totalRejected).toBe(0);
  });

  it('should include config in stats', () => {
    const stats = limiter.getStats();
    expect(stats.config).toBeDefined();
    expect(stats.config.defaultRequestsPerMinute).toBe(5);
  });
});

describe('RateLimiter configuration', () => {
  it('should accept config object', () => {
    const limiter = new RateLimiter({
      backend: 'memory',
      algorithm: 'fixed-window',
      defaultRequestsPerMinute: 200,
      burstAllowance: 10,
    });

    const config = limiter.getConfig();
    expect(config.defaultRequestsPerMinute).toBe(200);
    expect(config.burstAllowance).toBe(10);
    expect(config.backend).toBe('memory');
    expect(config.algorithm).toBe('fixed-window');
  });

  it('should include burst allowance in effective limit', async () => {
    const limiter = new RateLimiter({
      defaultRequestsPerMinute: 5,
      burstAllowance: 3,
    });

    // Should allow 5 + 3 = 8 requests
    for (let i = 0; i < 8; i++) {
      const result = await limiter.consume('key');
      expect(result.allowed).toBe(true);
    }

    const result = await limiter.consume('key');
    expect(result.allowed).toBe(false);
  });

  it('should support sliding-window algorithm setting', () => {
    const limiter = new RateLimiter({
      algorithm: 'sliding-window',
      defaultRequestsPerMinute: 100,
    });

    const config = limiter.getConfig();
    expect(config.algorithm).toBe('sliding-window');
  });

  it('should clear rule limiters', async () => {
    const limiter = new RateLimiter(100);
    limiter.registerRule('rule1', { requestsPerMinute: 5 });

    const stats1 = limiter.getStats();
    expect(stats1.registeredRules).toBe(1);

    limiter.clear();

    const stats2 = limiter.getStats();
    expect(stats2.registeredRules).toBe(0);
  });
});
