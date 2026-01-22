/**
 * WebSocket proxy handler.
 *
 * Handles WebSocket upgrade requests and proxies WebSocket connections
 * with support for allowlist filtering and message inspection.
 *
 * @module proxy/websocket-handler
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { URL } from 'node:url';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Logger } from '../logging/logger.js';
import type { AuditLogger } from '../logging/audit-logger.js';
import type { AllowlistMatcher } from '../filter/allowlist-matcher.js';
import type { RateLimiter } from '../filter/rate-limiter.js';
import type { RequestInfo } from '../types/allowlist.js';

/**
 * WebSocket handler configuration.
 */
export interface WebSocketHandlerConfig {
  /** Allowlist matcher for filtering */
  allowlistMatcher: AllowlistMatcher;
  /** Rate limiter */
  rateLimiter: RateLimiter;
  /** Audit logger */
  auditLogger: AuditLogger;
  /** Logger instance */
  logger: Logger;
  /** Enable message inspection (default: false) */
  inspectMessages?: boolean;
  /** Connection timeout in ms (default: 30000) */
  connectionTimeout?: number;
  /** Idle timeout in ms (default: 300000) */
  idleTimeout?: number;
}

/**
 * WebSocket connection statistics.
 */
export interface WebSocketStats {
  /** Total WebSocket connections */
  totalConnections: number;
  /** Active WebSocket connections */
  activeConnections: number;
  /** Total messages forwarded */
  messagesForwarded: number;
  /** Total bytes transferred */
  bytesTransferred: number;
  /** Connections rejected by allowlist */
  connectionsRejected: number;
}

/**
 * WebSocket proxy handler.
 *
 * Proxies WebSocket connections through the proxy with allowlist filtering.
 * Supports both ws:// and wss:// protocols.
 *
 * @example
 * ```typescript
 * const wsHandler = new WebSocketHandler({
 *   allowlistMatcher,
 *   rateLimiter,
 *   auditLogger,
 *   logger,
 * });
 *
 * // Handle upgrade requests
 * server.on('upgrade', (req, socket, head) => {
 *   wsHandler.handleUpgrade(req, socket, head);
 * });
 * ```
 */
export class WebSocketHandler {
  private readonly config: Required<WebSocketHandlerConfig>;
  private readonly stats: WebSocketStats = {
    totalConnections: 0,
    activeConnections: 0,
    messagesForwarded: 0,
    bytesTransferred: 0,
    connectionsRejected: 0,
  };

  constructor(config: WebSocketHandlerConfig) {
    this.config = {
      ...config,
      inspectMessages: config.inspectMessages ?? false,
      connectionTimeout: config.connectionTimeout ?? 30000,
      idleTimeout: config.idleTimeout ?? 300000,
    };
  }

  /**
   * Handle a WebSocket upgrade request.
   */
  async handleUpgrade(
    req: IncomingMessage,
    socket: Socket | Duplex,
    head: Buffer
  ): Promise<void> {
    const startTime = Date.now();
    this.stats.totalConnections++;

    // Parse target URL
    const targetUrl = this.parseTargetUrl(req);
    if (!targetUrl) {
      this.rejectUpgrade(socket, 400, 'Bad Request: Invalid target URL');
      return;
    }

    const clientIp = this.getClientIp(req, socket);
    const requestInfo: RequestInfo = {
      host: targetUrl.hostname,
      port: parseInt(targetUrl.port) || (targetUrl.protocol === 'wss:' ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: 'GET',
      sourceIp: clientIp,
    };

    this.config.logger.debug(
      { host: requestInfo.host, path: requestInfo.path },
      'WebSocket upgrade request'
    );

    // Check allowlist
    const matchResult = this.config.allowlistMatcher.match(requestInfo);
    if (!matchResult.allowed) {
      this.stats.connectionsRejected++;
      this.config.auditLogger.logRequest(requestInfo, matchResult, {
        durationMs: Date.now() - startTime,
      });
      this.rejectUpgrade(socket, 403, 'Forbidden: WebSocket target not allowed');
      return;
    }

    // Check rate limit
    const rateLimitResult = await this.config.rateLimiter.consume(
      clientIp,
      matchResult.matchedRule?.id
    );
    if (!rateLimitResult.allowed) {
      this.stats.connectionsRejected++;
      this.config.auditLogger.logRateLimit(
        requestInfo,
        rateLimitResult,
        matchResult.matchedRule
      );
      this.rejectUpgrade(socket, 429, 'Too Many Requests');
      return;
    }

    // Connect to upstream
    try {
      await this.proxyWebSocket(req, socket, head, targetUrl, requestInfo, matchResult);
    } catch (error) {
      this.config.logger.error(
        { error, host: requestInfo.host },
        'WebSocket proxy error'
      );
      this.config.auditLogger.logError(requestInfo, error as Error);
      this.rejectUpgrade(socket, 502, 'Bad Gateway: Could not connect to upstream');
    }
  }

  /**
   * Proxy WebSocket connection to upstream.
   */
  private async proxyWebSocket(
    req: IncomingMessage,
    clientSocket: Socket | Duplex,
    head: Buffer,
    targetUrl: URL,
    requestInfo: RequestInfo,
    matchResult: any
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const isSecure = targetUrl.protocol === 'wss:' || targetUrl.protocol === 'https:';
      const port = parseInt(targetUrl.port) || (isSecure ? 443 : 80);

      // Build upgrade request headers
      const headers: string[] = [
        `GET ${targetUrl.pathname}${targetUrl.search} HTTP/1.1`,
        `Host: ${targetUrl.host}`,
      ];

      // Forward relevant headers
      const forwardHeaders = [
        'upgrade',
        'connection',
        'sec-websocket-key',
        'sec-websocket-version',
        'sec-websocket-extensions',
        'sec-websocket-protocol',
        'origin',
      ];

      for (const header of forwardHeaders) {
        const value = req.headers[header];
        if (value) {
          headers.push(`${header}: ${Array.isArray(value) ? value.join(', ') : value}`);
        }
      }

      headers.push('', '');
      const upgradeRequest = headers.join('\r\n');

      // Connect to upstream
      const connectOptions = {
        host: targetUrl.hostname,
        port,
        timeout: this.config.connectionTimeout,
      };

      let upstreamSocket: net.Socket;

      if (isSecure) {
        upstreamSocket = (require('tls') as typeof import('tls')).connect({
          ...connectOptions,
          servername: targetUrl.hostname,
        });
      } else {
        upstreamSocket = net.connect(connectOptions);
      }

      upstreamSocket.setTimeout(this.config.connectionTimeout);

      upstreamSocket.on('connect', () => {
        this.stats.activeConnections++;
        upstreamSocket.write(upgradeRequest);
        if (head.length > 0) {
          upstreamSocket.write(head);
        }
      });

      upstreamSocket.on('timeout', () => {
        this.config.logger.warn({ host: targetUrl.hostname }, 'WebSocket upstream timeout');
        upstreamSocket.destroy();
        reject(new Error('Upstream connection timeout'));
      });

      upstreamSocket.on('error', (error) => {
        this.config.logger.error(
          { error, host: targetUrl.hostname },
          'WebSocket upstream error'
        );
        reject(error);
      });

      // Wait for upgrade response
      let responseBuffer = Buffer.alloc(0);
      let headersParsed = false;

      upstreamSocket.on('data', (chunk) => {
        if (!headersParsed) {
          responseBuffer = Buffer.concat([responseBuffer, chunk]);
          const headerEnd = responseBuffer.indexOf('\r\n\r\n');

          if (headerEnd !== -1) {
            headersParsed = true;
            const responseHeaders = responseBuffer.slice(0, headerEnd + 4);
            const remainingData = responseBuffer.slice(headerEnd + 4);

            // Check if upgrade was successful
            const responseStr = responseHeaders.toString();
            if (!responseStr.includes('101')) {
              this.config.logger.warn(
                { host: targetUrl.hostname, response: responseStr.split('\r\n')[0] },
                'WebSocket upgrade failed'
              );
              clientSocket.write(responseHeaders);
              upstreamSocket.destroy();
              (clientSocket as Socket).destroy?.();
              reject(new Error('Upstream rejected WebSocket upgrade'));
              return;
            }

            // Send upgrade response to client
            clientSocket.write(responseHeaders);

            if (remainingData.length > 0) {
              clientSocket.write(remainingData);
              this.stats.bytesTransferred += remainingData.length;
            }

            // Set up bidirectional piping
            this.setupPipe(clientSocket, upstreamSocket, requestInfo, matchResult);
            resolve();
          }
        } else {
          // After headers, just pipe data
          clientSocket.write(chunk);
          this.stats.bytesTransferred += chunk.length;
          this.stats.messagesForwarded++;
        }
      });

      // Handle client socket events
      clientSocket.on('data', (chunk) => {
        if (headersParsed) {
          upstreamSocket.write(chunk);
          this.stats.bytesTransferred += chunk.length;
          this.stats.messagesForwarded++;
        }
      });

      clientSocket.on('error', (error) => {
        this.config.logger.debug({ error }, 'Client socket error');
        upstreamSocket.destroy();
      });

      clientSocket.on('close', () => {
        this.stats.activeConnections = Math.max(0, this.stats.activeConnections - 1);
        upstreamSocket.destroy();
        this.config.logger.debug(
          { host: targetUrl.hostname },
          'WebSocket connection closed'
        );
      });

      upstreamSocket.on('close', () => {
        (clientSocket as Socket).destroy?.();
      });
    });
  }

  /**
   * Set up bidirectional pipe between client and upstream.
   */
  private setupPipe(
    clientSocket: Socket | Duplex,
    upstreamSocket: net.Socket,
    requestInfo: RequestInfo,
    matchResult: any
  ): void {
    // Set idle timeout
    upstreamSocket.setTimeout(this.config.idleTimeout);
    if ('setTimeout' in clientSocket) {
      (clientSocket as Socket).setTimeout(this.config.idleTimeout);
    }

    upstreamSocket.on('timeout', () => {
      this.config.logger.debug({ host: requestInfo.host }, 'WebSocket idle timeout');
      upstreamSocket.destroy();
      (clientSocket as Socket).destroy?.();
    });

    // Log successful connection
    this.config.auditLogger.logRequest(requestInfo, matchResult, {
      durationMs: 0,
      response: { statusCode: 101, statusMessage: 'Switching Protocols' },
    });
  }

  /**
   * Parse target URL from request.
   */
  private parseTargetUrl(req: IncomingMessage): URL | null {
    try {
      // For CONNECT-style requests, the URL is in req.url
      // For regular proxy requests, we need to construct from headers
      const url = req.url ?? '/';
      const host = req.headers.host;

      if (!host) {
        return null;
      }

      // Determine protocol from upgrade header or default to ws
      const upgrade = req.headers.upgrade?.toLowerCase();
      const isWebSocket = upgrade === 'websocket';

      if (!isWebSocket) {
        return null;
      }

      // Check if it's a full URL or just a path
      if (url.startsWith('http://') || url.startsWith('https://') ||
          url.startsWith('ws://') || url.startsWith('wss://')) {
        return new URL(url);
      }

      // Construct URL from host header
      const protocol = (req.socket as any).encrypted ? 'wss:' : 'ws:';
      return new URL(`${protocol}//${host}${url}`);
    } catch {
      return null;
    }
  }

  /**
   * Get client IP from request.
   */
  private getClientIp(req: IncomingMessage, socket: Socket | Duplex): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      return ips.split(',')[0].trim();
    }
    return (socket as Socket).remoteAddress ?? 'unknown';
  }

  /**
   * Reject upgrade request.
   */
  private rejectUpgrade(
    socket: Socket | Duplex,
    statusCode: number,
    message: string
  ): void {
    const response = [
      `HTTP/1.1 ${statusCode} ${message}`,
      'Content-Type: text/plain',
      `Content-Length: ${Buffer.byteLength(message)}`,
      'Connection: close',
      '',
      message,
    ].join('\r\n');

    socket.write(response);
    (socket as Socket).destroy?.();
  }

  /**
   * Check if a request is a WebSocket upgrade request.
   */
  static isWebSocketUpgrade(req: IncomingMessage): boolean {
    const upgrade = req.headers.upgrade?.toLowerCase();
    const connection = req.headers.connection?.toLowerCase();
    return upgrade === 'websocket' && (connection?.includes('upgrade') ?? false);
  }

  /**
   * Get WebSocket statistics.
   */
  getStats(): WebSocketStats {
    return { ...this.stats };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats.totalConnections = 0;
    this.stats.activeConnections = 0;
    this.stats.messagesForwarded = 0;
    this.stats.bytesTransferred = 0;
    this.stats.connectionsRejected = 0;
  }
}

/**
 * Create a WebSocket handler.
 */
export function createWebSocketHandler(
  config: WebSocketHandlerConfig
): WebSocketHandler {
  return new WebSocketHandler(config);
}
