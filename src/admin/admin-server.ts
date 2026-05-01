/**
 * Admin HTTP server for health checks and metrics.
 *
 * Provides endpoints for monitoring proxy health and collecting metrics.
 *
 * @module admin/admin-server
 */

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '../logging/logger.js';
import type { MetricsCollector, ProxyMetrics } from './metrics.js';
import type { PrometheusMetrics } from './prometheus-metrics.js';
import type { AdminAuthConfig } from '../types/config.js';
import type { AuditLogger, AuditLogEntry } from '../logging/audit-logger.js';
import { AdminAuth, DEFAULT_ADMIN_AUTH_CONFIG } from './auth.js';

/**
 * Configuration for the admin server.
 */
export interface AdminServerConfig {
  /** Admin server host */
  host: string;
  /** Admin server port */
  port: number;
  /** Logger instance */
  logger: Logger;
  /** Metrics collector */
  metrics: MetricsCollector;
  /** Prometheus metrics collector (optional) */
  prometheusMetrics?: PrometheusMetrics;
  /** Function to get current rules count */
  getRulesCount: () => number;
  /** Function to check if proxy is ready */
  isReady: () => boolean;
  /** Authentication configuration */
  auth?: AdminAuthConfig;
  /** Audit logger to expose via the /api/audit/stream SSE endpoint */
  auditLogger?: AuditLogger;
  /** Most-recent audit entries to replay on stream connect (?since=…) */
  auditHistorySize?: number;
}

/**
 * Health check response.
 */
export interface HealthResponse {
  status: 'ok' | 'degraded' | 'unhealthy';
  uptime: number;
  timestamp: string;
}

/**
 * Admin HTTP server for health checks and metrics.
 *
 * Endpoints:
 * - `GET /health` - Basic health check
 * - `GET /ready` - Readiness probe (for k8s)
 * - `GET /metrics` - JSON metrics
 *
 * @example
 * ```typescript
 * const admin = new AdminServer({
 *   host: '127.0.0.1',
 *   port: 9090,
 *   logger,
 *   metrics,
 *   getRulesCount: () => config.allowlist.rules.length,
 *   isReady: () => proxyServer.isRunning()
 * });
 *
 * await admin.start();
 * ```
 */
export class AdminServer {
  private readonly config: AdminServerConfig;
  private readonly auth: AdminAuth;
  private server?: http.Server;
  private startTime: number = Date.now();
  /** Ring buffer of recent audit entries for stream replay. */
  private readonly auditHistory: AuditLogEntry[] = [];
  private readonly auditHistoryLimit: number;
  private auditUnsubscribe: (() => void) | undefined;

  /**
   * Creates a new AdminServer.
   *
   * @param config - Admin server configuration
   */
  constructor(config: AdminServerConfig) {
    this.config = config;
    this.auth = new AdminAuth(config.auth ?? DEFAULT_ADMIN_AUTH_CONFIG, config.logger);
    this.auditHistoryLimit = Math.max(0, config.auditHistorySize ?? 1000);
    if (config.auditLogger && this.auditHistoryLimit > 0) {
      this.auditUnsubscribe = config.auditLogger.subscribe((entry) => {
        this.auditHistory.push(entry);
        if (this.auditHistory.length > this.auditHistoryLimit) {
          this.auditHistory.shift();
        }
      });
    }
  }

  /**
   * Start the admin server.
   *
   * @returns Promise that resolves when server is listening
   */
  async start(): Promise<void> {
    this.startTime = Date.now();

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        this.config.logger.error({ error }, 'Unhandled error in request handler');
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
    });

    this.server.on('error', (error) => {
      this.config.logger.error({ error }, 'Admin server error');
    });

    return new Promise((resolve) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        this.config.logger.info(
          { host: this.config.host, port: this.config.port },
          'Admin server started',
        );
        resolve();
      });
    });
  }

  /**
   * Stop the admin server.
   *
   * @returns Promise that resolves when server is stopped
   */
  async stop(): Promise<void> {
    if (this.auditUnsubscribe) {
      this.auditUnsubscribe();
      this.auditUnsubscribe = undefined;
    }
    if (!this.server) return;

    return new Promise((resolve, reject) => {
      this.server!.close((err) => {
        if (err) {
          this.config.logger.error({ error: err }, 'Error stopping admin server');
          reject(err);
        } else {
          this.config.logger.info('Admin server stopped');
          resolve();
        }
      });
    });
  }

  /**
   * Handle incoming HTTP request.
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    // Set common headers
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    try {
      // Authenticate request (skips unauthenticated endpoints like /health, /ready)
      const authResult = await this.auth.authenticate(req);

      if (!authResult.authenticated) {
        if (authResult.reason === 'Rate limit exceeded') {
          this.auth.sendRateLimited(res);
        } else if (authResult.reason === 'IP not allowed') {
          this.auth.sendForbidden(res, authResult.reason);
        } else {
          this.auth.sendUnauthorized(res, authResult.reason ?? 'Unauthorized');
        }
        return;
      }

      switch (url.pathname) {
        case '/health':
          this.handleHealth(req, res);
          break;
        case '/ready':
          this.handleReady(req, res);
          break;
        case '/metrics':
          this.handleMetrics(req, res);
          break;
        case '/metrics/prometheus':
          await this.handlePrometheusMetrics(req, res);
          break;
        case '/api/audit/stream':
          this.handleAuditStream(req, res, url);
          break;
        default:
          this.handleNotFound(req, res);
      }
    } catch (error) {
      this.config.logger.error({ error, path: url.pathname }, 'Admin request error');
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  /**
   * Handle GET /health - Basic health check.
   */
  private handleHealth(_req: IncomingMessage, res: ServerResponse): void {
    const response: HealthResponse = {
      status: 'ok',
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      timestamp: new Date().toISOString(),
    };

    res.writeHead(200);
    res.end(JSON.stringify(response, null, 2));
  }

  /**
   * Handle GET /ready - Readiness probe.
   */
  private handleReady(_req: IncomingMessage, res: ServerResponse): void {
    const isReady = this.config.isReady();

    if (isReady) {
      res.writeHead(200);
      res.end(JSON.stringify({ ready: true }));
    } else {
      res.writeHead(503);
      res.end(JSON.stringify({ ready: false, reason: 'Proxy not ready' }));
    }
  }

  /**
   * Handle GET /metrics - JSON metrics endpoint.
   */
  private handleMetrics(_req: IncomingMessage, res: ServerResponse): void {
    const metrics: ProxyMetrics = this.config.metrics.getMetrics(this.config.getRulesCount());

    res.writeHead(200);
    res.end(JSON.stringify(metrics, null, 2));
  }

  /**
   * Handle GET /metrics/prometheus - Prometheus format metrics endpoint.
   */
  private async handlePrometheusMetrics(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.config.prometheusMetrics) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Prometheus metrics not configured' }));
      return;
    }

    try {
      // Update gauge metrics before exporting
      this.config.prometheusMetrics.setRulesCount(this.config.getRulesCount());

      const metricsText = await this.config.prometheusMetrics.getMetrics();
      res.setHeader('Content-Type', this.config.prometheusMetrics.getContentType());
      res.writeHead(200);
      res.end(metricsText);
    } catch (error) {
      this.config.logger.error({ error }, 'Error generating Prometheus metrics');
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to generate metrics' }));
    }
  }

  /**
   * Handle GET /api/audit/stream — Server-Sent Events stream of audit entries.
   *
   * Query params:
   *   ?since=Nm — replay the last N minutes from the in-memory ring buffer.
   *   ?include=blocks-only — only forward denied/rate-limited entries.
   */
  private handleAuditStream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (!this.config.auditLogger) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'audit stream not configured' }));
      return;
    }

    const blocksOnly = url.searchParams.get('include') === 'blocks-only';
    const sinceParam = url.searchParams.get('since');
    let sinceMs: number | undefined;
    if (sinceParam !== null) {
      sinceMs = parseDurationMs(sinceParam);
      if (sinceMs === undefined) {
        res.writeHead(400);
        res.end(
          JSON.stringify({
            error: 'invalid `since` duration',
            hint: 'use a value like 30s, 5m, 2h',
          }),
        );
        return;
      }
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    // Backpressure handling. A slow client that doesn't drain the socket
    // would otherwise let Node's internal write buffer grow without bound
    // (one entry per audit event, each up to maxBodyLogSize bytes). When
    // the high-water mark is crossed we set a flag to drop new events
    // until 'drain' fires; if the backlog persists past a threshold we
    // close the stream so the client can reconnect cleanly.
    let paused = false;
    let droppedWhilePaused = 0;
    const MAX_DROPS_BEFORE_CLOSE = 1000;
    res.on('drain', () => {
      paused = false;
      if (droppedWhilePaused > 0) {
        // Surface a marker event so the consumer knows it missed entries.
        res.write(`event: dropped\ndata: ${droppedWhilePaused}\n\n`);
        droppedWhilePaused = 0;
      }
    });

    const send = (entry: AuditLogEntry): void => {
      if (blocksOnly && entry.decision === 'allowed') return;
      if (paused) {
        droppedWhilePaused++;
        if (droppedWhilePaused >= MAX_DROPS_BEFORE_CLOSE) {
          close();
        }
        return;
      }
      const ok = res.write(`data: ${JSON.stringify(entry)}\n\n`);
      if (!ok) paused = true;
    };

    if (sinceMs !== undefined) {
      const cutoff = Date.now() - sinceMs;
      for (const entry of this.auditHistory) {
        if (Date.parse(entry.timestamp) >= cutoff) send(entry);
      }
    }

    const unsubscribe = this.config.auditLogger.subscribe(send);

    const keepalive = setInterval(() => {
      if (!paused) res.write(': keepalive\n\n');
    }, 15_000);

    const close = (): void => {
      clearInterval(keepalive);
      unsubscribe();
      res.end();
    };

    req.on('close', close);
    req.on('aborted', close);
  }

  /**
   * Handle 404 Not Found.
   */
  private handleNotFound(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(404);
    res.end(
      JSON.stringify({
        error: 'Not found',
        endpoints: ['/health', '/ready', '/metrics', '/metrics/prometheus', '/api/audit/stream'],
      }),
    );
  }

  /**
   * Get the server address.
   */
  getAddress(): { host: string; port: number } | null {
    if (!this.server) return null;
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') return null;
    return { host: this.config.host, port: addr.port };
  }
}

/**
 * Parse a duration string like "5m", "30s", "2h" into milliseconds. Returns
 * undefined for unparseable input — callers should treat that as "no replay".
 */
function parseDurationMs(input: string): number | undefined {
  const match = /^(\d+)\s*(ms|s|m|h)?$/i.exec(input.trim());
  if (!match) return undefined;
  const n = parseInt(match[1]!, 10);
  if (!Number.isFinite(n)) return undefined;
  switch ((match[2] ?? 's').toLowerCase()) {
    case 'ms':
      return n;
    case 's':
      return n * 1000;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 3_600_000;
    default:
      return undefined;
  }
}

/**
 * Create an admin server.
 *
 * @param config - Admin server configuration
 * @returns New AdminServer instance
 */
export function createAdminServer(config: AdminServerConfig): AdminServer {
  return new AdminServer(config);
}
