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

  /**
   * Creates a new AdminServer.
   *
   * @param config - Admin server configuration
   */
  constructor(config: AdminServerConfig) {
    this.config = config;
    this.auth = new AdminAuth(
      config.auth ?? DEFAULT_ADMIN_AUTH_CONFIG,
      config.logger
    );
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
          'Admin server started'
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
    const metrics: ProxyMetrics = this.config.metrics.getMetrics(
      this.config.getRulesCount()
    );

    res.writeHead(200);
    res.end(JSON.stringify(metrics, null, 2));
  }

  /**
   * Handle GET /metrics/prometheus - Prometheus format metrics endpoint.
   */
  private async handlePrometheusMetrics(
    _req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
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
   * Handle 404 Not Found.
   */
  private handleNotFound(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(404);
    res.end(JSON.stringify({
      error: 'Not found',
      endpoints: ['/health', '/ready', '/metrics', '/metrics/prometheus'],
    }));
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
 * Create an admin server.
 *
 * @param config - Admin server configuration
 * @returns New AdminServer instance
 */
export function createAdminServer(config: AdminServerConfig): AdminServer {
  return new AdminServer(config);
}
