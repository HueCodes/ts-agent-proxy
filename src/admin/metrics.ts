/**
 * Metrics collection for the proxy server.
 *
 * Tracks request counts, latency, and other operational metrics.
 *
 * @module admin/metrics
 */

import type { PoolStats } from '../proxy/connection-pool.js';
import type { LruCacheStats } from '../utils/lru-cache.js';

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
 * Connection pool metrics.
 */
export interface ConnectionPoolMetrics {
  /** HTTP socket statistics */
  http: {
    active: number;
    pending: number;
    created: number;
    reused: number;
    reuseRate: number;
  };
  /** HTTPS socket statistics */
  https: {
    active: number;
    pending: number;
    created: number;
    reused: number;
    reuseRate: number;
  };
}

/**
 * Cache metrics.
 */
export interface CacheMetrics {
  /** Certificate cache stats */
  certificates: LruCacheStats;
  /** Domain trie stats */
  domainTrie: {
    ruleCount: number;
    exactDomains: number;
    nodeCount: number;
    maxDepth: number;
  };
}

/**
 * Rate limiter metrics.
 */
export interface RateLimiterMetrics {
  /** Total requests checked */
  totalRequests: number;
  /** Requests allowed through */
  totalAllowed: number;
  /** Requests rejected (rate limited) */
  totalRejected: number;
  /** Rejection rate (0-1) */
  rejectionRate: number;
  /** Number of registered rule-specific limiters */
  registeredRules: number;
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
  /** Connection pool statistics */
  connectionPool?: ConnectionPoolMetrics;
  /** Cache statistics */
  cache?: CacheMetrics;
  /** Rate limiter statistics */
  rateLimiter?: RateLimiterMetrics;
  /** Timestamp when metrics were collected */
  timestamp: string;
}

/**
 * Metrics source providers for external components.
 */
export interface MetricsSources {
  /** Connection pool stats provider */
  connectionPool?: () => PoolStats;
  /** Certificate cache stats provider */
  certificateCache?: () => LruCacheStats;
  /** Domain trie stats provider */
  domainTrie?: () => { ruleCount: number; exactDomains: number; nodeCount: number; maxDepth: number };
  /** Rate limiter stats provider */
  rateLimiter?: () => { totalRequests: number; totalAllowed: number; totalRejected: number; rejectionRate: number; registeredRules: number };
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
 * // Register external metrics sources
 * metrics.registerSources({
 *   connectionPool: () => pool.getStats(),
 *   certificateCache: () => certManager.getCacheStats(),
 * });
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
  private sources: MetricsSources = {};

  constructor() {
    this.startTime = Date.now();
  }

  /**
   * Register external metrics sources.
   *
   * @param sources - Object containing stat provider functions
   */
  registerSources(sources: MetricsSources): void {
    this.sources = { ...this.sources, ...sources };
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

    const result: ProxyMetrics = {
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

    // Collect connection pool metrics
    if (this.sources.connectionPool) {
      const poolStats = this.sources.connectionPool();
      result.connectionPool = {
        http: {
          active: poolStats.http.activeSockets,
          pending: poolStats.http.pendingRequests,
          created: poolStats.http.socketsCreated,
          reused: poolStats.http.socketsReused,
          reuseRate: poolStats.http.reuseRate,
        },
        https: {
          active: poolStats.https.activeSockets,
          pending: poolStats.https.pendingRequests,
          created: poolStats.https.socketsCreated,
          reused: poolStats.https.socketsReused,
          reuseRate: poolStats.https.reuseRate,
        },
      };
    }

    // Collect cache metrics
    if (this.sources.certificateCache || this.sources.domainTrie) {
      result.cache = {
        certificates: this.sources.certificateCache?.() ?? {
          size: 0,
          maxSize: 0,
          hits: 0,
          misses: 0,
          hitRate: 0,
          evictions: 0,
          expirations: 0,
        },
        domainTrie: this.sources.domainTrie?.() ?? {
          ruleCount: 0,
          exactDomains: 0,
          nodeCount: 0,
          maxDepth: 0,
        },
      };
    }

    // Collect rate limiter metrics
    if (this.sources.rateLimiter) {
      result.rateLimiter = this.sources.rateLimiter();
    }

    return result;
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
