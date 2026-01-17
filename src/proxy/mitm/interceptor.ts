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
import { CertManager, type CertificateInfo } from './cert-manager.js';

export interface MitmInterceptorOptions {
  allowlistMatcher: AllowlistMatcher;
  rateLimiter: RateLimiter;
  auditLogger: AuditLogger;
  logger: Logger;
  certManager: CertManager;
}

export class MitmInterceptor {
  private readonly options: MitmInterceptorOptions;

  constructor(options: MitmInterceptorOptions) {
    this.options = options;
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
    // Create a simple HTTP parser for the decrypted traffic
    let requestBuffer = Buffer.alloc(0);

    clientSocket.on('data', async (data: Buffer) => {
      requestBuffer = Buffer.concat([requestBuffer, data]);

      // Try to parse HTTP request
      const request = this.parseHttpRequest(requestBuffer.toString());
      if (!request) return;

      // Clear buffer after parsing
      requestBuffer = Buffer.alloc(0);

      const requestInfo: RequestInfo = {
        host: targetHost,
        port: targetPort,
        path: request.path,
        method: request.method,
        headers: request.headers,
        sourceIp,
      };

      const startTime = Date.now();

      // Check full allowlist (including path and method)
      const matchResult = this.options.allowlistMatcher.match(requestInfo);

      if (!matchResult.allowed) {
        this.options.auditLogger.logRequest(requestInfo, matchResult, Date.now() - startTime);
        const response = this.createErrorResponse(403, matchResult.reason);
        clientSocket.write(response);
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
        return;
      }

      // Forward the request
      await this.forwardRequest(clientSocket, targetHost, targetPort, request, requestInfo, startTime);
    });

    clientSocket.on('error', (error) => {
      this.options.logger.error({ error: error.message }, 'TLS socket error');
    });
  }

  /**
   * Forward the decrypted request to the target server.
   */
  private async forwardRequest(
    clientSocket: tls.TLSSocket,
    targetHost: string,
    targetPort: number,
    request: ParsedRequest,
    requestInfo: RequestInfo,
    startTime: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const options: https.RequestOptions = {
        hostname: targetHost,
        port: targetPort,
        path: request.path,
        method: request.method,
        headers: request.headers,
        rejectUnauthorized: true,
      };

      const proxyReq = https.request(options, (proxyRes) => {
        this.options.auditLogger.logRequest(
          requestInfo,
          { allowed: true, reason: 'Request forwarded (MITM)' },
          Date.now() - startTime
        );

        // Build response
        let response = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (value) {
            response += `${key}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`;
          }
        }
        response += '\r\n';

        clientSocket.write(response);
        proxyRes.pipe(clientSocket, { end: false });

        proxyRes.on('end', resolve);
        proxyRes.on('error', reject);
      });

      proxyReq.on('error', (error) => {
        this.options.logger.error({ error: error.message }, 'Proxy request failed');
        const response = this.createErrorResponse(502, 'Failed to reach target server');
        clientSocket.write(response);
        reject(error);
      });

      // Send request body if present
      if (request.body) {
        proxyReq.write(request.body);
      }
      proxyReq.end();
    });
  }

  /**
   * Parse an HTTP request from a string.
   */
  private parseHttpRequest(data: string): ParsedRequest | null {
    const headerEnd = data.indexOf('\r\n\r\n');
    if (headerEnd === -1) return null;

    const headerSection = data.slice(0, headerEnd);
    const body = data.slice(headerEnd + 4);

    const lines = headerSection.split('\r\n');
    const [method, path, version] = lines[0].split(' ');

    if (!method || !path) return null;

    const headers: Record<string, string> = {};
    for (let i = 1; i < lines.length; i++) {
      const colonIndex = lines[i].indexOf(':');
      if (colonIndex > 0) {
        const key = lines[i].slice(0, colonIndex).trim();
        const value = lines[i].slice(colonIndex + 1).trim();
        headers[key] = value;
      }
    }

    return { method, path, headers, body: body || undefined };
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

interface ParsedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Create a MITM interceptor.
 */
export function createMitmInterceptor(options: MitmInterceptorOptions): MitmInterceptor {
  return new MitmInterceptor(options);
}
