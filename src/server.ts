/**
 * Main proxy server implementation.
 *
 * This module contains the ProxyServer class which orchestrates all proxy
 * components including filtering, rate limiting, and request handling.
 *
 * @module server
 */

import http from 'node:http';
import type { Duplex } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { ProxyConfig } from './types/config.js';
import type { AllowlistConfig } from './types/allowlist.js';
import { createLogger, type Logger } from './logging/logger.js';
import { createAuditLogger, type AuditLogger } from './logging/audit-logger.js';
import { createAllowlistMatcher, type AllowlistMatcher } from './filter/allowlist-matcher.js';
import { createRateLimiter, type RateLimiter } from './filter/rate-limiter.js';
import { createConnectHandler, type ConnectHandler } from './proxy/connect-handler.js';
import { createForwardProxy, type ForwardProxy } from './proxy/forward-proxy.js';
import { createCertManager, type CertManager } from './proxy/mitm/cert-manager.js';
import { createMitmInterceptor, type MitmInterceptor } from './proxy/mitm/interceptor.js';
import { createMetricsCollector, type MetricsCollector } from './admin/metrics.js';
import { createAdminServer, type AdminServer } from './admin/admin-server.js';

export interface ProxyServerOptions {
  config: ProxyConfig;
  logger?: Logger;
}

/**
 * Main proxy server class.
 *
 * Orchestrates all proxy components and manages the server lifecycle.
 *
 * @example
 * ```typescript
 * const server = new ProxyServer({ config, logger });
 * await server.start();
 *
 * // Later...
 * await server.stop();
 * ```
 */
export class ProxyServer {
  private readonly config: ProxyConfig;
  private readonly logger: Logger;
  private readonly auditLogger: AuditLogger;
  private readonly allowlistMatcher: AllowlistMatcher;
  private readonly rateLimiter: RateLimiter;
  private readonly connectHandler: ConnectHandler;
  private readonly forwardProxy: ForwardProxy;
  private readonly certManager?: CertManager;
  private readonly mitmInterceptor?: MitmInterceptor;
  private readonly metrics: MetricsCollector;
  private readonly adminServer?: AdminServer;
  private server?: http.Server;
  private isRunning = false;

  /**
   * Creates a new ProxyServer.
   *
   * @param options - Server configuration options
   */
  constructor(options: ProxyServerOptions) {
    this.config = options.config;
    this.logger = options.logger ?? createLogger({
      level: this.config.server.logging.level,
      pretty: this.config.server.logging.pretty,
    });

    this.auditLogger = createAuditLogger({
      filePath: this.config.server.logging.auditLogPath,
      logToMain: true,
      logger: this.logger,
    });

    this.allowlistMatcher = createAllowlistMatcher(this.config.allowlist);
    this.rateLimiter = createRateLimiter(this.config.allowlist.rules);

    const handlerOptions = {
      allowlistMatcher: this.allowlistMatcher,
      rateLimiter: this.rateLimiter,
      auditLogger: this.auditLogger,
      logger: this.logger,
    };

    this.connectHandler = createConnectHandler(handlerOptions);
    this.forwardProxy = createForwardProxy(handlerOptions);

    // Initialize MITM components if in MITM mode
    if (this.config.server.mode === 'mitm') {
      this.certManager = createCertManager({
        caCertPath: this.config.server.tls?.caCertPath,
        caKeyPath: this.config.server.tls?.caKeyPath,
        autoGenerate: this.config.server.tls?.autoGenerateCa ?? true,
      });

      this.mitmInterceptor = createMitmInterceptor({
        ...handlerOptions,
        certManager: this.certManager,
      });
    }

    // Initialize metrics collector
    this.metrics = createMetricsCollector();

    // Initialize admin server if enabled
    if (this.config.server.admin?.enabled) {
      this.adminServer = createAdminServer({
        host: this.config.server.admin.host,
        port: this.config.server.admin.port,
        logger: this.logger,
        metrics: this.metrics,
        getRulesCount: () => this.config.allowlist.rules.length,
        isReady: () => this.isRunning,
      });
    }
  }

  /**
   * Initialize the server.
   */
  async initialize(): Promise<void> {
    if (this.certManager) {
      await this.certManager.initialize();
      this.logger.info('MITM certificate manager initialized');
    }
  }

  /**
   * Start the proxy server.
   *
   * Initializes all components and starts listening for connections.
   * Also starts the admin server if enabled.
   *
   * @returns Promise that resolves when server is listening
   */
  async start(): Promise<void> {
    await this.initialize();

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    this.server.on('connect', (req, socket: Duplex, head) => {
      this.handleConnect(req, socket as Socket, head);
    });

    this.server.on('error', (error) => {
      this.logger.error({ error }, 'Server error');
    });

    // Start admin server if enabled
    if (this.adminServer) {
      await this.adminServer.start();
    }

    return new Promise((resolve) => {
      this.server!.listen(this.config.server.port, this.config.server.host, () => {
        this.isRunning = true;
        this.logger.info(
          { host: this.config.server.host, port: this.config.server.port, mode: this.config.server.mode },
          'Proxy server started'
        );
        resolve();
      });
    });
  }

  /**
   * Stop the proxy server.
   *
   * Stops both the main proxy server and the admin server if running.
   *
   * @returns Promise that resolves when server is stopped
   */
  async stop(): Promise<void> {
    this.isRunning = false;

    // Stop admin server first
    if (this.adminServer) {
      await this.adminServer.stop();
    }

    if (!this.server) return;

    return new Promise((resolve, reject) => {
      this.server!.close((err) => {
        if (err) {
          this.logger.error({ error: err }, 'Error stopping server');
          reject(err);
        } else {
          this.logger.info('Proxy server stopped');
          resolve();
        }
      });
    });
  }

  /**
   * Handle regular HTTP requests.
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    this.forwardProxy.handleRequest(req, res).catch((error) => {
      this.logger.error({ error }, 'Request handling error');
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal server error');
      }
    });
  }

  /**
   * Handle CONNECT requests (HTTPS tunneling or MITM).
   */
  private handleConnect(req: IncomingMessage, socket: Socket, head: Buffer): void {
    if (this.config.server.mode === 'mitm' && this.mitmInterceptor) {
      this.mitmInterceptor.handleConnect(req, socket, head).catch((error) => {
        this.logger.error({ error }, 'MITM handling error');
        socket.destroy();
      });
    } else {
      this.connectHandler.handleConnect(req, socket, head).catch((error) => {
        this.logger.error({ error }, 'Connect handling error');
        socket.destroy();
      });
    }
  }

  /**
   * Reload the allowlist configuration.
   */
  reloadAllowlist(config: AllowlistConfig): void {
    this.allowlistMatcher.reload(config);
    this.rateLimiter.clear();
    this.rateLimiter.registerRules(config.rules);
    this.logger.info('Allowlist configuration reloaded');
  }

  /**
   * Get the current allowlist configuration.
   */
  getAllowlistConfig(): AllowlistConfig {
    return this.allowlistMatcher.getConfig();
  }

  /**
   * Get the server address.
   */
  getAddress(): { host: string; port: number } | null {
    if (!this.server) return null;
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') return null;
    return { host: this.config.server.host, port: addr.port };
  }

  /**
   * Get CA certificate PEM (for MITM mode).
   *
   * @returns CA certificate PEM string, or null if not in MITM mode
   */
  getCaCertPem(): string | null {
    return this.certManager?.getCaCertPem() ?? null;
  }

  /**
   * Get current metrics.
   *
   * @returns Current proxy metrics
   */
  getMetrics() {
    return this.metrics.getMetrics(this.config.allowlist.rules.length);
  }

  /**
   * Get the metrics collector for recording custom metrics.
   *
   * @returns The metrics collector instance
   */
  getMetricsCollector(): MetricsCollector {
    return this.metrics;
  }
}

/**
 * Create a proxy server.
 *
 * Factory function for creating ProxyServer instances.
 *
 * @param options - Server configuration options
 * @returns New ProxyServer instance
 *
 * @example
 * ```typescript
 * const server = createProxyServer({
 *   config: loadProxyConfig(),
 *   logger: createLogger({ level: 'info' })
 * });
 * await server.start();
 * ```
 */
export function createProxyServer(options: ProxyServerOptions): ProxyServer {
  return new ProxyServer(options);
}
