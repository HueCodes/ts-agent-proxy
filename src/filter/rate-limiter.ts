/**
 * Rate limiting for proxy requests.
 *
 * This module provides request rate limiting to prevent abuse and enforce
 * usage quotas. Each rule can have its own rate limit, with a fallback
 * to a global default limit.
 *
 * @module filter/rate-limiter
 */

import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import type { AllowlistRule, RateLimitConfig } from '../types/allowlist.js';

/**
 * Result of a rate limit check.
 */
export interface RateLimitResult {
  /** Whether the request is allowed (not rate limited) */
  allowed: boolean;
  /** Remaining requests allowed in the current window */
  remaining: number;
  /** Milliseconds until the rate limit window resets */
  resetMs: number;
  /** The rate limit that was applied (requests per minute) */
  limit: number;
}

/**
 * Rate limiter for controlling request throughput.
 *
 * Supports per-rule rate limits and a global default limit.
 * Uses a fixed-window algorithm with 1-minute windows.
 *
 * Rate limits are tracked per key (typically client IP or client IP + rule ID).
 *
 * @example
 * ```typescript
 * const limiter = new RateLimiter(100); // 100 req/min default
 *
 * // Register rule-specific limits
 * limiter.registerRule('openai-api', { requestsPerMinute: 60 });
 *
 * // Check and consume
 * const result = await limiter.consume('192.168.1.1', 'openai-api');
 * if (!result.allowed) {
 *   // Return 429 Too Many Requests
 *   res.setHeader('Retry-After', Math.ceil(result.resetMs / 1000));
 * }
 * ```
 */
export class RateLimiter {
  private readonly limiters: Map<string, RateLimiterMemory>;
  private readonly defaultLimiter: RateLimiterMemory;

  /**
   * Creates a new RateLimiter.
   *
   * @param defaultRequestsPerMinute - Default rate limit when no rule-specific limit exists
   */
  constructor(defaultRequestsPerMinute: number = 100) {
    this.limiters = new Map();
    this.defaultLimiter = new RateLimiterMemory({
      points: defaultRequestsPerMinute,
      duration: 60,
    });
  }

  /**
   * Register a rate limit for a specific rule.
   *
   * @param ruleId - The rule ID to register the limit for
   * @param config - Rate limit configuration
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
   * Register rate limits from an array of allowlist rules.
   *
   * Extracts rate limit configurations from rules and registers them.
   * Rules without rate limit config are skipped.
   *
   * @param rules - Array of allowlist rules
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
   * This is the main method for rate limiting. It checks if the request
   * is within limits and consumes one point from the quota if allowed.
   *
   * @param key - The rate limit key (typically client IP)
   * @param ruleId - Optional rule ID to use rule-specific limits instead of default
   * @returns Rate limit result with allowed status and quota info
   *
   * @example
   * ```typescript
   * const result = await limiter.consume(clientIp, matchedRule?.id);
   * if (!result.allowed) {
   *   return new Response('Too Many Requests', {
   *     status: 429,
   *     headers: { 'Retry-After': String(Math.ceil(result.resetMs / 1000)) }
   *   });
   * }
   * ```
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
   *
   * Useful for displaying quota info or checking limits before expensive operations.
   *
   * @param key - The rate limit key
   * @param ruleId - Optional rule ID for rule-specific limits
   * @returns Current rate limit status
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
   *
   * Removes all rate limit tracking for the given key, allowing
   * the full quota again. Useful for testing or manual resets.
   *
   * @param key - The rate limit key to reset
   * @param ruleId - Optional rule ID for rule-specific limits
   */
  async reset(key: string, ruleId?: string): Promise<void> {
    const limiter = ruleId
      ? this.limiters.get(ruleId) ?? this.defaultLimiter
      : this.defaultLimiter;

    await limiter.delete(key);
  }

  /**
   * Clear all registered rule-specific limiters.
   *
   * The default limiter is preserved. Call this when reloading
   * configuration to remove stale rule limiters.
   */
  clear(): void {
    this.limiters.clear();
  }
}

/**
 * Create a rate limiter with rules pre-registered.
 *
 * Factory function that creates a RateLimiter and registers all
 * rate limits from the provided rules.
 *
 * @param rules - Array of allowlist rules (only those with rateLimit are registered)
 * @param defaultRequestsPerMinute - Default limit for rules without specific config
 * @returns Configured RateLimiter instance
 *
 * @example
 * ```typescript
 * const limiter = createRateLimiter(config.allowlist.rules, 100);
 * ```
 */
export function createRateLimiter(
  rules: AllowlistRule[],
  defaultRequestsPerMinute: number = 100
): RateLimiter {
  const limiter = new RateLimiter(defaultRequestsPerMinute);
  limiter.registerRules(rules);
  return limiter;
}
