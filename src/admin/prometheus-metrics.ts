/**
 * Prometheus metrics for the proxy server.
 *
 * Provides metrics in Prometheus text format for monitoring and alerting.
 *
 * @module admin/prometheus-metrics
 */

import {
  Registry,
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
  register as globalRegistry,
} from 'prom-client';

/**
 * Prometheus metrics configuration.
 */
export interface PrometheusMetricsConfig {
  /** Prefix for all metric names (default: 'proxy') */
  prefix: string;
  /** Enable default Node.js metrics (default: true) */
  enableDefaultMetrics: boolean;
  /** Default metrics collection interval in ms (default: 10000) */
  defaultMetricsInterval: number;
  /** Custom labels to add to all metrics */
  defaultLabels?: Record<string, string>;
  /** Histogram buckets for request duration */
  durationBuckets: number[];
  /** Histogram buckets for bytes transferred */
  bytesBuckets: number[];
}

/**
 * Default configuration.
 */
export const DEFAULT_PROMETHEUS_CONFIG: PrometheusMetricsConfig = {
  prefix: 'proxy',
  enableDefaultMetrics: true,
  defaultMetricsInterval: 10000,
  durationBuckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  bytesBuckets: [100, 1000, 10000, 100000, 1000000, 10000000, 100000000],
};

/**
 * Prometheus metrics collector.
 *
 * Provides standard proxy metrics in Prometheus format:
 * - Request counters by method, status, and rule
 * - Request duration histograms
 * - Active connection gauges
 * - Bytes transferred counters
 * - Rate limit hit counters
 * - Allowlist match counters
 *
 * @example
 * ```typescript
 * const promMetrics = new PrometheusMetrics({ prefix: 'my_proxy' });
 *
 * // Record a request
 * const stopTimer = promMetrics.startRequestTimer('GET', 'api.example.com');
 * // ... process request ...
 * stopTimer({ status: '200', rule: 'api-rule' });
 *
 * // Get metrics in Prometheus format
 * const metricsText = await promMetrics.getMetrics();
 * ```
 */
export class PrometheusMetrics {
  private readonly registry: Registry;
  private readonly config: PrometheusMetricsConfig;

  // Counters
  private readonly requestsTotal: Counter<'method' | 'status' | 'rule'>;
  private readonly bytesTransferred: Counter<'direction'>;
  private readonly rateLimitHits: Counter<'rule'>;
  private readonly allowlistMatches: Counter<'rule' | 'action'>;
  private readonly errorsTotal: Counter<'type'>;

  // Gauges
  private readonly activeConnections: Gauge<'type'>;
  private readonly rulesCount: Gauge<string>;
  private readonly connectionPoolSockets: Gauge<'protocol' | 'state'>;
  private readonly certCacheSize: Gauge<string>;

  // Histograms
  private readonly requestDuration: Histogram<'method' | 'target_domain'>;
  private readonly requestBytes: Histogram<'direction'>;

  constructor(config: Partial<PrometheusMetricsConfig> = {}) {
    this.config = { ...DEFAULT_PROMETHEUS_CONFIG, ...config };
    this.registry = new Registry();

    // Set default labels if provided
    if (this.config.defaultLabels) {
      this.registry.setDefaultLabels(this.config.defaultLabels);
    }

    // Enable default Node.js metrics
    if (this.config.enableDefaultMetrics) {
      collectDefaultMetrics({
        register: this.registry,
        prefix: `${this.config.prefix}_`,
        gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
      });
    }

    const prefix = this.config.prefix;

    // Initialize counters
    this.requestsTotal = new Counter({
      name: `${prefix}_requests_total`,
      help: 'Total number of proxy requests',
      labelNames: ['method', 'status', 'rule'],
      registers: [this.registry],
    });

    this.bytesTransferred = new Counter({
      name: `${prefix}_bytes_transferred_total`,
      help: 'Total bytes transferred through the proxy',
      labelNames: ['direction'],
      registers: [this.registry],
    });

    this.rateLimitHits = new Counter({
      name: `${prefix}_rate_limit_hits_total`,
      help: 'Total rate limit hits',
      labelNames: ['rule'],
      registers: [this.registry],
    });

    this.allowlistMatches = new Counter({
      name: `${prefix}_allowlist_matches_total`,
      help: 'Total allowlist rule matches',
      labelNames: ['rule', 'action'],
      registers: [this.registry],
    });

    this.errorsTotal = new Counter({
      name: `${prefix}_errors_total`,
      help: 'Total errors by type',
      labelNames: ['type'],
      registers: [this.registry],
    });

    // Initialize gauges
    this.activeConnections = new Gauge({
      name: `${prefix}_active_connections`,
      help: 'Current number of active connections',
      labelNames: ['type'],
      registers: [this.registry],
    });

    this.rulesCount = new Gauge({
      name: `${prefix}_rules_count`,
      help: 'Number of configured allowlist rules',
      registers: [this.registry],
    });

    this.connectionPoolSockets = new Gauge({
      name: `${prefix}_connection_pool_sockets`,
      help: 'Connection pool socket counts',
      labelNames: ['protocol', 'state'],
      registers: [this.registry],
    });

    this.certCacheSize = new Gauge({
      name: `${prefix}_cert_cache_size`,
      help: 'Number of cached certificates',
      registers: [this.registry],
    });

    // Initialize histograms
    this.requestDuration = new Histogram({
      name: `${prefix}_request_duration_seconds`,
      help: 'Request duration in seconds',
      labelNames: ['method', 'target_domain'],
      buckets: this.config.durationBuckets,
      registers: [this.registry],
    });

    this.requestBytes = new Histogram({
      name: `${prefix}_request_bytes`,
      help: 'Request/response size in bytes',
      labelNames: ['direction'],
      buckets: this.config.bytesBuckets,
      registers: [this.registry],
    });
  }

  /**
   * Record a completed request.
   */
  recordRequest(
    method: string,
    status: string,
    rule: string = 'unknown'
  ): void {
    this.requestsTotal.inc({ method, status, rule });
  }

  /**
   * Start timing a request. Returns a function to stop the timer.
   */
  startRequestTimer(
    method: string,
    targetDomain: string
  ): (labels?: { status?: string; rule?: string }) => number {
    const end = this.requestDuration.startTimer({ method, target_domain: targetDomain });
    return (labels) => {
      const duration = end();
      if (labels?.status && labels?.rule) {
        this.recordRequest(method, labels.status, labels.rule);
      }
      return duration;
    };
  }

  /**
   * Record bytes transferred.
   */
  recordBytes(direction: 'inbound' | 'outbound', bytes: number): void {
    this.bytesTransferred.inc({ direction }, bytes);
    this.requestBytes.observe({ direction }, bytes);
  }

  /**
   * Record a rate limit hit.
   */
  recordRateLimitHit(rule: string = 'default'): void {
    this.rateLimitHits.inc({ rule });
  }

  /**
   * Record an allowlist match.
   */
  recordAllowlistMatch(rule: string, action: 'allow' | 'deny'): void {
    this.allowlistMatches.inc({ rule, action });
  }

  /**
   * Record an error.
   */
  recordError(type: string): void {
    this.errorsTotal.inc({ type });
  }

  /**
   * Set active connection count.
   */
  setActiveConnections(type: 'http' | 'https' | 'tunnel', count: number): void {
    this.activeConnections.set({ type }, count);
  }

  /**
   * Increment active connections.
   */
  incActiveConnections(type: 'http' | 'https' | 'tunnel'): void {
    this.activeConnections.inc({ type });
  }

  /**
   * Decrement active connections.
   */
  decActiveConnections(type: 'http' | 'https' | 'tunnel'): void {
    this.activeConnections.dec({ type });
  }

  /**
   * Set rules count.
   */
  setRulesCount(count: number): void {
    this.rulesCount.set(count);
  }

  /**
   * Set connection pool metrics.
   */
  setConnectionPoolMetrics(
    protocol: 'http' | 'https',
    active: number,
    free: number,
    pending: number
  ): void {
    this.connectionPoolSockets.set({ protocol, state: 'active' }, active);
    this.connectionPoolSockets.set({ protocol, state: 'free' }, free);
    this.connectionPoolSockets.set({ protocol, state: 'pending' }, pending);
  }

  /**
   * Set certificate cache size.
   */
  setCertCacheSize(size: number): void {
    this.certCacheSize.set(size);
  }

  /**
   * Get metrics in Prometheus text format.
   */
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * Get the content type for Prometheus metrics.
   */
  getContentType(): string {
    return this.registry.contentType;
  }

  /**
   * Get the registry for advanced usage.
   */
  getRegistry(): Registry {
    return this.registry;
  }

  /**
   * Reset all metrics.
   */
  resetMetrics(): void {
    this.registry.resetMetrics();
  }

  /**
   * Clear the registry.
   */
  clear(): void {
    this.registry.clear();
  }
}

/**
 * Create a Prometheus metrics instance.
 */
export function createPrometheusMetrics(
  config?: Partial<PrometheusMetricsConfig>
): PrometheusMetrics {
  return new PrometheusMetrics(config);
}
