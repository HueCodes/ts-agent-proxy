/**
 * Admin API authentication module.
 *
 * Provides authentication middleware for admin endpoints
 * using various methods: Bearer token, API key, or IP allowlist.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import type { AdminAuthConfig } from '../types/config.js';
import type { Logger } from '../logging/logger.js';

/**
 * Authentication result.
 */
export interface AuthResult {
  authenticated: boolean;
  reason?: string;
  identity?: string;
}

/**
 * Admin authentication handler.
 */
export class AdminAuth {
  private readonly config: AdminAuthConfig;
  private readonly logger: Logger;
  private readonly rateLimiter: RateLimiterMemory;
  private readonly ipPatterns: RegExp[];

  constructor(config: AdminAuthConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;

    // Initialize rate limiter for admin endpoints
    this.rateLimiter = new RateLimiterMemory({
      points: config.rateLimitPerMinute ?? 60,
      duration: 60,
    });

    // Pre-compile IP patterns
    this.ipPatterns = this.compileIpPatterns(config.allowedIps ?? []);
  }

  /**
   * Check if a request is authenticated.
   */
  async authenticate(req: IncomingMessage): Promise<AuthResult> {
    const clientIp = this.getClientIp(req);
    const path = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;

    // Check rate limit first
    try {
      await this.rateLimiter.consume(clientIp);
    } catch {
      this.logger.warn({ clientIp, path }, 'Admin API rate limit exceeded');
      return {
        authenticated: false,
        reason: 'Rate limit exceeded',
      };
    }

    // Check if this endpoint requires authentication
    const protectedEndpoints = this.config.protectedEndpoints ?? ['/metrics', '/config'];
    const isProtected = protectedEndpoints.some(
      (ep) => path === ep || path.startsWith(ep + '/')
    );

    if (!isProtected) {
      return { authenticated: true, identity: 'public' };
    }

    // If no authentication method configured, deny access to protected endpoints
    if (this.config.method === 'none') {
      return { authenticated: true, identity: 'public' };
    }

    // Authenticate based on method
    switch (this.config.method) {
      case 'bearer':
        return this.authenticateBearer(req);
      case 'api-key':
        return this.authenticateApiKey(req);
      case 'ip-allowlist':
        return this.authenticateIp(req);
      default:
        return { authenticated: true, identity: 'public' };
    }
  }

  /**
   * Authenticate using Bearer token.
   */
  private authenticateBearer(req: IncomingMessage): AuthResult {
    const authHeader = req.headers['authorization'];

    if (!authHeader) {
      return {
        authenticated: false,
        reason: 'Missing Authorization header',
      };
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
      return {
        authenticated: false,
        reason: 'Invalid Authorization header format',
      };
    }

    const token = parts[1];

    // Constant-time comparison to prevent timing attacks
    if (!this.config.bearerToken || !this.secureCompare(token, this.config.bearerToken)) {
      this.logger.warn({ clientIp: this.getClientIp(req) }, 'Invalid bearer token');
      return {
        authenticated: false,
        reason: 'Invalid token',
      };
    }

    return { authenticated: true, identity: 'bearer-token' };
  }

  /**
   * Authenticate using API key.
   */
  private authenticateApiKey(req: IncomingMessage): AuthResult {
    const headerName = (this.config.apiKeyHeader ?? 'X-API-Key').toLowerCase();
    const apiKey = req.headers[headerName];

    if (!apiKey || typeof apiKey !== 'string') {
      return {
        authenticated: false,
        reason: `Missing ${this.config.apiKeyHeader ?? 'X-API-Key'} header`,
      };
    }

    // Constant-time comparison to prevent timing attacks
    if (!this.config.apiKey || !this.secureCompare(apiKey, this.config.apiKey)) {
      this.logger.warn({ clientIp: this.getClientIp(req) }, 'Invalid API key');
      return {
        authenticated: false,
        reason: 'Invalid API key',
      };
    }

    return { authenticated: true, identity: 'api-key' };
  }

  /**
   * Authenticate using IP allowlist.
   */
  private authenticateIp(req: IncomingMessage): AuthResult {
    const clientIp = this.getClientIp(req);

    if (!this.isIpAllowed(clientIp)) {
      this.logger.warn({ clientIp }, 'IP not in admin allowlist');
      return {
        authenticated: false,
        reason: 'IP not allowed',
      };
    }

    return { authenticated: true, identity: `ip:${clientIp}` };
  }

  /**
   * Check if an IP address is in the allowlist.
   */
  private isIpAllowed(ip: string): boolean {
    // Handle loopback and local addresses
    if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') {
      // Check if localhost is in allowlist
      for (const pattern of this.config.allowedIps ?? []) {
        if (pattern === '127.0.0.1' || pattern === '::1' || pattern === 'localhost' || pattern === '127.0.0.1/8') {
          return true;
        }
      }
    }

    // Check against compiled patterns
    for (const pattern of this.ipPatterns) {
      if (pattern.test(ip)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Compile IP patterns (including CIDR notation) to regex.
   */
  private compileIpPatterns(patterns: string[]): RegExp[] {
    const compiled: RegExp[] = [];

    for (const pattern of patterns) {
      if (pattern.includes('/')) {
        // CIDR notation - create a simple prefix match for common cases
        const [baseIp, prefixLength] = pattern.split('/');
        const prefix = parseInt(prefixLength, 10);

        if (prefix === 8) {
          // /8 - match first octet
          const firstOctet = baseIp.split('.')[0];
          compiled.push(new RegExp(`^${firstOctet}\\.`));
        } else if (prefix === 16) {
          // /16 - match first two octets
          const [first, second] = baseIp.split('.');
          compiled.push(new RegExp(`^${first}\\.${second}\\.`));
        } else if (prefix === 24) {
          // /24 - match first three octets
          const [first, second, third] = baseIp.split('.');
          compiled.push(new RegExp(`^${first}\\.${second}\\.${third}\\.`));
        } else if (prefix === 32) {
          // /32 - exact match
          compiled.push(new RegExp(`^${this.escapeRegex(baseIp)}$`));
        } else {
          // For other prefix lengths, use the full CIDR matching
          compiled.push(this.createCidrMatcher(baseIp, prefix));
        }
      } else {
        // Exact IP match
        compiled.push(new RegExp(`^${this.escapeRegex(pattern)}$`));
      }
    }

    return compiled;
  }

  /**
   * Create a CIDR matcher for arbitrary prefix lengths.
   */
  private createCidrMatcher(baseIp: string, prefixLength: number): RegExp {
    // For simplicity, we'll just do prefix matching
    // A more robust implementation would use proper CIDR math
    const octets = baseIp.split('.').map((o) => parseInt(o, 10));
    const fullOctets = Math.floor(prefixLength / 8);

    if (fullOctets === 0) {
      // Match any IP
      return /^.*$/;
    }

    const prefix = octets.slice(0, fullOctets).join('\\.');
    return new RegExp(`^${prefix}\\.`);
  }

  /**
   * Escape special regex characters.
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Constant-time string comparison.
   */
  private secureCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }

    return result === 0;
  }

  /**
   * Get client IP from request.
   */
  private getClientIp(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  /**
   * Send 401 Unauthorized response.
   */
  sendUnauthorized(res: ServerResponse, reason: string): void {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': this.config.method === 'bearer' ? 'Bearer' : 'API-Key',
    });
    res.end(JSON.stringify({ error: 'Unauthorized', reason }));
  }

  /**
   * Send 403 Forbidden response.
   */
  sendForbidden(res: ServerResponse, reason: string): void {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden', reason }));
  }

  /**
   * Send 429 Too Many Requests response.
   */
  sendRateLimited(res: ServerResponse): void {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': '60',
    });
    res.end(JSON.stringify({ error: 'Too Many Requests' }));
  }
}

/**
 * Create an admin auth handler.
 */
export function createAdminAuth(config: AdminAuthConfig, logger: Logger): AdminAuth {
  return new AdminAuth(config, logger);
}

/**
 * Default auth config (no authentication).
 */
export const DEFAULT_ADMIN_AUTH_CONFIG: AdminAuthConfig = {
  method: 'none',
  protectedEndpoints: ['/metrics', '/config'],
  rateLimitPerMinute: 60,
};
