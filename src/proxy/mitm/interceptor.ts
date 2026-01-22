/**
 * MITM interceptor for full HTTPS inspection.
 *
 * This mode allows inspection of request paths, methods, and headers
 * by dynamically generating certificates and decrypting traffic.
 */

import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Socket } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '../../logging/logger.js';
import type { AllowlistMatcher } from '../../filter/allowlist-matcher.js';
import type { RateLimiter } from '../../filter/rate-limiter.js';
import type { AuditLogger } from '../../logging/audit-logger.js';
import type { RequestInfo } from '../../types/allowlist.js';
import type { LimitsConfig, TimeoutsConfig } from '../../types/config.js';
import { DEFAULT_LIMITS, DEFAULT_TIMEOUTS } from '../../types/config.js';
import { CertManager, type CertificateInfo } from './cert-manager.js';
import {
  HttpRequestParser,
  HttpParseError,
  type ParsedHttpRequest,
  serializeHttpRequest,
} from '../http-parser.js';
import {
  LimitingStream,
  SizeLimitExceededError,
  TimeoutError,
} from '../size-limiter.js';

export interface MitmInterceptorOptions {
  allowlistMatcher: AllowlistMatcher;
  rateLimiter: RateLimiter;
  auditLogger: AuditLogger;
  logger: Logger;
  certManager: CertManager;
  limits?: LimitsConfig;
  timeouts?: TimeoutsConfig;
}

export class MitmInterceptor {
  private readonly options: MitmInterceptorOptions;
  private readonly limits: LimitsConfig;
  private readonly timeouts: TimeoutsConfig;

  constructor(options: MitmInterceptorOptions) {
    this.options = options;
    this.limits = options.limits ?? DEFAULT_LIMITS;
    this.timeouts = options.timeouts ?? DEFAULT_TIMEOUTS;
  }

  /**
   * Handle a CONNECT request with MITM interception.
   */
  async handleConnect(
    req: IncomingMessage,
    clientSocket: Socket,
    head: Buffer
  ): Promise<void> {
    const { host, port } = this.parseTarget(req.url ?? '');
    const sourceIp = this.getClientIp(req);

    this.options.logger.debug({ host, port, sourceIp }, 'MITM CONNECT request');

    // First check if domain is allowed at all
    const domainResult = this.options.allowlistMatcher.isDomainAllowed(host);
    if (!domainResult.allowed) {
      this.sendForbidden(clientSocket, `Domain not allowed: ${host}`);
      return;
    }

    try {
      // Generate certificate for this domain
      const certInfo = this.options.certManager.generateCertForDomain(host);

      // Create TLS server for client connection
      const tlsOptions: tls.TlsOptions = {
        key: certInfo.key,
        cert: certInfo.cert,
      };

      // Send connection established response
      clientSocket.write(
        'HTTP/1.1 200 Connection Established\r\n' +
        'Proxy-Agent: ts-agent-proxy\r\n' +
        '\r\n'
      );

      // Upgrade to TLS
      const tlsSocket = new tls.TLSSocket(clientSocket, {
        ...tlsOptions,
        isServer: true,
      });

      // Handle the TLS connection
      this.handleTlsConnection(tlsSocket, host, port, sourceIp);
    } catch (error) {
      this.options.logger.error({ error, host }, 'MITM setup failed');
      this.sendError(clientSocket, 'Failed to establish secure connection');
    }
  }

  /**
   * Handle the established TLS connection.
   */
  private handleTlsConnection(
    clientSocket: tls.TLSSocket,
    targetHost: string,
    targetPort: number,
    sourceIp: string
  ): void {
    // Create robust HTTP parser with size limits
    const parser = new HttpRequestParser({
      maxHeaderSize: this.limits.maxHeaderSize,
      maxBodySize: this.limits.maxRequestBodySize,
    });

    let requestTimeoutId: NodeJS.Timeout | undefined;
    let isProcessing = false;

    const resetRequestTimeout = () => {
      if (requestTimeoutId) clearTimeout(requestTimeoutId);
      requestTimeoutId = setTimeout(() => {
        this.options.logger.warn({ targetHost, sourceIp }, 'Request timeout in MITM mode');
        const response = this.createErrorResponse(408, 'Request timeout');
        clientSocket.write(response);
        clientSocket.end();
      }, this.timeouts.requestTimeout);
    };

    const clearRequestTimeout = () => {
      if (requestTimeoutId) {
        clearTimeout(requestTimeoutId);
        requestTimeoutId = undefined;
      }
    };

    // Set initial request timeout
    resetRequestTimeout();

    parser.on('error', (error: HttpParseError) => {
      clearRequestTimeout();
      this.options.logger.warn({ error: error.message, code: error.code }, 'HTTP parse error');

      let statusCode = 400;
      let message = 'Bad Request';

      if (error.code === 'HEADERS_TOO_LARGE') {
        statusCode = 431;
        message = 'Request Header Fields Too Large';
      } else if (error.code === 'BODY_TOO_LARGE') {
        statusCode = 413;
        message = 'Request Entity Too Large';
      }

      const response = this.createErrorResponse(statusCode, message);
      clientSocket.write(response);
      clientSocket.end();
    });

    parser.on('complete', async (request: ParsedHttpRequest) => {
      if (isProcessing) return;
      isProcessing = true;
      clearRequestTimeout();

      const requestInfo: RequestInfo = {
        host: targetHost,
        port: targetPort,
        path: request.path,
        method: request.method,
        headers: request.headers,
        sourceIp,
      };

      const startTime = Date.now();

      try {
        // Check full allowlist (including path and method)
        const matchResult = this.options.allowlistMatcher.match(requestInfo);

        if (!matchResult.allowed) {
          this.options.auditLogger.logRequest(requestInfo, matchResult, Date.now() - startTime);
          const response = this.createErrorResponse(403, matchResult.reason);
          clientSocket.write(response);
          this.prepareForNextRequest(clientSocket, parser);
          return;
        }

        // Check rate limit
        const rateLimitKey = `${matchResult.matchedRule?.id ?? 'default'}:${sourceIp}`;
        const rateLimitResult = await this.options.rateLimiter.consume(
          rateLimitKey,
          matchResult.matchedRule?.id
        );

        if (!rateLimitResult.allowed) {
          this.options.auditLogger.logRateLimit(
            requestInfo,
            rateLimitResult,
            matchResult.matchedRule
          );
          const response = this.createErrorResponse(
            429,
            'Rate limit exceeded',
            { 'Retry-After': Math.ceil(rateLimitResult.resetMs / 1000).toString() }
          );
          clientSocket.write(response);
          this.prepareForNextRequest(clientSocket, parser);
          return;
        }

        // Forward the request
        await this.forwardRequest(clientSocket, targetHost, targetPort, request, requestInfo, startTime);
        this.prepareForNextRequest(clientSocket, parser);
      } catch (error) {
        this.options.logger.error({ error: (error as Error).message }, 'Error processing MITM request');
        if (error instanceof TimeoutError) {
          const response = this.createErrorResponse(504, 'Gateway Timeout');
          clientSocket.write(response);
        } else if (error instanceof SizeLimitExceededError) {
          const response = this.createErrorResponse(502, 'Response too large');
          clientSocket.write(response);
        } else {
          const response = this.createErrorResponse(502, 'Bad Gateway');
          clientSocket.write(response);
        }
        this.prepareForNextRequest(clientSocket, parser);
      }
    });

    clientSocket.on('data', (data: Buffer) => {
      if (!isProcessing) {
        resetRequestTimeout();
        parser.write(data);
      }
    });

    clientSocket.on('error', (error) => {
      clearRequestTimeout();
      this.options.logger.error({ error: error.message }, 'TLS socket error');
    });

    clientSocket.on('close', () => {
      clearRequestTimeout();
    });
  }

  /**
   * Prepare for the next request on a keep-alive connection.
   */
  private prepareForNextRequest(
    clientSocket: tls.TLSSocket,
    parser: HttpRequestParser
  ): void {
    parser.reset();
    // The data event handler will continue feeding data to the parser
  }

  /**
   * Forward the decrypted request to the target server.
   */
  private async forwardRequest(
    clientSocket: tls.TLSSocket,
    targetHost: string,
    targetPort: number,
    request: ParsedHttpRequest,
    requestInfo: RequestInfo,
    startTime: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let connectTimeoutId: NodeJS.Timeout | undefined;
      let responseTimeoutId: NodeJS.Timeout | undefined;
      let resolved = false;
      let responseBytesReceived = 0;

      const cleanup = () => {
        if (connectTimeoutId) clearTimeout(connectTimeoutId);
        if (responseTimeoutId) clearTimeout(responseTimeoutId);
      };

      const safeReject = (error: Error) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(error);
        }
      };

      const safeResolve = () => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve();
        }
      };

      const options: https.RequestOptions = {
        hostname: targetHost,
        port: targetPort,
        path: request.path,
        method: request.method,
        headers: request.headers,
        rejectUnauthorized: true,
        timeout: this.timeouts.connectTimeout,
      };

      // Set connect timeout
      connectTimeoutId = setTimeout(() => {
        safeReject(new TimeoutError('Connect timeout', this.timeouts.connectTimeout));
        proxyReq.destroy();
      }, this.timeouts.connectTimeout);

      const proxyReq = https.request(options, (proxyRes) => {
        // Clear connect timeout, set response timeout
        if (connectTimeoutId) {
          clearTimeout(connectTimeoutId);
          connectTimeoutId = undefined;
        }

        responseTimeoutId = setTimeout(() => {
          safeReject(new TimeoutError('Response timeout', this.timeouts.responseTimeout));
          proxyReq.destroy();
        }, this.timeouts.responseTimeout);

        // Check Content-Length before processing
        const contentLengthHeader = proxyRes.headers['content-length'];
        if (contentLengthHeader) {
          const size = parseInt(contentLengthHeader, 10);
          if (!isNaN(size) && size > this.limits.maxResponseBodySize) {
            safeReject(new SizeLimitExceededError('response', this.limits.maxResponseBodySize, size));
            proxyReq.destroy();
            return;
          }
        }

        this.options.auditLogger.logRequest(
          requestInfo,
          { allowed: true, reason: 'Request forwarded (MITM)' },
          Date.now() - startTime
        );

        // Build response headers
        let response = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (value) {
            response += `${key}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`;
          }
        }
        response += '\r\n';

        clientSocket.write(response);

        // Stream response with size checking
        proxyRes.on('data', (chunk: Buffer) => {
          responseBytesReceived += chunk.length;
          if (responseBytesReceived > this.limits.maxResponseBodySize) {
            this.options.logger.warn(
              { received: responseBytesReceived, limit: this.limits.maxResponseBodySize },
              'Response body exceeded limit'
            );
            safeReject(new SizeLimitExceededError('response', this.limits.maxResponseBodySize, responseBytesReceived));
            proxyReq.destroy();
            return;
          }
          clientSocket.write(chunk);
        });

        proxyRes.on('end', safeResolve);
        proxyRes.on('error', safeReject);
      });

      proxyReq.on('socket', (socket) => {
        socket.on('connect', () => {
          if (connectTimeoutId) {
            clearTimeout(connectTimeoutId);
            connectTimeoutId = undefined;
          }
        });
      });

      proxyReq.on('error', (error) => {
        this.options.logger.error({ error: error.message }, 'Proxy request failed');
        safeReject(error);
      });

      proxyReq.on('timeout', () => {
        safeReject(new TimeoutError('Request timeout', this.timeouts.connectTimeout));
        proxyReq.destroy();
      });

      // Send request body if present
      if (request.body && request.body.length > 0) {
        proxyReq.write(request.body);
      }
      proxyReq.end();
    });
  }


  /**
   * Create an HTTP error response.
   */
  private createErrorResponse(
    status: number,
    message: string,
    extraHeaders: Record<string, string> = {}
  ): string {
    const statusText = http.STATUS_CODES[status] ?? 'Error';
    let response = `HTTP/1.1 ${status} ${statusText}\r\n`;
    response += 'Content-Type: text/plain\r\n';
    response += `Content-Length: ${Buffer.byteLength(message)}\r\n`;
    for (const [key, value] of Object.entries(extraHeaders)) {
      response += `${key}: ${value}\r\n`;
    }
    response += '\r\n';
    response += message;
    return response;
  }

  private parseTarget(url: string): { host: string; port: number } {
    const [host, portStr] = url.split(':');
    return { host, port: portStr ? parseInt(portStr, 10) : 443 };
  }

  private getClientIp(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  private sendForbidden(socket: Socket, reason: string): void {
    socket.write(
      'HTTP/1.1 403 Forbidden\r\n' +
      'Content-Type: text/plain\r\n' +
      'Connection: close\r\n\r\n' +
      reason
    );
    socket.end();
  }

  private sendError(socket: Socket, reason: string): void {
    socket.write(
      'HTTP/1.1 502 Bad Gateway\r\n' +
      'Content-Type: text/plain\r\n' +
      'Connection: close\r\n\r\n' +
      reason
    );
    socket.end();
  }
}

/**
 * Create a MITM interceptor.
 */
export function createMitmInterceptor(options: MitmInterceptorOptions): MitmInterceptor {
  return new MitmInterceptor(options);
}
