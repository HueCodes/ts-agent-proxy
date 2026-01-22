/**
 * Forward proxy for HTTP requests.
 *
 * Handles regular HTTP requests (non-CONNECT) by forwarding them
 * to the target server after checking the allowlist.
 */

import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '../logging/logger.js';
import type { AllowlistMatcher } from '../filter/allowlist-matcher.js';
import type { RateLimiter } from '../filter/rate-limiter.js';
import type { AuditLogger } from '../logging/audit-logger.js';
import type { RequestInfo } from '../types/allowlist.js';
import type { LimitsConfig, TimeoutsConfig } from '../types/config.js';
import { DEFAULT_LIMITS, DEFAULT_TIMEOUTS } from '../types/config.js';
import {
  checkContentLength,
  checkHeadersSize,
  checkUrlLength,
  sendPayloadTooLarge,
  sendHeadersTooLarge,
  sendUriTooLong,
  sendGatewayTimeout,
  LimitingStream,
  SizeLimitExceededError,
  TimeoutError,
} from './size-limiter.js';
import {
  ConnectionPool,
  createConnectionPool,
  type ConnectionPoolConfig,
} from './connection-pool.js';

export interface ForwardProxyOptions {
  allowlistMatcher: AllowlistMatcher;
  rateLimiter: RateLimiter;
  auditLogger: AuditLogger;
  logger: Logger;
  limits?: LimitsConfig;
  timeouts?: TimeoutsConfig;
  /** Connection pool configuration */
  connectionPool?: Partial<ConnectionPoolConfig>;
}

export class ForwardProxy {
  private readonly options: ForwardProxyOptions;
  private readonly limits: LimitsConfig;
  private readonly timeouts: TimeoutsConfig;
  private readonly connectionPool: ConnectionPool;

  constructor(options: ForwardProxyOptions) {
    this.options = options;
    this.limits = options.limits ?? DEFAULT_LIMITS;
    this.timeouts = options.timeouts ?? DEFAULT_TIMEOUTS;
    this.connectionPool = createConnectionPool(
      {
        keepAliveTimeout: this.timeouts.idleTimeout,
        ...options.connectionPool,
      },
      options.logger
    );
  }

  /**
   * Get connection pool statistics.
   */
  getPoolStats() {
    return this.connectionPool.getStats();
  }

  /**
   * Destroy the connection pool.
   */
  destroy(): void {
    this.connectionPool.destroy();
  }

  /**
   * Handle an HTTP request by forwarding it to the target.
   */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startTime = Date.now();

    // Check URL length
    const urlCheck = checkUrlLength(req.url, this.limits.maxUrlLength);
    if (!urlCheck.valid) {
      this.options.logger.warn(
        { urlLength: urlCheck.length, limit: this.limits.maxUrlLength },
        'URL too long'
      );
      sendUriTooLong(res);
      return;
    }

    // Check header size
    const headerCheck = checkHeadersSize(req, this.limits.maxHeaderSize);
    if (!headerCheck.valid) {
      this.options.logger.warn(
        { headerSize: headerCheck.size, limit: this.limits.maxHeaderSize },
        'Headers too large'
      );
      sendHeadersTooLarge(res);
      return;
    }

    // Check Content-Length for request body
    const contentLengthCheck = checkContentLength(req, this.limits.maxRequestBodySize);
    if (!contentLengthCheck.valid) {
      this.options.logger.warn(
        { contentLength: contentLengthCheck.size, limit: this.limits.maxRequestBodySize },
        'Request body too large (Content-Length)'
      );
      sendPayloadTooLarge(res);
      return;
    }

    const url = this.parseUrl(req);

    if (!url) {
      this.sendError(res, 400, 'Invalid request URL');
      return;
    }

    const requestInfo: RequestInfo = {
      host: url.hostname,
      port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: req.method,
      sourceIp: this.getClientIp(req),
    };

    this.options.logger.debug(
      { host: requestInfo.host, path: requestInfo.path, method: requestInfo.method },
      'HTTP request received'
    );

    // Check allowlist
    const matchResult = this.options.allowlistMatcher.match(requestInfo);

    if (!matchResult.allowed) {
      this.options.auditLogger.logRequest(requestInfo, matchResult, Date.now() - startTime);
      this.sendError(res, 403, `Request not allowed: ${matchResult.reason}`);
      return;
    }

    // Check rate limit
    const rateLimitKey = `${matchResult.matchedRule?.id ?? 'default'}:${requestInfo.sourceIp}`;
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
      res.setHeader('Retry-After', Math.ceil(rateLimitResult.resetMs / 1000));
      this.sendError(res, 429, 'Rate limit exceeded');
      return;
    }

    // Forward the request with timeout and size limits
    try {
      await this.forwardRequest(req, res, url, requestInfo, startTime);
    } catch (error) {
      this.options.auditLogger.logError(requestInfo, error as Error);

      if (error instanceof TimeoutError) {
        this.options.logger.warn({ host: requestInfo.host, timeout: error.timeout }, 'Request timed out');
        sendGatewayTimeout(res, 'Upstream server timed out');
      } else if (error instanceof SizeLimitExceededError) {
        this.options.logger.warn(
          { type: error.type, limit: error.limit, received: error.received },
          'Size limit exceeded'
        );
        if (error.type === 'response') {
          this.sendError(res, 502, 'Response too large');
        } else {
          sendPayloadTooLarge(res);
        }
      } else {
        this.sendError(res, 502, 'Failed to forward request');
      }
    }
  }

  /**
   * Parse the target URL from the request.
   */
  private parseUrl(req: IncomingMessage): URL | null {
    try {
      // For proxy requests, the URL should be absolute
      if (req.url?.startsWith('http://') || req.url?.startsWith('https://')) {
        return new URL(req.url);
      }

      // For non-proxy requests, construct from Host header
      const host = req.headers.host;
      if (host && req.url) {
        return new URL(req.url, `http://${host}`);
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get the client IP address.
   */
  private getClientIp(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  /**
   * Forward the request to the target server.
   */
  private async forwardRequest(
    clientReq: IncomingMessage,
    clientRes: ServerResponse,
    targetUrl: URL,
    requestInfo: RequestInfo,
    startTime: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const transport = targetUrl.protocol === 'https:' ? https : http;
      let connectTimeoutId: NodeJS.Timeout | undefined;
      let responseTimeoutId: NodeJS.Timeout | undefined;
      let resolved = false;

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

      // Get the appropriate agent from the connection pool
      const agent = this.connectionPool.getAgentForProtocol(targetUrl.protocol);

      // Build proxy request options with connection pooling
      const options: http.RequestOptions = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: clientReq.method,
        headers: this.filterHeaders(clientReq.headers),
        timeout: this.timeouts.connectTimeout,
        agent,
      };

      const proxyReq = transport.request(options, (proxyRes) => {
        // Track connection reuse
        const socket = proxyReq.socket;
        const reused = socket ? (socket as any).reused === true : false;
        this.connectionPool.recordRequest(reused);
        // Clear connect timeout, set response timeout
        if (connectTimeoutId) {
          clearTimeout(connectTimeoutId);
          connectTimeoutId = undefined;
        }

        responseTimeoutId = setTimeout(() => {
          safeReject(new TimeoutError('Response timeout', this.timeouts.responseTimeout));
          proxyReq.destroy();
        }, this.timeouts.responseTimeout);

        // Check response Content-Length
        const responseContentLength = proxyRes.headers['content-length'];
        if (responseContentLength) {
          const size = parseInt(responseContentLength, 10);
          if (!isNaN(size) && size > this.limits.maxResponseBodySize) {
            this.options.logger.warn(
              { contentLength: size, limit: this.limits.maxResponseBodySize },
              'Response body too large (Content-Length)'
            );
            safeReject(new SizeLimitExceededError('response', this.limits.maxResponseBodySize, size));
            proxyReq.destroy();
            return;
          }
        }

        // Log successful request
        this.options.auditLogger.logRequest(
          requestInfo,
          { allowed: true, reason: 'Request forwarded' },
          Date.now() - startTime
        );

        // Forward response headers
        const responseHeaders = this.filterResponseHeaders(proxyRes.headers);
        clientRes.writeHead(proxyRes.statusCode ?? 200, responseHeaders);

        // Create size-limiting stream for response
        const responseLimiter = new LimitingStream(this.limits.maxResponseBodySize, 'response');

        responseLimiter.on('error', (error) => {
          this.options.logger.warn({ error: error.message }, 'Response size limit exceeded');
          safeReject(error);
          proxyReq.destroy();
        });

        // Pipe response body through size limiter
        proxyRes.pipe(responseLimiter).pipe(clientRes);

        proxyRes.on('end', safeResolve);
        proxyRes.on('error', safeReject);
      });

      // Set connect timeout
      connectTimeoutId = setTimeout(() => {
        safeReject(new TimeoutError('Connect timeout', this.timeouts.connectTimeout));
        proxyReq.destroy();
      }, this.timeouts.connectTimeout);

      proxyReq.on('socket', (socket) => {
        socket.on('connect', () => {
          // Connection established, clear connect timeout
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

      // Create size-limiting stream for request body
      const requestLimiter = new LimitingStream(this.limits.maxRequestBodySize, 'request');

      requestLimiter.on('error', (error) => {
        this.options.logger.warn({ error: error.message }, 'Request size limit exceeded');
        safeReject(error);
        proxyReq.destroy();
      });

      // Pipe request body through size limiter
      clientReq.pipe(requestLimiter).pipe(proxyReq);
    });
  }

  /**
   * Filter headers before forwarding to target.
   */
  private filterHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
    const filtered: http.OutgoingHttpHeaders = {};

    for (const [key, value] of Object.entries(headers)) {
      // Skip hop-by-hop headers
      const lowerKey = key.toLowerCase();
      if (
        lowerKey === 'proxy-connection' ||
        lowerKey === 'proxy-authenticate' ||
        lowerKey === 'proxy-authorization' ||
        lowerKey === 'connection' ||
        lowerKey === 'keep-alive' ||
        lowerKey === 'transfer-encoding' ||
        lowerKey === 'te' ||
        lowerKey === 'upgrade'
      ) {
        continue;
      }

      filtered[key] = value;
    }

    return filtered;
  }

  /**
   * Filter response headers before sending to client.
   */
  private filterResponseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
    const filtered: http.OutgoingHttpHeaders = {};

    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey === 'connection' ||
        lowerKey === 'keep-alive' ||
        lowerKey === 'transfer-encoding'
      ) {
        continue;
      }

      filtered[key] = value;
    }

    return filtered;
  }

  /**
   * Send an error response.
   */
  private sendError(res: ServerResponse, statusCode: number, message: string): void {
    res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
    res.end(message);
  }
}

/**
 * Create a forward proxy.
 */
export function createForwardProxy(options: ForwardProxyOptions): ForwardProxy {
  return new ForwardProxy(options);
}
