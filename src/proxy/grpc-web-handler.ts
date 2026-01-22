/**
 * gRPC-Web proxy handler.
 *
 * Handles gRPC-Web requests over HTTP/1.1, providing translation between
 * gRPC-Web protocol and native gRPC when proxying to backends.
 *
 * @module proxy/grpc-web-handler
 */

import http from 'node:http';
import http2 from 'node:http2';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '../logging/logger.js';
import type { AuditLogger } from '../logging/audit-logger.js';
import type { AllowlistMatcher } from '../filter/allowlist-matcher.js';
import type { RateLimiter } from '../filter/rate-limiter.js';
import type { RequestInfo } from '../types/allowlist.js';
import { GrpcMatcher, createGrpcMatcher } from '../filter/grpc-matcher.js';
import {
  parseGrpcPath,
  parseGrpcTimeout,
  parseGrpcFrames,
  encodeGrpcFrame,
  encodeGrpcTrailers,
  isGrpcWebContentType,
  isGrpcWebTextContentType,
  GrpcStatus,
  GRPC_FRAME_HEADER_SIZE,
  DEFAULT_MAX_MESSAGE_SIZE,
} from './grpc-parser.js';

/**
 * gRPC-Web handler configuration.
 */
export interface GrpcWebHandlerConfig {
  /** Allowlist matcher for filtering */
  allowlistMatcher: AllowlistMatcher;
  /** Rate limiter */
  rateLimiter: RateLimiter;
  /** Audit logger */
  auditLogger: AuditLogger;
  /** Logger instance */
  logger: Logger;
  /** Default upstream port for gRPC (default: 443) */
  defaultPort?: number;
  /** Connection timeout in ms (default: 10000) */
  connectionTimeout?: number;
  /** Request timeout in ms (default: 30000) */
  requestTimeout?: number;
  /** Maximum message size (default: 4MB) */
  maxMessageSize?: number;
  /** Enable TLS for upstream (default: true) */
  upstreamTls?: boolean;
  /** Skip TLS verification (default: false) */
  insecureSkipVerify?: boolean;
}

/**
 * gRPC-Web statistics.
 */
export interface GrpcWebStats {
  totalRequests: number;
  activeRequests: number;
  bytesTransferred: number;
  requestsRejected: number;
  textRequests: number;
  binaryRequests: number;
}

/**
 * gRPC-Web proxy handler.
 *
 * Provides gRPC-Web support for browsers and HTTP/1.1 clients.
 * Translates between gRPC-Web and native gRPC protocols.
 *
 * Supported content types:
 * - application/grpc-web (binary)
 * - application/grpc-web+proto (binary)
 * - application/grpc-web-text (base64 encoded)
 * - application/grpc-web-text+proto (base64 encoded)
 *
 * @example
 * ```typescript
 * const grpcWebHandler = new GrpcWebHandler({
 *   allowlistMatcher,
 *   rateLimiter,
 *   auditLogger,
 *   logger,
 * });
 *
 * // In HTTP server
 * server.on('request', (req, res) => {
 *   if (grpcWebHandler.isGrpcWebRequest(req)) {
 *     grpcWebHandler.handleRequest(req, res);
 *   }
 * });
 * ```
 */
export class GrpcWebHandler {
  private readonly config: Required<GrpcWebHandlerConfig>;
  private readonly grpcMatcher: GrpcMatcher;
  private readonly upstreamSessions: Map<string, http2.ClientHttp2Session> = new Map();
  private readonly stats: GrpcWebStats = {
    totalRequests: 0,
    activeRequests: 0,
    bytesTransferred: 0,
    requestsRejected: 0,
    textRequests: 0,
    binaryRequests: 0,
  };

  constructor(config: GrpcWebHandlerConfig) {
    this.config = {
      ...config,
      defaultPort: config.defaultPort ?? 443,
      connectionTimeout: config.connectionTimeout ?? 10000,
      requestTimeout: config.requestTimeout ?? 30000,
      maxMessageSize: config.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE,
      upstreamTls: config.upstreamTls ?? true,
      insecureSkipVerify: config.insecureSkipVerify ?? false,
    };

    this.grpcMatcher = createGrpcMatcher();
  }

  /**
   * Check if request is a gRPC-Web request.
   */
  isGrpcWebRequest(req: IncomingMessage): boolean {
    const contentType = req.headers['content-type'];
    return isGrpcWebContentType(contentType);
  }

  /**
   * Handle a gRPC-Web request.
   */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startTime = Date.now();
    this.stats.totalRequests++;
    this.stats.activeRequests++;

    const contentType = req.headers['content-type'] ?? '';
    const isText = isGrpcWebTextContentType(contentType);

    if (isText) {
      this.stats.textRequests++;
    } else {
      this.stats.binaryRequests++;
    }

    const path = req.url ?? '/';
    const host = req.headers.host ?? '';

    // Parse gRPC path
    const grpcPath = parseGrpcPath(path);
    if (!grpcPath) {
      this.sendGrpcWebError(res, GrpcStatus.INVALID_ARGUMENT, 'Invalid gRPC path', isText);
      this.stats.activeRequests--;
      return;
    }

    // Parse host
    const { hostname, port } = this.parseHost(host);

    this.config.logger.debug(
      { host: hostname, service: grpcPath.fullService, method: grpcPath.method },
      'gRPC-Web request received'
    );

    // Build request info
    const clientIp = this.getClientIp(req);
    const requestInfo: RequestInfo = {
      host: hostname,
      port,
      path,
      method: 'POST',
      sourceIp: clientIp,
      grpcService: grpcPath.fullService,
      grpcMethod: grpcPath.method,
      isGrpc: true,
    };

    // Check allowlist
    const matchResult = this.config.allowlistMatcher.match(requestInfo);
    if (!matchResult.allowed) {
      this.stats.requestsRejected++;
      this.config.auditLogger.logRequest(requestInfo, matchResult, {
        durationMs: Date.now() - startTime,
      });
      this.sendGrpcWebError(res, GrpcStatus.PERMISSION_DENIED, matchResult.reason, isText);
      this.stats.activeRequests--;
      return;
    }

    // Check gRPC-specific rules
    const grpcMatch = this.grpcMatcher.match(path, matchResult.matchedRule?.grpc);
    if (!grpcMatch.allowed) {
      this.stats.requestsRejected++;
      this.config.auditLogger.logRequest(requestInfo, {
        allowed: false,
        reason: grpcMatch.reason,
      }, {
        durationMs: Date.now() - startTime,
      });
      this.sendGrpcWebError(res, GrpcStatus.PERMISSION_DENIED, grpcMatch.reason, isText);
      this.stats.activeRequests--;
      return;
    }

    // Check rate limit
    const rateLimitResult = await this.config.rateLimiter.consume(
      clientIp,
      matchResult.matchedRule?.id
    );
    if (!rateLimitResult.allowed) {
      this.stats.requestsRejected++;
      this.config.auditLogger.logRateLimit(
        requestInfo,
        rateLimitResult,
        matchResult.matchedRule
      );
      this.sendGrpcWebError(res, GrpcStatus.RESOURCE_EXHAUSTED, 'Rate limit exceeded', isText);
      this.stats.activeRequests--;
      return;
    }

    // Proxy to upstream
    try {
      await this.proxyToUpstream(req, res, hostname, port, grpcPath, isText, requestInfo, matchResult);
    } catch (error) {
      this.config.logger.error(
        { error, host: hostname, service: grpcPath.fullService },
        'gRPC-Web proxy error'
      );
      this.config.auditLogger.logError(requestInfo, error as Error);

      if (!res.headersSent) {
        this.sendGrpcWebError(res, GrpcStatus.UNAVAILABLE, 'Upstream connection failed', isText);
      }
    } finally {
      this.stats.activeRequests--;
    }
  }

  /**
   * Proxy request to upstream gRPC server.
   */
  private async proxyToUpstream(
    req: IncomingMessage,
    res: ServerResponse,
    host: string,
    port: number,
    grpcPath: { fullPath: string; fullService: string; method: string },
    isText: boolean,
    requestInfo: RequestInfo,
    matchResult: any
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Get upstream session
      const session = this.getUpstreamSession(host, port);

      // Collect request body
      const bodyChunks: Buffer[] = [];

      req.on('data', (chunk: Buffer) => {
        bodyChunks.push(chunk);
        this.stats.bytesTransferred += chunk.length;
      });

      req.on('end', () => {
        let requestBody = Buffer.concat(bodyChunks);

        // Decode base64 if text format
        if (isText) {
          requestBody = Buffer.from(requestBody.toString('utf-8'), 'base64');
        }

        // Build upstream headers
        const upstreamHeaders: http2.OutgoingHttpHeaders = {
          ':method': 'POST',
          ':path': grpcPath.fullPath,
          ':scheme': this.config.upstreamTls ? 'https' : 'http',
          ':authority': `${host}:${port}`,
          'content-type': 'application/grpc',
          'te': 'trailers',
        };

        // Forward timeout
        const timeout = req.headers['grpc-timeout'];
        if (timeout) {
          upstreamHeaders['grpc-timeout'] = timeout;
        }

        // Forward custom metadata
        for (const [key, value] of Object.entries(req.headers)) {
          if (key.startsWith('x-') || key.startsWith('grpc-')) {
            if (!key.startsWith('grpc-web')) {
              upstreamHeaders[key] = value;
            }
          }
        }

        // Create upstream request
        const upstreamStream = session.request(upstreamHeaders);

        // Set up timeout
        const timeoutMs = this.config.requestTimeout;
        const timeoutId = setTimeout(() => {
          if (!upstreamStream.destroyed) {
            upstreamStream.destroy();
            this.sendGrpcWebError(res, GrpcStatus.DEADLINE_EXCEEDED, 'Request timeout', isText);
          }
        }, timeoutMs);

        // Send request body
        upstreamStream.write(requestBody);
        upstreamStream.end();

        // Collect response
        const responseChunks: Buffer[] = [];
        let responseHeaders: http2.IncomingHttpHeaders | null = null;

        upstreamStream.on('response', (headers) => {
          responseHeaders = headers;
        });

        upstreamStream.on('data', (chunk: Buffer) => {
          responseChunks.push(chunk);
          this.stats.bytesTransferred += chunk.length;
        });

        upstreamStream.on('end', () => {
          clearTimeout(timeoutId);

          let responseBody = Buffer.concat(responseChunks);
          let trailers: Record<string, string> = {};

          // Get trailers
          const rawTrailers = upstreamStream.sentTrailers || {};
          for (const [key, value] of Object.entries(rawTrailers)) {
            if (typeof value === 'string') {
              trailers[key] = value;
            }
          }

          // Build gRPC-Web response
          // In gRPC-Web, trailers are sent as a trailer frame in the body
          const trailerFrame = this.encodeTrailerFrame(trailers);
          const fullResponse = Buffer.concat([responseBody, trailerFrame]);

          // Set response headers
          const grpcWebContentType = isText
            ? 'application/grpc-web-text'
            : 'application/grpc-web';

          res.setHeader('Content-Type', grpcWebContentType);
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Expose-Headers', 'grpc-status,grpc-message');

          // Encode as base64 if text format
          let finalBody = fullResponse;
          if (isText) {
            finalBody = Buffer.from(fullResponse.toString('base64'));
          }

          res.end(finalBody);

          // Log success
          this.config.auditLogger.logRequest(requestInfo, matchResult, {
            durationMs: Date.now() - Date.now(),
          });

          resolve();
        });

        upstreamStream.on('trailers', (trailers) => {
          // Trailers received - they'll be included in the response
        });

        upstreamStream.on('error', (error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
      });

      req.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Encode trailers as a gRPC frame.
   */
  private encodeTrailerFrame(trailers: Record<string, string>): Buffer {
    // Build trailer string
    const parts: string[] = [];
    for (const [key, value] of Object.entries(trailers)) {
      parts.push(`${key}: ${value}`);
    }

    // Add default grpc-status if not present
    if (!('grpc-status' in trailers)) {
      parts.unshift('grpc-status: 0');
    }

    const trailerStr = parts.join('\r\n');
    const trailerData = Buffer.from(trailerStr, 'utf-8');

    // Trailer frame has compressed flag = 0x80 (128)
    const header = Buffer.alloc(GRPC_FRAME_HEADER_SIZE);
    header[0] = 0x80; // Trailer flag
    header.writeUInt32BE(trailerData.length, 1);

    return Buffer.concat([header, trailerData]);
  }

  /**
   * Get or create upstream HTTP/2 session.
   */
  private getUpstreamSession(host: string, port: number): http2.ClientHttp2Session {
    const key = `${host}:${port}`;
    const existing = this.upstreamSessions.get(key);

    if (existing && !existing.destroyed && !existing.closed) {
      return existing;
    }

    const url = this.config.upstreamTls
      ? `https://${host}:${port}`
      : `http://${host}:${port}`;

    const session = http2.connect(url, {
      rejectUnauthorized: !this.config.insecureSkipVerify,
    });

    session.on('error', (error) => {
      this.config.logger.error({ error, host, port }, 'Upstream session error');
      this.upstreamSessions.delete(key);
    });

    session.on('close', () => {
      this.upstreamSessions.delete(key);
    });

    this.upstreamSessions.set(key, session);
    return session;
  }

  /**
   * Send gRPC-Web error response.
   */
  private sendGrpcWebError(
    res: ServerResponse,
    status: GrpcStatus,
    message: string,
    isText: boolean
  ): void {
    const contentType = isText
      ? 'application/grpc-web-text'
      : 'application/grpc-web';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'grpc-status,grpc-message');

    // Build trailer-only response
    const trailerFrame = this.encodeTrailerFrame({
      'grpc-status': String(status),
      'grpc-message': encodeURIComponent(message),
    });

    let body = trailerFrame;
    if (isText) {
      body = Buffer.from(trailerFrame.toString('base64'));
    }

    res.end(body);
  }

  /**
   * Parse host header.
   */
  private parseHost(host: string): { hostname: string; port: number } {
    const colonIndex = host.lastIndexOf(':');
    if (colonIndex === -1) {
      return { hostname: host, port: this.config.defaultPort };
    }

    const hostname = host.slice(0, colonIndex);
    const port = parseInt(host.slice(colonIndex + 1), 10);

    return {
      hostname,
      port: isNaN(port) ? this.config.defaultPort : port,
    };
  }

  /**
   * Get client IP.
   */
  private getClientIp(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      return ips.split(',')[0].trim();
    }
    return req.socket?.remoteAddress ?? 'unknown';
  }

  /**
   * Get statistics.
   */
  getStats(): GrpcWebStats {
    return { ...this.stats };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats.totalRequests = 0;
    this.stats.activeRequests = 0;
    this.stats.bytesTransferred = 0;
    this.stats.requestsRejected = 0;
    this.stats.textRequests = 0;
    this.stats.binaryRequests = 0;
  }

  /**
   * Close all upstream sessions.
   */
  closeAll(): void {
    for (const session of this.upstreamSessions.values()) {
      if (!session.destroyed) {
        session.close();
      }
    }
    this.upstreamSessions.clear();
  }

  /**
   * Handle CORS preflight for gRPC-Web.
   */
  handleCors(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers',
        'Content-Type, X-Grpc-Web, X-User-Agent, Grpc-Timeout, Authorization');
      res.setHeader('Access-Control-Max-Age', '86400');
      res.statusCode = 204;
      res.end();
      return true;
    }
    return false;
  }
}

/**
 * Create a gRPC-Web handler.
 */
export function createGrpcWebHandler(config: GrpcWebHandlerConfig): GrpcWebHandler {
  return new GrpcWebHandler(config);
}

/**
 * Check if request is gRPC-Web.
 */
export function isGrpcWebRequest(req: IncomingMessage): boolean {
  const contentType = req.headers['content-type'];
  return isGrpcWebContentType(contentType);
}
