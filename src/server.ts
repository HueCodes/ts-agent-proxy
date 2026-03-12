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
import { generateRequestId, sendJsonError } from './proxy/size-limiter.js';
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
import { createWebSocketHandler, WebSocketHandler } from './proxy/websocket-handler.js';
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
  private readonly webSocketHandler: WebSocketHandler;
  private readonly metrics: MetricsCollector;
  private readonly adminServer?: AdminServer;
  private server?: http.Server;
  private isRunning = false;
  private isShuttingDown = false;
  private readonly activeConnections = new Set<Socket>();
  private readonly shutdownTimeout: number;

  /**
   * Creates a new ProxyServer.
   *
   * @param options - Server configuration options
   */
  constructor(options: ProxyServerOptions) {
    this.config = options.config;
    this.logger =
      options.logger ??
      createLogger({
        level: this.config.server.logging.level,
        pretty: this.config.server.logging.pretty,
      });

    this.auditLogger = createAuditLogger({
      filePath: this.config.server.logging.auditLogPath,
      logToMain: true,
      logger: this.logger,
    });

    this.shutdownTimeout = 30000; // 30 seconds default

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

    // Initialize WebSocket handler
    this.webSocketHandler = createWebSocketHandler(handlerOptions);

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

    // Track active connections for graceful shutdown
    this.server.on('connection', (socket: Socket) => {
      this.activeConnections.add(socket);
      socket.on('close', () => {
        this.activeConnections.delete(socket);
      });
    });

    this.server.on('connect', (req, socket: Duplex, head) => {
      this.handleConnect(req, socket as Socket, head);
    });

    this.server.on('upgrade', (req, socket: Duplex, head) => {
      this.handleUpgrade(req, socket as Socket, head);
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
          {
            host: this.config.server.host,
            port: this.config.server.port,
            mode: this.config.server.mode,
          },
          'Proxy server started',
        );
        resolve();
      });
    });
  }

  /**
   * Stop the proxy server gracefully.
   *
   * 1. Stops accepting new connections
   * 2. Sets health endpoint to return 503
   * 3. Waits for in-flight requests to complete (up to shutdownTimeout)
   * 4. Destroys remaining connections and cleans up
   *
   * @returns Promise that resolves when server is stopped
   */
  async stop(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    this.logger.info(
      { activeConnections: this.activeConnections.size },
      'Graceful shutdown initiated, stopping new connections',
    );

    // Mark as not ready so health probes return 503
    this.isRunning = false;

    // Destroy the forward proxy connection pool
    this.forwardProxy.destroy();
    this.logger.info('Connection pool destroyed');

    if (!this.server) {
      // Stop admin server if proxy server wasn't started
      if (this.adminServer) {
        await this.adminServer.stop();
      }
      return;
    }

    // Stop accepting new connections and wait for in-flight requests
    await new Promise<void>((resolve) => {
      const forceShutdownTimer = setTimeout(() => {
        this.logger.warn(
          { remainingConnections: this.activeConnections.size },
          'Shutdown timeout reached, forcing remaining connections closed',
        );
        for (const socket of this.activeConnections) {
          socket.destroy();
        }
        this.activeConnections.clear();
        resolve();
      }, this.shutdownTimeout);

      // Prevent the timer from keeping the process alive
      forceShutdownTimer.unref();

      this.server!.close((err) => {
        clearTimeout(forceShutdownTimer);
        if (err) {
          this.logger.error({ error: err }, 'Error during server close');
        }
        resolve();
      });

      // Close idle connections (those without active requests)
      for (const socket of this.activeConnections) {
        if (!socket.writableLength) {
          socket.end();
        }
      }
    });

    // Stop admin server after proxy is done
    if (this.adminServer) {
      await this.adminServer.stop();
      this.logger.info('Admin server stopped');
    }

    this.logger.info('Proxy server stopped');
  }

  /**
   * Handle regular HTTP requests.
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (this.isShuttingDown) {
      sendJsonError(
        res,
        503,
        'SERVICE_UNAVAILABLE',
        'Server is shutting down',
        generateRequestId(),
        {
          'Retry-After': '5',
        },
      );
      return;
    }

    this.forwardProxy.handleRequest(req, res).catch((error) => {
      this.logger.error({ error }, 'Request handling error');
      if (!res.headersSent) {
        sendJsonError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
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
   * Handle WebSocket upgrade requests.
   */
  private handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    if (!WebSocketHandler.isWebSocketUpgrade(req)) {
      // Not a WebSocket upgrade, reject
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    this.webSocketHandler.handleUpgrade(req, socket, head).catch((error) => {
      this.logger.error({ error }, 'WebSocket handling error');
      socket.destroy();
    });
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

  /**
   * Get WebSocket statistics.
   *
   * @returns WebSocket connection and transfer stats
   */
  getWebSocketStats() {
    return this.webSocketHandler.getStats();
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
