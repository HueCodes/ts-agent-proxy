/**
 * gRPC proxy handler for HTTP/2.
 *
 * Handles proxying of gRPC requests over HTTP/2 with support for
 * all RPC types (unary, client streaming, server streaming, bidirectional).
 *
 * @module proxy/grpc-handler
 */

import http2 from 'node:http2';
import tls from 'node:tls';
import type { Logger } from '../logging/logger.js';
import type { AuditLogger } from '../logging/audit-logger.js';
import type { AllowlistMatcher } from '../filter/allowlist-matcher.js';
import type { RateLimiter } from '../filter/rate-limiter.js';
import type { RequestInfo } from '../types/allowlist.js';
import { GrpcMatcher, createGrpcMatcher } from '../filter/grpc-matcher.js';
import {
  parseGrpcPath,
  parseGrpcTimeout,
  encodeGrpcTrailers,
  isGrpcContentType,
  GrpcStatus,
  GrpcStatusName,
  DEFAULT_MAX_MESSAGE_SIZE,
  type GrpcPath,
} from './grpc-parser.js';

const {
  HTTP2_HEADER_METHOD,
  HTTP2_HEADER_PATH,
  HTTP2_HEADER_SCHEME,
  HTTP2_HEADER_AUTHORITY,
  HTTP2_HEADER_STATUS,
  HTTP2_HEADER_CONTENT_TYPE,
} = http2.constants;

/**
 * gRPC handler configuration.
 */
export interface GrpcHandlerConfig {
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
  /** Maximum concurrent streams per connection (default: 100) */
  maxConcurrentStreams?: number;
  /** Enable TLS for upstream (default: true) */
  upstreamTls?: boolean;
  /** Skip TLS verification (default: false) */
  insecureSkipVerify?: boolean;
}

/**
 * gRPC connection statistics.
 */
export interface GrpcStats {
  /** Total gRPC requests */
  totalRequests: number;
  /** Active streams */
  activeStreams: number;
  /** Total messages forwarded */
  messagesForwarded: number;
  /** Total bytes transferred */
  bytesTransferred: number;
  /** Requests by service */
  requestsByService: Map<string, number>;
  /** Errors by status code */
  errorsByStatus: Map<GrpcStatus, number>;
  /** Requests rejected by allowlist */
  requestsRejected: number;
}

/**
 * Active upstream connection.
 */
interface UpstreamConnection {
  session: http2.ClientHttp2Session;
  host: string;
  port: number;
  activeStreams: number;
  createdAt: number;
}

/**
 * gRPC proxy handler.
 *
 * Proxies gRPC requests over HTTP/2 with allowlist filtering,
 * rate limiting, and observability.
 *
 * @example
 * ```typescript
 * const grpcHandler = new GrpcHandler({
 *   allowlistMatcher,
 *   rateLimiter,
 *   auditLogger,
 *   logger,
 * });
 *
 * // In HTTP/2 server
 * http2Server.on('stream', (stream, headers) => {
 *   if (grpcHandler.isGrpcRequest(headers)) {
 *     grpcHandler.handleStream(stream, headers);
 *   }
 * });
 * ```
 */
export class GrpcHandler {
  private readonly config: Required<GrpcHandlerConfig>;
  private readonly grpcMatcher: GrpcMatcher;
  private readonly upstreamConnections: Map<string, UpstreamConnection> = new Map();
  private readonly stats: GrpcStats = {
    totalRequests: 0,
    activeStreams: 0,
    messagesForwarded: 0,
    bytesTransferred: 0,
    requestsByService: new Map(),
    errorsByStatus: new Map(),
    requestsRejected: 0,
  };

  constructor(config: GrpcHandlerConfig) {
    this.config = {
      ...config,
      defaultPort: config.defaultPort ?? 443,
      connectionTimeout: config.connectionTimeout ?? 10000,
      requestTimeout: config.requestTimeout ?? 30000,
      maxMessageSize: config.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE,
      maxConcurrentStreams: config.maxConcurrentStreams ?? 100,
      upstreamTls: config.upstreamTls ?? true,
      insecureSkipVerify: config.insecureSkipVerify ?? false,
    };

    this.grpcMatcher = createGrpcMatcher();
  }

  /**
   * Check if headers indicate a gRPC request.
   */
  isGrpcRequest(headers: http2.IncomingHttpHeaders): boolean {
    const contentType = headers[HTTP2_HEADER_CONTENT_TYPE] as string | undefined;
    return isGrpcContentType(contentType);
  }

  /**
   * Handle an incoming gRPC stream.
   */
  async handleStream(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders
  ): Promise<void> {
    const startTime = Date.now();
    this.stats.totalRequests++;
    this.stats.activeStreams++;

    const path = headers[HTTP2_HEADER_PATH] as string;
    const authority = headers[HTTP2_HEADER_AUTHORITY] as string;

    // Parse gRPC path
    const grpcPath = parseGrpcPath(path);
    if (!grpcPath) {
      this.sendGrpcError(stream, GrpcStatus.INVALID_ARGUMENT, 'Invalid gRPC path');
      this.stats.activeStreams--;
      return;
    }

    // Parse authority (host:port)
    const { host, port } = this.parseAuthority(authority);

    this.config.logger.debug(
      { host, service: grpcPath.fullService, method: grpcPath.method },
      'gRPC request received'
    );

    // Build request info for allowlist checking
    const clientIp = this.getClientIp(stream);
    const requestInfo: RequestInfo = {
      host,
      port,
      path,
      method: 'POST', // gRPC always uses POST
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
      this.sendGrpcError(stream, GrpcStatus.PERMISSION_DENIED, matchResult.reason);
      this.stats.activeStreams--;
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
      this.sendGrpcError(stream, GrpcStatus.PERMISSION_DENIED, grpcMatch.reason);
      this.stats.activeStreams--;
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
      this.sendGrpcError(stream, GrpcStatus.RESOURCE_EXHAUSTED, 'Rate limit exceeded');
      this.stats.activeStreams--;
      return;
    }

    // Track by service
    const serviceCount = this.stats.requestsByService.get(grpcPath.fullService) ?? 0;
    this.stats.requestsByService.set(grpcPath.fullService, serviceCount + 1);

    // Proxy to upstream
    try {
      await this.proxyToUpstream(stream, headers, host, port, grpcPath, requestInfo, matchResult);
    } catch (error) {
      this.config.logger.error(
        { error, host, service: grpcPath.fullService },
        'gRPC proxy error'
      );
      this.config.auditLogger.logError(requestInfo, error as Error);

      if (!stream.destroyed) {
        this.sendGrpcError(stream, GrpcStatus.UNAVAILABLE, 'Upstream connection failed');
      }
    } finally {
      this.stats.activeStreams--;
    }
  }

  /**
   * Proxy stream to upstream gRPC server.
   */
  private async proxyToUpstream(
    clientStream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
    host: string,
    port: number,
    grpcPath: GrpcPath,
    requestInfo: RequestInfo,
    matchResult: any
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Get or create upstream connection
      const session = this.getUpstreamSession(host, port);

      // Handle session errors
      session.on('error', (error) => {
        this.config.logger.error({ error, host }, 'Upstream session error');
        reject(error);
      });

      // Build upstream headers
      const upstreamHeaders: http2.OutgoingHttpHeaders = {
        [HTTP2_HEADER_METHOD]: 'POST',
        [HTTP2_HEADER_PATH]: grpcPath.fullPath,
        [HTTP2_HEADER_SCHEME]: this.config.upstreamTls ? 'https' : 'http',
        [HTTP2_HEADER_AUTHORITY]: `${host}:${port}`,
      };

      // Forward relevant headers
      const forwardHeaders = [
        'content-type',
        'grpc-timeout',
        'grpc-encoding',
        'grpc-accept-encoding',
        'te',
        'user-agent',
      ];

      for (const header of forwardHeaders) {
        if (headers[header]) {
          upstreamHeaders[header] = headers[header];
        }
      }

      // Forward custom metadata (non-standard headers)
      for (const [key, value] of Object.entries(headers)) {
        if (!key.startsWith(':') && !forwardHeaders.includes(key) && value) {
          upstreamHeaders[key] = value;
        }
      }

      // Set timeout from header if present
      const timeoutHeader = headers['grpc-timeout'] as string | undefined;
      let timeout = this.config.requestTimeout;
      if (timeoutHeader) {
        const parsedTimeout = parseGrpcTimeout(timeoutHeader);
        if (parsedTimeout !== null) {
          timeout = Math.min(parsedTimeout, timeout);
        }
      }

      // Create upstream stream
      const upstreamStream = session.request(upstreamHeaders);

      // Set up timeout
      const timeoutId = setTimeout(() => {
        if (!upstreamStream.destroyed) {
          upstreamStream.destroy();
          this.sendGrpcError(clientStream, GrpcStatus.DEADLINE_EXCEEDED, 'Request timeout');
        }
      }, timeout);

      // Handle upstream response headers
      upstreamStream.on('response', (responseHeaders) => {
        // Forward response headers to client
        const clientHeaders: http2.OutgoingHttpHeaders = {};

        for (const [key, value] of Object.entries(responseHeaders)) {
          if (value !== undefined) {
            clientHeaders[key] = value;
          }
        }

        try {
          clientStream.respond(clientHeaders);
        } catch {
          // Stream may be destroyed
        }
      });

      // Pipe data bidirectionally
      let bytesFromClient = 0;
      let bytesFromUpstream = 0;

      clientStream.on('data', (chunk: Buffer) => {
        bytesFromClient += chunk.length;
        this.stats.bytesTransferred += chunk.length;
        this.stats.messagesForwarded++;

        if (!upstreamStream.destroyed) {
          upstreamStream.write(chunk);
        }
      });

      upstreamStream.on('data', (chunk: Buffer) => {
        bytesFromUpstream += chunk.length;
        this.stats.bytesTransferred += chunk.length;
        this.stats.messagesForwarded++;

        if (!clientStream.destroyed) {
          clientStream.write(chunk);
        }
      });

      // Handle client stream end
      clientStream.on('end', () => {
        if (!upstreamStream.destroyed) {
          upstreamStream.end();
        }
      });

      // Handle upstream stream end
      upstreamStream.on('end', () => {
        clearTimeout(timeoutId);

        if (!clientStream.destroyed) {
          clientStream.end();
        }

        // Log the request
        this.config.auditLogger.logRequest(requestInfo, matchResult, {
          durationMs: Date.now() - Date.now(), // Will be set by audit logger
        });

        resolve();
      });

      // Handle upstream trailers (in HTTP/2, trailers come as a separate headers frame)
      upstreamStream.on('trailers', (trailers) => {
        // Extract gRPC status
        const statusStr = trailers['grpc-status'];
        const status = statusStr !== undefined ? parseInt(statusStr as string, 10) : GrpcStatus.OK;

        if (status !== GrpcStatus.OK) {
          const errorCount = this.stats.errorsByStatus.get(status as GrpcStatus) ?? 0;
          this.stats.errorsByStatus.set(status as GrpcStatus, errorCount + 1);
        }

        // In gRPC over HTTP/2, trailers are typically sent as part of the stream close
        // The client will receive them from the upstream and we've already piped them through
      });

      // Handle errors
      upstreamStream.on('error', (error) => {
        clearTimeout(timeoutId);
        this.config.logger.error({ error, host }, 'Upstream stream error');
        reject(error);
      });

      clientStream.on('error', (error) => {
        clearTimeout(timeoutId);
        if (!upstreamStream.destroyed) {
          upstreamStream.destroy();
        }
      });

      clientStream.on('close', () => {
        clearTimeout(timeoutId);
        if (!upstreamStream.destroyed) {
          upstreamStream.close();
        }
      });
    });
  }

  /**
   * Get or create an upstream HTTP/2 session.
   */
  private getUpstreamSession(host: string, port: number): http2.ClientHttp2Session {
    const key = `${host}:${port}`;
    const existing = this.upstreamConnections.get(key);

    if (existing && !existing.session.destroyed && !existing.session.closed) {
      return existing.session;
    }

    // Create new session
    const url = this.config.upstreamTls
      ? `https://${host}:${port}`
      : `http://${host}:${port}`;

    const options: http2.SecureClientSessionOptions = {
      rejectUnauthorized: !this.config.insecureSkipVerify,
    };

    const session = http2.connect(url, options);

    session.on('error', (error) => {
      this.config.logger.error({ error, host, port }, 'HTTP/2 session error');
      this.upstreamConnections.delete(key);
    });

    session.on('close', () => {
      this.upstreamConnections.delete(key);
    });

    session.setTimeout(this.config.connectionTimeout, () => {
      session.destroy();
    });

    this.upstreamConnections.set(key, {
      session,
      host,
      port,
      activeStreams: 0,
      createdAt: Date.now(),
    });

    return session;
  }

  /**
   * Send a gRPC error response.
   */
  private sendGrpcError(
    stream: http2.ServerHttp2Stream,
    status: GrpcStatus,
    message: string
  ): void {
    const errorCount = this.stats.errorsByStatus.get(status) ?? 0;
    this.stats.errorsByStatus.set(status, errorCount + 1);

    if (stream.destroyed) {
      return;
    }

    try {
      // For gRPC errors, send headers with trailers (Trailers-Only response)
      // This is the standard gRPC way to send errors without body data
      stream.respond({
        [HTTP2_HEADER_STATUS]: 200,
        [HTTP2_HEADER_CONTENT_TYPE]: 'application/grpc',
        'grpc-status': String(status),
        'grpc-message': encodeURIComponent(message),
      }, { endStream: true });
    } catch {
      // Stream may be in wrong state
      stream.destroy();
    }
  }

  /**
   * Parse authority header into host and port.
   */
  private parseAuthority(authority: string): { host: string; port: number } {
    const colonIndex = authority.lastIndexOf(':');
    if (colonIndex === -1) {
      return { host: authority, port: this.config.defaultPort };
    }

    const host = authority.slice(0, colonIndex);
    const port = parseInt(authority.slice(colonIndex + 1), 10);

    return {
      host,
      port: isNaN(port) ? this.config.defaultPort : port,
    };
  }

  /**
   * Get client IP from stream.
   */
  private getClientIp(stream: http2.ServerHttp2Stream): string {
    const socket = stream.session?.socket;
    return socket?.remoteAddress ?? 'unknown';
  }

  /**
   * Get current statistics.
   */
  getStats(): GrpcStats {
    return {
      ...this.stats,
      requestsByService: new Map(this.stats.requestsByService),
      errorsByStatus: new Map(this.stats.errorsByStatus),
    };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats.totalRequests = 0;
    this.stats.activeStreams = 0;
    this.stats.messagesForwarded = 0;
    this.stats.bytesTransferred = 0;
    this.stats.requestsByService.clear();
    this.stats.errorsByStatus.clear();
    this.stats.requestsRejected = 0;
  }

  /**
   * Close all upstream connections.
   */
  closeAll(): void {
    for (const [key, conn] of this.upstreamConnections) {
      if (!conn.session.destroyed) {
        conn.session.close();
      }
    }
    this.upstreamConnections.clear();
  }

  /**
   * Get active connection count.
   */
  getActiveConnectionCount(): number {
    return this.upstreamConnections.size;
  }
}

/**
 * Create a gRPC handler.
 */
export function createGrpcHandler(config: GrpcHandlerConfig): GrpcHandler {
  return new GrpcHandler(config);
}

/**
 * Check if request headers indicate gRPC.
 */
export function isGrpcRequest(headers: http2.IncomingHttpHeaders | Record<string, string | string[] | undefined>): boolean {
  const contentType = headers['content-type'] ?? headers[HTTP2_HEADER_CONTENT_TYPE];
  return isGrpcContentType(contentType as string | undefined);
}
