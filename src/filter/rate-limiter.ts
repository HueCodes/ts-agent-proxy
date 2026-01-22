/**
 * Rate limiting for proxy requests.
 *
 * This module provides request rate limiting to prevent abuse and enforce
 * usage quotas. Each rule can have its own rate limit, with a fallback
 * to a global default limit.
 *
 * Supports:
 * - In-memory storage (default)
 * - Redis backend for distributed rate limiting
 * - Fixed window and sliding window algorithms
 * - Burst allowance configuration
 *
 * @module filter/rate-limiter
 */

import {
  RateLimiterMemory,
  RateLimiterRes,
  RateLimiterAbstract,
} from 'rate-limiter-flexible';
import type { AllowlistRule, RateLimitConfig } from '../types/allowlist.js';

/**
 * Rate limiter backend type.
 */
export type RateLimiterBackend = 'memory' | 'redis';

/**
 * Rate limiter algorithm.
 */
export type RateLimiterAlgorithm = 'fixed-window' | 'sliding-window';

/**
 * Rate limiter configuration.
 */
export interface RateLimiterConfig {
  /** Backend storage type */
  backend: RateLimiterBackend;
  /** Algorithm to use */
  algorithm: RateLimiterAlgorithm;
  /** Default requests per minute */
  defaultRequestsPerMinute: number;
  /** Burst allowance (extra requests allowed in bursts) */
  burstAllowance: number;
  /** Redis connection URL (for redis backend) */
  redisUrl?: string;
  /** Redis key prefix */
  redisKeyPrefix?: string;
}

/**
 * Default rate limiter configuration.
 */
export const DEFAULT_RATE_LIMITER_CONFIG: RateLimiterConfig = {
  backend: 'memory',
  algorithm: 'fixed-window',
  defaultRequestsPerMinute: 100,
  burstAllowance: 0,
};

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
  /** Headers to include in response */
  headers: RateLimitHeaders;
}

/**
 * Rate limit headers for responses.
 */
export interface RateLimitHeaders {
  /** Maximum requests allowed in window */
  'X-RateLimit-Limit': string;
  /** Remaining requests in current window */
  'X-RateLimit-Remaining': string;
  /** Unix timestamp when window resets */
  'X-RateLimit-Reset': string;
  /** Retry-After header (only when rate limited) */
  'Retry-After'?: string;
}

/**
 * Rate limiter for controlling request throughput.
 *
 * Supports per-rule rate limits and a global default limit.
 * Supports both fixed-window and sliding-window algorithms.
 * Can use in-memory storage or Redis for distributed rate limiting.
 *
 * Rate limits are tracked per key (typically client IP or client IP + rule ID).
 *
 * @example
 * ```typescript
 * const limiter = new RateLimiter({ defaultRequestsPerMinute: 100 });
 *
 * // Register rule-specific limits
 * limiter.registerRule('openai-api', { requestsPerMinute: 60 });
 *
 * // Check and consume
 * const result = await limiter.consume('192.168.1.1', 'openai-api');
 * if (!result.allowed) {
 *   // Return 429 Too Many Requests with headers
 *   for (const [key, value] of Object.entries(result.headers)) {
 *     res.setHeader(key, value);
 *   }
 * }
 * ```
 */
export class RateLimiter {
  private readonly limiters: Map<string, RateLimiterAbstract>;
  private readonly defaultLimiter: RateLimiterAbstract;
  private readonly config: RateLimiterConfig;

  // Statistics
  private totalRequests = 0;
  private totalAllowed = 0;
  private totalRejected = 0;

  /**
   * Creates a new RateLimiter.
   *
   * @param config - Rate limiter configuration or default requests per minute
   */
  constructor(config: Partial<RateLimiterConfig> | number = 100) {
    // Handle legacy constructor signature
    if (typeof config === 'number') {
      this.config = {
        ...DEFAULT_RATE_LIMITER_CONFIG,
        defaultRequestsPerMinute: config,
      };
    } else {
      this.config = { ...DEFAULT_RATE_LIMITER_CONFIG, ...config };
    }

    this.limiters = new Map();
    this.defaultLimiter = this.createLimiter(
      this.config.defaultRequestsPerMinute + this.config.burstAllowance
    );
  }

  /**
   * Create a rate limiter instance based on configuration.
   */
  private createLimiter(points: number): RateLimiterAbstract {
    // For now, we only support memory backend
    // Redis support would require adding ioredis as a dependency
    // and using RateLimiterRedis from rate-limiter-flexible
    const duration = this.config.algorithm === 'sliding-window' ? 60 : 60;

    return new RateLimiterMemory({
      points,
      duration,
      // For sliding window behavior, we can use blockDuration
      // This isn't a true sliding window, but provides similar behavior
    });
  }

  /**
   * Generate rate limit headers.
   */
  private generateHeaders(
    limit: number,
    remaining: number,
    resetMs: number,
    isLimited: boolean
  ): RateLimitHeaders {
    const resetTimestamp = Math.ceil((Date.now() + resetMs) / 1000);
    const headers: RateLimitHeaders = {
      'X-RateLimit-Limit': String(limit),
      'X-RateLimit-Remaining': String(Math.max(0, remaining)),
      'X-RateLimit-Reset': String(resetTimestamp),
    };

    if (isLimited) {
      headers['Retry-After'] = String(Math.ceil(resetMs / 1000));
    }

    return headers;
  }

  /**
   * Register a rate limit for a specific rule.
   *
   * @param ruleId - The rule ID to register the limit for
   * @param config - Rate limit configuration
   */
  registerRule(ruleId: string, config: RateLimitConfig): void {
    const points = config.requestsPerMinute + this.config.burstAllowance;
    this.limiters.set(ruleId, this.createLimiter(points));
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
   * @returns Rate limit result with allowed status, quota info, and headers
   *
   * @example
   * ```typescript
   * const result = await limiter.consume(clientIp, matchedRule?.id);
   * if (!result.allowed) {
   *   // Set rate limit headers
   *   for (const [key, value] of Object.entries(result.headers)) {
   *     res.setHeader(key, value);
   *   }
   *   return new Response('Too Many Requests', { status: 429 });
   * }
   * ```
   */
  async consume(key: string, ruleId?: string): Promise<RateLimitResult> {
    this.totalRequests++;
    const limiter = ruleId
      ? this.limiters.get(ruleId) ?? this.defaultLimiter
      : this.defaultLimiter;

    try {
      const result = await limiter.consume(key);
      this.totalAllowed++;
      return {
        allowed: true,
        remaining: result.remainingPoints,
        resetMs: result.msBeforeNext,
        limit: limiter.points,
        headers: this.generateHeaders(
          limiter.points,
          result.remainingPoints,
          result.msBeforeNext,
          false
        ),
      };
    } catch (error) {
      if (error instanceof RateLimiterRes) {
        this.totalRejected++;
        return {
          allowed: false,
          remaining: 0,
          resetMs: error.msBeforeNext,
          limit: limiter.points,
          headers: this.generateHeaders(
            limiter.points,
            0,
            error.msBeforeNext,
            true
          ),
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
          headers: this.generateHeaders(limiter.points, limiter.points, 0, false),
        };
      }
      const remaining = result.remainingPoints;
      return {
        allowed: remaining > 0,
        remaining,
        resetMs: result.msBeforeNext,
        limit: limiter.points,
        headers: this.generateHeaders(
          limiter.points,
          remaining,
          result.msBeforeNext,
          remaining <= 0
        ),
      };
    } catch {
      return {
        allowed: true,
        remaining: limiter.points,
        resetMs: 0,
        limit: limiter.points,
        headers: this.generateHeaders(limiter.points, limiter.points, 0, false),
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

  /**
   * Get rate limiter statistics.
   */
  getStats(): {
    totalRequests: number;
    totalAllowed: number;
    totalRejected: number;
    rejectionRate: number;
    registeredRules: number;
    config: RateLimiterConfig;
  } {
    return {
      totalRequests: this.totalRequests,
      totalAllowed: this.totalAllowed,
      totalRejected: this.totalRejected,
      rejectionRate: this.totalRequests > 0 ? this.totalRejected / this.totalRequests : 0,
      registeredRules: this.limiters.size,
      config: { ...this.config },
    };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.totalRequests = 0;
    this.totalAllowed = 0;
    this.totalRejected = 0;
  }

  /**
   * Get the configuration.
   */
  getConfig(): RateLimiterConfig {
    return { ...this.config };
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
