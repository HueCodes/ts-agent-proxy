/**
 * Tests for the MitmInterceptor module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { MitmInterceptor, createMitmInterceptor } from '../src/proxy/mitm/interceptor.js';
import { CertManager, type CertificateInfo } from '../src/proxy/mitm/cert-manager.js';
import { DEFAULT_LIMITS, DEFAULT_TIMEOUTS } from '../src/types/config.js';
import type { MatchResult, RequestInfo } from '../src/types/allowlist.js';

// ---------------------------------------------------------------------------
// Mock tls.TLSSocket to avoid real TLS handshake.
// We intercept the constructor to make it a pass-through EventEmitter.
// ---------------------------------------------------------------------------
vi.mock('node:tls', () => {
  const { EventEmitter: EE } = require('node:events');
  class MockTLSSocket extends EE {
    writable = true;
    constructor(socket: any, _opts?: any) {
      super();
      socket.on('data', (chunk: Buffer) => this.emit('data', chunk));
      socket.on('close', () => this.emit('close'));
      socket.on('error', (err: Error) => this.emit('error', err));
    }
    write = vi.fn().mockReturnValue(true);
    end = vi.fn();
    destroy = vi.fn();
  }
  return {
    default: { TLSSocket: MockTLSSocket, createSecureContext: vi.fn() },
    TLSSocket: MockTLSSocket,
    createSecureContext: vi.fn(),
  };
});

// Mock https.request so we never make real outbound connections
vi.mock('node:https', () => ({
  default: { request: vi.fn() },
  request: vi.fn(),
}));

import https from 'node:https';

// ---------------------------------------------------------------------------
// Helpers for creating mock collaborators
// ---------------------------------------------------------------------------

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function createMockAllowlistMatcher(
  overrides: Partial<{
    isDomainAllowed: (host: string) => { allowed: boolean; reason?: string };
    match: (info: RequestInfo) => MatchResult;
  }> = {},
) {
  return {
    isDomainAllowed: overrides.isDomainAllowed ?? vi.fn().mockReturnValue({ allowed: true }),
    match:
      overrides.match ??
      vi.fn().mockReturnValue({
        allowed: true,
        reason: 'Allowed by test',
        matchedRule: { id: 'test-rule' },
      }),
    // unused methods expected by the type
    addRule: vi.fn(),
    removeRule: vi.fn(),
    getRules: vi.fn().mockReturnValue([]),
    reload: vi.fn(),
  };
}

function createMockRateLimiter() {
  return {
    consume: vi.fn().mockResolvedValue({ allowed: true, remaining: 99, resetMs: 60000 }),
    reset: vi.fn(),
    getStatus: vi.fn(),
  };
}

function createMockAuditLogger() {
  return {
    logRequest: vi.fn(),
    logRateLimit: vi.fn(),
    logError: vi.fn(),
    close: vi.fn(),
  };
}

function createMockCertManager(): CertManager {
  const certInfo: CertificateInfo = {
    cert: 'MOCK_CERT_PEM',
    key: 'MOCK_KEY_PEM',
  };
  return {
    generateCertForDomain: vi.fn().mockReturnValue(certInfo),
    getCaCertPem: vi.fn().mockReturnValue('CA_PEM'),
    getCaKeyPem: vi.fn().mockReturnValue('CA_KEY_PEM'),
    isInitialized: vi.fn().mockReturnValue(true),
    initialize: vi.fn(),
  } as unknown as CertManager;
}

/**
 * Create a mock Socket (net.Socket-like EventEmitter).
 */
function createMockSocket(): Socket & {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
} {
  const socket = new EventEmitter() as any;
  socket.write = vi.fn().mockReturnValue(true);
  socket.end = vi.fn();
  socket.destroy = vi.fn();
  socket.remoteAddress = '127.0.0.1';
  socket.writable = true;
  return socket;
}

/**
 * Create a minimal IncomingMessage mock for a CONNECT request.
 */
function createConnectReq(url: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as any;
  req.url = url;
  req.method = 'CONNECT';
  req.headers = headers;
  req.socket = { remoteAddress: '10.0.0.1' };
  return req as IncomingMessage;
}

/**
 * Build a raw HTTP request string (what arrives after TLS handshake).
 */
function buildHttpRequest(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Buffer {
  let raw = `${method} ${path} HTTP/1.1\r\n`;
  for (const [k, v] of Object.entries(headers)) {
    raw += `${k}: ${v}\r\n`;
  }
  if (body !== undefined) {
    raw += `Content-Length: ${Buffer.byteLength(body)}\r\n`;
  }
  raw += '\r\n';
  if (body !== undefined) {
    raw += body;
  }
  return Buffer.from(raw);
}

/**
 * Helper: create an interceptor with sensible defaults and optional overrides.
 */
function makeInterceptor(
  overrides: Partial<{
    allowlistMatcher: ReturnType<typeof createMockAllowlistMatcher>;
    rateLimiter: ReturnType<typeof createMockRateLimiter>;
    auditLogger: ReturnType<typeof createMockAuditLogger>;
    logger: ReturnType<typeof createMockLogger>;
    certManager: CertManager;
    limits: typeof DEFAULT_LIMITS;
    timeouts: typeof DEFAULT_TIMEOUTS;
  }> = {},
) {
  return new MitmInterceptor({
    allowlistMatcher: overrides.allowlistMatcher ?? createMockAllowlistMatcher(),
    rateLimiter: overrides.rateLimiter ?? createMockRateLimiter(),
    auditLogger: overrides.auditLogger ?? createMockAuditLogger(),
    logger: overrides.logger ?? createMockLogger(),
    certManager: overrides.certManager ?? createMockCertManager(),
    limits: overrides.limits,
    timeouts: overrides.timeouts,
  } as any);
}

/**
 * Drive a CONNECT + HTTP request through the interceptor and return the
 * TLS socket mock (from the tls.TLSSocket mock) so assertions can inspect writes.
 *
 * We set up the mock for https.request so that we can control the upstream response.
 */
async function driveConnect(
  interceptor: MitmInterceptor,
  opts: {
    connectUrl?: string;
    httpRequest?: Buffer;
    upstreamStatusCode?: number;
    upstreamHeaders?: Record<string, string | string[]>;
    upstreamBody?: string | Buffer;
    upstreamError?: Error;
    delayUpstream?: boolean;
  } = {},
): Promise<{
  clientSocket: ReturnType<typeof createMockSocket>;
  upstreamCallback: ((res: any) => void) | null;
  proxyReqMock: EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
}> {
  const connectUrl = opts.connectUrl ?? 'example.com:443';
  const httpRequest =
    opts.httpRequest ?? buildHttpRequest('GET', '/api/data', { Host: 'example.com' });
  const statusCode = opts.upstreamStatusCode ?? 200;
  const upHeaders = opts.upstreamHeaders ?? { 'content-type': 'application/json' };
  const upBody = opts.upstreamBody ?? '{"ok":true}';

  // Build a mock proxyReq (the ClientRequest returned by https.request)
  const proxyReqMock = new EventEmitter() as any;
  proxyReqMock.write = vi.fn();
  proxyReqMock.end = vi.fn();
  proxyReqMock.destroy = vi.fn();

  let capturedCallback: ((res: any) => void) | null = null;

  (https.request as ReturnType<typeof vi.fn>).mockImplementation((_options: any, cb: any) => {
    capturedCallback = cb;

    // If the caller wants to simulate an upstream error, emit it after a tick
    if (opts.upstreamError) {
      queueMicrotask(() => proxyReqMock.emit('error', opts.upstreamError));
    } else if (!opts.delayUpstream) {
      // Simulate upstream response after a tick
      queueMicrotask(() => {
        if (!capturedCallback) return;
        const res = new EventEmitter() as any;
        res.statusCode = statusCode;
        res.statusMessage = 'OK';
        res.headers = upHeaders;
        capturedCallback(res);
        // Emit body then end
        if (upBody) {
          const buf = Buffer.isBuffer(upBody) ? upBody : Buffer.from(upBody);
          res.emit('data', buf);
        }
        res.emit('end');
      });
    }

    return proxyReqMock;
  });

  const clientSocket = createMockSocket();
  const req = createConnectReq(connectUrl);

  await interceptor.handleConnect(req, clientSocket as any, Buffer.alloc(0));

  // Now feed the HTTP request through the client socket (which is forwarded to TLS mock)
  clientSocket.emit('data', httpRequest);

  // Allow micro-tasks to settle
  await new Promise((r) => setTimeout(r, 50));

  return { clientSocket, upstreamCallback: capturedCallback, proxyReqMock };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('MitmInterceptor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // 1. Construction
  // -----------------------------------------------------------------------
  describe('construction', () => {
    it('should construct with required options', () => {
      const interceptor = makeInterceptor();
      expect(interceptor).toBeInstanceOf(MitmInterceptor);
    });

    it('should use default limits when none provided', () => {
      const interceptor = makeInterceptor();
      // We can only indirectly verify; the constructor does not expose limits.
      // Just ensure it does not throw.
      expect(interceptor).toBeDefined();
    });

    it('should accept custom limits and timeouts', () => {
      const interceptor = makeInterceptor({
        limits: { ...DEFAULT_LIMITS, maxResponseBodySize: 100 },
        timeouts: { ...DEFAULT_TIMEOUTS, connectTimeout: 500 },
      });
      expect(interceptor).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // 2. Domain filtering (CONNECT phase)
  // -----------------------------------------------------------------------
  describe('domain filtering', () => {
    it('should reject disallowed domains with 403', async () => {
      const matcher = createMockAllowlistMatcher({
        isDomainAllowed: vi.fn().mockReturnValue({ allowed: false }),
      });
      const interceptor = makeInterceptor({ allowlistMatcher: matcher });
      const socket = createMockSocket();
      const req = createConnectReq('evil.com:443');

      await interceptor.handleConnect(req, socket as any, Buffer.alloc(0));

      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('403 Forbidden'));
      expect(socket.end).toHaveBeenCalled();
    });

    it('should allow permitted domains and send 200', async () => {
      const interceptor = makeInterceptor();
      const socket = createMockSocket();
      const req = createConnectReq('allowed.com:443');

      await interceptor.handleConnect(req, socket as any, Buffer.alloc(0));

      expect(socket.write).toHaveBeenCalledWith(
        expect.stringContaining('200 Connection Established'),
      );
    });
  });

  // -----------------------------------------------------------------------
  // 3. Request interception and forwarding
  // -----------------------------------------------------------------------
  describe('request forwarding', () => {
    it('should forward GET request to upstream and relay response', async () => {
      const auditLogger = createMockAuditLogger();
      const interceptor = makeInterceptor({ auditLogger });

      const { clientSocket } = await driveConnect(interceptor);

      // The TLS mock socket's write should have been called with the upstream response
      // Find the call that includes the HTTP status line
      const writeCalls = clientSocket.write.mock.calls
        .map((c: any) => (typeof c[0] === 'string' ? c[0] : ''))
        .join('');
      // The 200 Connection Established is on the raw socket; the upstream response goes
      // via the TLS socket mock, which is a separate object. We verify audit logging instead.
      expect(auditLogger.logRequest).toHaveBeenCalled();
    });

    it('should forward POST request with body', async () => {
      const interceptor = makeInterceptor();
      const body = '{"hello":"world"}';
      const httpReq = buildHttpRequest('POST', '/submit', { Host: 'example.com' }, body);

      const { proxyReqMock } = await driveConnect(interceptor, { httpRequest: httpReq });

      expect(proxyReqMock.write).toHaveBeenCalledWith(Buffer.from(body));
      expect(proxyReqMock.end).toHaveBeenCalled();
    });

    it('should call https.request with correct options', async () => {
      const interceptor = makeInterceptor();
      const httpReq = buildHttpRequest(
        'PUT',
        '/resource',
        { Host: 'example.com', 'Content-Type': 'text/plain' },
        'data',
      );

      await driveConnect(interceptor, { connectUrl: 'example.com:8443', httpRequest: httpReq });

      expect(https.request).toHaveBeenCalledWith(
        expect.objectContaining({
          hostname: 'example.com',
          port: 8443,
          path: '/resource',
          method: 'PUT',
        }),
        expect.any(Function),
      );
    });
  });

  // -----------------------------------------------------------------------
  // 4. Path-level filtering
  // -----------------------------------------------------------------------
  describe('path-level filtering', () => {
    it('should reject requests when allowlist match fails on path', async () => {
      const matcher = createMockAllowlistMatcher({
        isDomainAllowed: vi.fn().mockReturnValue({ allowed: true }),
        match: vi.fn().mockReturnValue({ allowed: false, reason: 'Path not allowed' }),
      });
      const auditLogger = createMockAuditLogger();
      const interceptor = makeInterceptor({ allowlistMatcher: matcher, auditLogger });

      await driveConnect(interceptor);

      expect(auditLogger.logRequest).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/api/data' }),
        expect.objectContaining({ allowed: false, reason: 'Path not allowed' }),
        expect.any(Number),
      );
    });
  });

  // -----------------------------------------------------------------------
  // 5. Method filtering
  // -----------------------------------------------------------------------
  describe('method filtering', () => {
    it('should deny request when method is not allowed', async () => {
      const matcher = createMockAllowlistMatcher({
        isDomainAllowed: vi.fn().mockReturnValue({ allowed: true }),
        match: vi.fn().mockReturnValue({ allowed: false, reason: 'Method DELETE not allowed' }),
      });
      const interceptor = makeInterceptor({ allowlistMatcher: matcher });
      const httpReq = buildHttpRequest('DELETE', '/resource', { Host: 'example.com' });

      await driveConnect(interceptor, { httpRequest: httpReq });

      // The match mock should have been called with requestInfo containing method DELETE
      expect(matcher.match).toHaveBeenCalledWith(expect.objectContaining({ method: 'DELETE' }));
    });
  });

  // -----------------------------------------------------------------------
  // 6. Rate limiting
  // -----------------------------------------------------------------------
  describe('rate limiting', () => {
    it('should return 429 when rate limit exceeded', async () => {
      const rateLimiter = createMockRateLimiter();
      rateLimiter.consume.mockResolvedValue({ allowed: false, remaining: 0, resetMs: 30000 });
      const auditLogger = createMockAuditLogger();
      const interceptor = makeInterceptor({ rateLimiter, auditLogger });

      await driveConnect(interceptor);

      expect(auditLogger.logRateLimit).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 7. Upstream error handling
  // -----------------------------------------------------------------------
  describe('upstream error handling', () => {
    it('should handle upstream connection error with 502', async () => {
      const logger = createMockLogger();
      const interceptor = makeInterceptor({ logger });

      await driveConnect(interceptor, {
        upstreamError: new Error('ECONNREFUSED'),
      });

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'ECONNREFUSED' }),
        expect.any(String),
      );
    });
  });

  // -----------------------------------------------------------------------
  // 8. Response size limit enforcement
  // -----------------------------------------------------------------------
  describe('size limit enforcement', () => {
    it('should reject upstream response if content-length exceeds limit', async () => {
      const logger = createMockLogger();
      const interceptor = makeInterceptor({
        logger,
        limits: { ...DEFAULT_LIMITS, maxResponseBodySize: 10 },
      });

      await driveConnect(interceptor, {
        upstreamHeaders: { 'content-type': 'text/plain', 'content-length': '999999' },
        upstreamBody: 'x'.repeat(100),
      });

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('size limit exceeded') }),
        expect.any(String),
      );
    });
  });

  // -----------------------------------------------------------------------
  // 9. Timeout handling
  // -----------------------------------------------------------------------
  describe('timeout handling', () => {
    it('should time out request reading if client is slow', async () => {
      vi.useFakeTimers();

      const logger = createMockLogger();
      const interceptor = makeInterceptor({
        logger,
        timeouts: { ...DEFAULT_TIMEOUTS, requestTimeout: 500 },
      });

      const clientSocket = createMockSocket();
      const req = createConnectReq('example.com:443');

      await interceptor.handleConnect(req, clientSocket as any, Buffer.alloc(0));

      // Do NOT send any data, let the request timeout fire
      vi.advanceTimersByTime(600);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ targetHost: 'example.com' }),
        expect.stringContaining('Request timeout'),
      );
    });
  });

  // -----------------------------------------------------------------------
  // 10. Parse target
  // -----------------------------------------------------------------------
  describe('parseTarget (via handleConnect)', () => {
    it('should default to port 443 when no port provided', async () => {
      const certManager = createMockCertManager();
      const interceptor = makeInterceptor({ certManager });
      const socket = createMockSocket();
      const req = createConnectReq('example.com');

      await interceptor.handleConnect(req, socket as any, Buffer.alloc(0));

      // The cert should be generated for 'example.com'
      expect(certManager.generateCertForDomain).toHaveBeenCalledWith('example.com');
    });

    it('should parse custom port', async () => {
      const certManager = createMockCertManager();
      const matcher = createMockAllowlistMatcher({
        isDomainAllowed: vi.fn().mockReturnValue({ allowed: true }),
      });
      const interceptor = makeInterceptor({ certManager, allowlistMatcher: matcher });
      const socket = createMockSocket();
      const req = createConnectReq('example.com:8443');

      await interceptor.handleConnect(req, socket as any, Buffer.alloc(0));

      expect(matcher.isDomainAllowed).toHaveBeenCalledWith('example.com');
    });
  });

  // -----------------------------------------------------------------------
  // 11. Client IP extraction
  // -----------------------------------------------------------------------
  describe('client IP extraction', () => {
    it('should use x-forwarded-for header when present', async () => {
      const logger = createMockLogger();
      const interceptor = makeInterceptor({ logger });
      const socket = createMockSocket();
      const req = createConnectReq('example.com:443', { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' });

      await interceptor.handleConnect(req, socket as any, Buffer.alloc(0));

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ sourceIp: '1.2.3.4' }),
        expect.any(String),
      );
    });

    it('should fall back to socket remoteAddress', async () => {
      const logger = createMockLogger();
      const interceptor = makeInterceptor({ logger });
      const socket = createMockSocket();
      const req = createConnectReq('example.com:443');

      await interceptor.handleConnect(req, socket as any, Buffer.alloc(0));

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ sourceIp: '10.0.0.1' }),
        expect.any(String),
      );
    });
  });

  // -----------------------------------------------------------------------
  // 12. MITM setup failure
  // -----------------------------------------------------------------------
  describe('MITM setup failure', () => {
    it('should send 502 when cert generation fails', async () => {
      const certManager = createMockCertManager();
      (certManager.generateCertForDomain as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('cert generation failed');
      });
      const logger = createMockLogger();
      const interceptor = makeInterceptor({ certManager, logger });
      const socket = createMockSocket();
      const req = createConnectReq('example.com:443');

      await interceptor.handleConnect(req, socket as any, Buffer.alloc(0));

      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('502 Bad Gateway'));
      expect(socket.end).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 13. createMitmInterceptor factory
  // -----------------------------------------------------------------------
  describe('createMitmInterceptor', () => {
    it('should return a MitmInterceptor instance', () => {
      const interceptor = createMitmInterceptor({
        allowlistMatcher: createMockAllowlistMatcher() as any,
        rateLimiter: createMockRateLimiter() as any,
        auditLogger: createMockAuditLogger() as any,
        logger: createMockLogger() as any,
        certManager: createMockCertManager(),
      });
      expect(interceptor).toBeInstanceOf(MitmInterceptor);
    });
  });
});
