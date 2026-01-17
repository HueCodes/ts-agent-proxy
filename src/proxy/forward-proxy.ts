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

export interface ForwardProxyOptions {
  allowlistMatcher: AllowlistMatcher;
  rateLimiter: RateLimiter;
  auditLogger: AuditLogger;
  logger: Logger;
}

export class ForwardProxy {
  private readonly options: ForwardProxyOptions;

  constructor(options: ForwardProxyOptions) {
    this.options = options;
  }

  /**
   * Handle an HTTP request by forwarding it to the target.
   */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startTime = Date.now();
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

    // Forward the request
    try {
      await this.forwardRequest(req, res, url, requestInfo, startTime);
    } catch (error) {
      this.options.auditLogger.logError(requestInfo, error as Error);
      this.sendError(res, 502, 'Failed to forward request');
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

      // Build proxy request options
      const options: http.RequestOptions = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: clientReq.method,
        headers: this.filterHeaders(clientReq.headers),
      };

      const proxyReq = transport.request(options, (proxyRes) => {
        // Log successful request
        this.options.auditLogger.logRequest(
          requestInfo,
          { allowed: true, reason: 'Request forwarded' },
          Date.now() - startTime
        );

        // Forward response headers
        const responseHeaders = this.filterResponseHeaders(proxyRes.headers);
        clientRes.writeHead(proxyRes.statusCode ?? 200, responseHeaders);

        // Pipe response body
        proxyRes.pipe(clientRes);

        proxyRes.on('end', resolve);
        proxyRes.on('error', reject);
      });

      proxyReq.on('error', (error) => {
        this.options.logger.error({ error: error.message }, 'Proxy request failed');
        reject(error);
      });

      // Pipe request body
      clientReq.pipe(proxyReq);
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
