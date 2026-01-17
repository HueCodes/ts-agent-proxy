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
