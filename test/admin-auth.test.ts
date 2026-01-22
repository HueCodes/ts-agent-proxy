/**
 * Tests for the admin authentication module.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { AdminAuth, createAdminAuth, DEFAULT_ADMIN_AUTH_CONFIG } from '../src/admin/auth.js';
import type { AdminAuthConfig } from '../src/types/config.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

// Mock socket
function createMockSocket(remoteAddress = '127.0.0.1'): Socket {
  return {
    remoteAddress,
    destroy: vi.fn(),
  } as any;
}

// Mock request
function createMockRequest(options: {
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
}): IncomingMessage {
  const socket = createMockSocket(options.remoteAddress);
  return {
    url: options.url ?? '/health',
    headers: {
      host: 'localhost:9090',
      ...options.headers,
    },
    socket,
  } as any;
}

// Mock response
function createMockResponse(): ServerResponse & { body: string; statusCode: number } {
  const res: any = {
    statusCode: 200,
    body: '',
    headers: {} as Record<string, string>,
    writeHead: vi.fn((code, headers) => {
      res.statusCode = code;
      if (headers) Object.assign(res.headers, headers);
    }),
    end: vi.fn((data) => {
      res.body = data || '';
    }),
    setHeader: vi.fn((name, value) => {
      res.headers[name] = value;
    }),
  };
  return res;
}

// Mock logger
const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
  level: 'info',
} as any;

describe('AdminAuth', () => {
  describe('no authentication', () => {
    let auth: AdminAuth;

    beforeEach(() => {
      vi.clearAllMocks();
      auth = createAdminAuth({ method: 'none' }, mockLogger);
    });

    it('should allow all requests when method is none', async () => {
      const req = createMockRequest({ url: '/metrics' });
      const result = await auth.authenticate(req);

      expect(result.authenticated).toBe(true);
    });

    it('should allow health endpoint', async () => {
      const req = createMockRequest({ url: '/health' });
      const result = await auth.authenticate(req);

      expect(result.authenticated).toBe(true);
    });
  });

  describe('bearer token authentication', () => {
    let auth: AdminAuth;
    const validToken = 'super-secret-token-12345';

    beforeEach(() => {
      vi.clearAllMocks();
      auth = createAdminAuth(
        {
          method: 'bearer',
          bearerToken: validToken,
          protectedEndpoints: ['/metrics'],
        },
        mockLogger
      );
    });

    it('should authenticate with valid bearer token', async () => {
      const req = createMockRequest({
        url: '/metrics',
        headers: { authorization: `Bearer ${validToken}` },
      });
      const result = await auth.authenticate(req);

      expect(result.authenticated).toBe(true);
      expect(result.identity).toBe('bearer-token');
    });

    it('should reject with invalid bearer token', async () => {
      const req = createMockRequest({
        url: '/metrics',
        headers: { authorization: 'Bearer wrong-token' },
      });
      const result = await auth.authenticate(req);

      expect(result.authenticated).toBe(false);
      expect(result.reason).toBe('Invalid token');
    });

    it('should reject with missing authorization header', async () => {
      const req = createMockRequest({ url: '/metrics' });
      const result = await auth.authenticate(req);

      expect(result.authenticated).toBe(false);
      expect(result.reason).toContain('Missing Authorization');
    });

    it('should reject with malformed authorization header', async () => {
      const req = createMockRequest({
        url: '/metrics',
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      });
      const result = await auth.authenticate(req);

      expect(result.authenticated).toBe(false);
      expect(result.reason).toContain('Invalid Authorization');
    });

    it('should allow unprotected endpoints without auth', async () => {
      const req = createMockRequest({ url: '/health' });
      const result = await auth.authenticate(req);

      expect(result.authenticated).toBe(true);
    });
  });

  describe('API key authentication', () => {
    let auth: AdminAuth;
    const validApiKey = 'api-key-12345678901234';

    beforeEach(() => {
      vi.clearAllMocks();
      auth = createAdminAuth(
        {
          method: 'api-key',
          apiKey: validApiKey,
          apiKeyHeader: 'X-API-Key',
          protectedEndpoints: ['/metrics'],
        },
        mockLogger
      );
    });

    it('should authenticate with valid API key', async () => {
      const req = createMockRequest({
        url: '/metrics',
        headers: { 'x-api-key': validApiKey },
      });
      const result = await auth.authenticate(req);

      expect(result.authenticated).toBe(true);
      expect(result.identity).toBe('api-key');
    });

    it('should reject with invalid API key', async () => {
      const req = createMockRequest({
        url: '/metrics',
        headers: { 'x-api-key': 'wrong-key' },
      });
      const result = await auth.authenticate(req);

      expect(result.authenticated).toBe(false);
      expect(result.reason).toBe('Invalid API key');
    });

    it('should reject with missing API key', async () => {
      const req = createMockRequest({ url: '/metrics' });
      const result = await auth.authenticate(req);

      expect(result.authenticated).toBe(false);
      expect(result.reason).toContain('Missing');
    });
  });

  describe('IP allowlist authentication', () => {
    let auth: AdminAuth;

    beforeEach(() => {
      vi.clearAllMocks();
      auth = createAdminAuth(
        {
          method: 'ip-allowlist',
          allowedIps: ['192.168.1.1', '10.0.0.0/8', '127.0.0.1'],
          protectedEndpoints: ['/metrics'],
        },
        mockLogger
      );
    });

    it('should authenticate from allowed IP', async () => {
      const req = createMockRequest({
        url: '/metrics',
        remoteAddress: '192.168.1.1',
      });
      const result = await auth.authenticate(req);

      expect(result.authenticated).toBe(true);
      expect(result.identity).toContain('ip:');
    });

    it('should authenticate from CIDR range', async () => {
      const req = createMockRequest({
        url: '/metrics',
        remoteAddress: '10.1.2.3',
      });
      const result = await auth.authenticate(req);

      expect(result.authenticated).toBe(true);
    });

    it('should reject from disallowed IP', async () => {
      const req = createMockRequest({
        url: '/metrics',
        remoteAddress: '203.0.113.1',
      });
      const result = await auth.authenticate(req);

      expect(result.authenticated).toBe(false);
      expect(result.reason).toBe('IP not allowed');
    });

    it('should authenticate localhost', async () => {
      const req = createMockRequest({
        url: '/metrics',
        remoteAddress: '127.0.0.1',
      });
      const result = await auth.authenticate(req);

      expect(result.authenticated).toBe(true);
    });
  });

  describe('rate limiting', () => {
    let auth: AdminAuth;

    beforeEach(() => {
      vi.clearAllMocks();
      auth = createAdminAuth(
        {
          method: 'none',
          rateLimitPerMinute: 3,
        },
        mockLogger
      );
    });

    it('should allow requests under rate limit', async () => {
      const req = createMockRequest({ url: '/metrics' });

      for (let i = 0; i < 3; i++) {
        const result = await auth.authenticate(req);
        expect(result.authenticated).toBe(true);
      }
    });

    it('should reject requests over rate limit', async () => {
      const req = createMockRequest({ url: '/metrics' });

      // Consume the limit
      for (let i = 0; i < 3; i++) {
        await auth.authenticate(req);
      }

      // Next request should be rate limited
      const result = await auth.authenticate(req);
      expect(result.authenticated).toBe(false);
      expect(result.reason).toBe('Rate limit exceeded');
    });
  });

  describe('response helpers', () => {
    let auth: AdminAuth;

    beforeEach(() => {
      auth = createAdminAuth({ method: 'bearer', bearerToken: 'test-token-12345' }, mockLogger);
    });

    it('should send 401 Unauthorized', () => {
      const res = createMockResponse();
      auth.sendUnauthorized(res, 'Invalid token');

      expect(res.statusCode).toBe(401);
      expect(res.body).toContain('Unauthorized');
    });

    it('should send 403 Forbidden', () => {
      const res = createMockResponse();
      auth.sendForbidden(res, 'IP not allowed');

      expect(res.statusCode).toBe(403);
      expect(res.body).toContain('Forbidden');
    });

    it('should send 429 Rate Limited', () => {
      const res = createMockResponse();
      auth.sendRateLimited(res);

      expect(res.statusCode).toBe(429);
      expect(res.body).toContain('Too Many Requests');
    });
  });
});

describe('DEFAULT_ADMIN_AUTH_CONFIG', () => {
  it('should have sensible defaults', () => {
    expect(DEFAULT_ADMIN_AUTH_CONFIG.method).toBe('none');
    expect(DEFAULT_ADMIN_AUTH_CONFIG.protectedEndpoints).toContain('/metrics');
    expect(DEFAULT_ADMIN_AUTH_CONFIG.rateLimitPerMinute).toBe(60);
  });
});
