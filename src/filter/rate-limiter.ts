/**
 * Rate limiting for proxy requests.
 */

import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import type { AllowlistRule, RateLimitConfig } from '../types/allowlist.js';

export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Remaining requests in the current window */
  remaining: number;
  /** Milliseconds until the rate limit resets */
  resetMs: number;
  /** The rate limit that was applied */
  limit: number;
}

export class RateLimiter {
  private readonly limiters: Map<string, RateLimiterMemory>;
  private readonly defaultLimiter: RateLimiterMemory;

  constructor(defaultRequestsPerMinute: number = 100) {
    this.limiters = new Map();
    this.defaultLimiter = new RateLimiterMemory({
      points: defaultRequestsPerMinute,
      duration: 60,
    });
  }

  /**
   * Register a rate limit for a specific rule.
   */
  registerRule(ruleId: string, config: RateLimitConfig): void {
    this.limiters.set(
      ruleId,
      new RateLimiterMemory({
        points: config.requestsPerMinute,
        duration: 60,
      })
    );
  }

  /**
   * Register rate limits from allowlist rules.
   */
  registerRules(rules: AllowlistRule[]): void {
    for (const rule of rules) {
      if (rule.rateLimit) {
        this.registerRule(rule.id, rule.rateLimit);
      }
    }
  }

  /**
   * Check and consume a rate limit point.
   *
   * @param key - The rate limit key (typically client IP or rule ID + client IP)
   * @param ruleId - Optional rule ID to use rule-specific limits
   */
  async consume(key: string, ruleId?: string): Promise<RateLimitResult> {
    const limiter = ruleId
      ? this.limiters.get(ruleId) ?? this.defaultLimiter
      : this.defaultLimiter;

    try {
      const result = await limiter.consume(key);
      return {
        allowed: true,
        remaining: result.remainingPoints,
        resetMs: result.msBeforeNext,
        limit: limiter.points,
      };
    } catch (error) {
      if (error instanceof RateLimiterRes) {
        return {
          allowed: false,
          remaining: 0,
          resetMs: error.msBeforeNext,
          limit: limiter.points,
        };
      }
      throw error;
    }
  }

  /**
   * Get current rate limit status without consuming a point.
   */
  async getStatus(key: string, ruleId?: string): Promise<RateLimitResult> {
    const limiter = ruleId
      ? this.limiters.get(ruleId) ?? this.defaultLimiter
      : this.defaultLimiter;

    try {
      const result = await limiter.get(key);
      if (!result) {
        return {
          allowed: true,
          remaining: limiter.points,
          resetMs: 0,
          limit: limiter.points,
        };
      }
      return {
        allowed: result.remainingPoints > 0,
        remaining: result.remainingPoints,
        resetMs: result.msBeforeNext,
        limit: limiter.points,
      };
    } catch {
      return {
        allowed: true,
        remaining: limiter.points,
        resetMs: 0,
        limit: limiter.points,
      };
    }
  }

  /**
   * Reset rate limit for a specific key.
   */
  async reset(key: string, ruleId?: string): Promise<void> {
    const limiter = ruleId
      ? this.limiters.get(ruleId) ?? this.defaultLimiter
      : this.defaultLimiter;

    await limiter.delete(key);
  }

  /**
   * Clear all limiters.
   */
  clear(): void {
    this.limiters.clear();
  }
}

/**
 * Create a rate limiter with rules pre-registered.
 */
export function createRateLimiter(
  rules: AllowlistRule[],
  defaultRequestsPerMinute: number = 100
): RateLimiter {
  const limiter = new RateLimiter(defaultRequestsPerMinute);
  limiter.registerRules(rules);
  return limiter;
}
