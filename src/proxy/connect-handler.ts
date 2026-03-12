/**
 * CONNECT tunnel handler for HTTPS proxying.
 *
 * In CONNECT mode, the proxy establishes a TCP tunnel without
 * inspecting the encrypted traffic. Filtering is done at the
 * domain level only.
 */

import net from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Logger } from '../logging/logger.js';
import type { AllowlistMatcher } from '../filter/allowlist-matcher.js';
import type { RateLimiter } from '../filter/rate-limiter.js';
import type { AuditLogger } from '../logging/audit-logger.js';
import type { RequestInfo } from '../types/allowlist.js';
import type { TimeoutsConfig } from '../types/config.js';
import { DEFAULT_TIMEOUTS } from '../types/config.js';
import { sendSocketError, TimeoutError } from './size-limiter.js';

export interface ConnectHandlerOptions {
  allowlistMatcher: AllowlistMatcher;
  rateLimiter: RateLimiter;
  auditLogger: AuditLogger;
  logger: Logger;
  timeouts?: TimeoutsConfig;
}

export interface ConnectResult {
  allowed: boolean;
  statusCode: number;
  reason: string;
}

export class ConnectHandler {
  private readonly options: ConnectHandlerOptions;
  private readonly timeouts: TimeoutsConfig;

  constructor(options: ConnectHandlerOptions) {
    this.options = options;
    this.timeouts = options.timeouts ?? DEFAULT_TIMEOUTS;
  }

  /**
   * Handle a CONNECT request.
   *
   * @param req - The HTTP request
   * @param clientSocket - The client socket
   * @param head - Any initial data after the headers
   */
  async handleConnect(req: IncomingMessage, clientSocket: Socket, head: Buffer): Promise<void> {
    const startTime = Date.now();
    const { host, port } = this.parseTarget(req.url ?? '');
    const sourceIp = this.getClientIp(req);

    const requestInfo: RequestInfo = {
      host,
      port,
      sourceIp,
    };

    this.options.logger.debug({ host, port, sourceIp }, 'CONNECT request received');

    // Check allowlist
    const matchResult = this.options.allowlistMatcher.isDomainAllowed(host);

    if (!matchResult.allowed) {
      this.options.auditLogger.logRequest(requestInfo, matchResult, Date.now() - startTime);
      this.sendForbidden(clientSocket, `Domain not allowed: ${host}`);
      return;
    }

    // Check rate limit
    const rateLimitKey = `${matchResult.matchedRule?.id ?? 'default'}:${sourceIp}`;
    const rateLimitResult = await this.options.rateLimiter.consume(
      rateLimitKey,
      matchResult.matchedRule?.id,
    );

    if (!rateLimitResult.allowed) {
      this.options.auditLogger.logRateLimit(requestInfo, rateLimitResult, matchResult.matchedRule);
      this.sendRateLimited(clientSocket, rateLimitResult.resetMs);
      return;
    }

    // Establish tunnel to target
    try {
      await this.createTunnel(clientSocket, head, host, port, requestInfo, startTime);
    } catch (error) {
      this.options.auditLogger.logError(requestInfo, error as Error);

      if (error instanceof TimeoutError) {
        sendSocketError(
          clientSocket,
          504,
          'Gateway Timeout',
          'Connection to upstream server timed out',
        );
      } else {
        this.sendError(clientSocket, 'Failed to establish connection');
      }
    }
  }

  /**
   * Parse the target host and port from the CONNECT request.
   */
  private parseTarget(url: string): { host: string; port: number } {
    const parts = url.split(':');
    const host = parts[0] ?? '';
    const portStr = parts[1];
    const port = portStr ? parseInt(portStr, 10) : 443;
    return { host, port };
  }

  /**
   * Get the client IP address from the request.
   */
  private getClientIp(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0]!.trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  /**
   * Create a TCP tunnel to the target server.
   */
  private async createTunnel(
    clientSocket: Socket,
    head: Buffer,
    host: string,
    port: number,
    requestInfo: RequestInfo,
    startTime: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let connectTimeoutId: NodeJS.Timeout | undefined;
      let idleTimeoutId: NodeJS.Timeout | undefined;
      let resolved = false;

      const cleanupAll = () => {
        if (connectTimeoutId) clearTimeout(connectTimeoutId);
        if (idleTimeoutId) clearTimeout(idleTimeoutId);
      };

      const safeReject = (error: Error) => {
        if (!resolved) {
          resolved = true;
          cleanupAll();
          reject(error);
        }
      };

      const safeResolve = () => {
        if (!resolved) {
          resolved = true;
          // Only clear connect timeout on resolve — idle timeout must persist
          if (connectTimeoutId) clearTimeout(connectTimeoutId);
          resolve();
        }
      };

      const resetIdleTimeout = () => {
        if (idleTimeoutId) clearTimeout(idleTimeoutId);
        idleTimeoutId = setTimeout(() => {
          this.options.logger.debug({ host, port }, 'Tunnel idle timeout');
          clientSocket.destroy();
          serverSocket.destroy();
        }, this.timeouts.idleTimeout);
      };

      // Set connect timeout
      connectTimeoutId = setTimeout(() => {
        this.options.logger.warn(
          { host, port, timeout: this.timeouts.connectTimeout },
          'Tunnel connect timeout',
        );
        safeReject(new TimeoutError('Connect timeout', this.timeouts.connectTimeout));
        clientSocket.destroy();
      }, this.timeouts.connectTimeout);

      const serverSocket = net.connect(port, host, () => {
        // Clear connect timeout
        if (connectTimeoutId) {
          clearTimeout(connectTimeoutId);
          connectTimeoutId = undefined;
        }

        this.options.logger.debug({ host, port }, 'Tunnel established');

        // Send success response
        clientSocket.write(
          'HTTP/1.1 200 Connection Established\r\n' + 'Proxy-Agent: ts-agent-proxy\r\n' + '\r\n',
        );

        // Log successful connection
        this.options.auditLogger.logRequest(
          requestInfo,
          { allowed: true, reason: 'Tunnel established' },
          Date.now() - startTime,
        );

        // Pipe the connection data
        serverSocket.write(head);
        clientSocket.pipe(serverSocket);
        serverSocket.pipe(clientSocket);

        // Start idle timeout
        resetIdleTimeout();

        // Reset idle timeout on data transfer
        clientSocket.on('data', resetIdleTimeout);
        serverSocket.on('data', resetIdleTimeout);

        safeResolve();
      });

      serverSocket.on('error', (err) => {
        this.options.logger.error({ host, port, error: err.message }, 'Tunnel connection failed');
        clientSocket.destroy();
        safeReject(err);
      });

      clientSocket.on('error', (err) => {
        this.options.logger.error({ error: err.message }, 'Client socket error');
        serverSocket.destroy();
        cleanupAll();
      });

      clientSocket.on('close', () => {
        serverSocket.destroy();
        cleanupAll();
      });

      serverSocket.on('close', () => {
        clientSocket.destroy();
        cleanupAll();
      });
    });
  }

  /**
   * Send a 403 Forbidden response.
   */
  private sendForbidden(socket: Socket, reason: string): void {
    sendSocketError(socket, 403, 'Forbidden', reason);
  }

  /**
   * Send a 429 Too Many Requests response.
   */
  private sendRateLimited(socket: Socket, retryAfterMs: number): void {
    const retryAfterSec = Math.ceil(retryAfterMs / 1000);
    sendSocketError(socket, 429, 'Too Many Requests', 'Rate limit exceeded', {
      'Retry-After': String(retryAfterSec),
    });
  }

  /**
   * Send a 502 Bad Gateway response.
   */
  private sendError(socket: Socket, reason: string): void {
    sendSocketError(socket, 502, 'Bad Gateway', reason);
  }
}

/**
 * Create a CONNECT handler.
 */
export function createConnectHandler(options: ConnectHandlerOptions): ConnectHandler {
  return new ConnectHandler(options);
}
