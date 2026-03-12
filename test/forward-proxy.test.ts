import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { EventEmitter, PassThrough, Readable } from 'node:stream';
import { ForwardProxy, createForwardProxy } from '../src/proxy/forward-proxy.js';
import { DEFAULT_LIMITS, DEFAULT_TIMEOUTS } from '../src/types/config.js';
import type { MatchResult, AllowlistRule } from '../src/types/allowlist.js';

// Spy on http.request so we can mock its behavior per-test
let httpRequestSpy: ReturnType<typeof vi.spyOn>;

// ---- Mock helpers ----

function createMockLogger() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
  } as any;
}

function createMockAllowlistMatcher(defaultResult?: Partial<MatchResult>) {
  const result: MatchResult = {
    allowed: true,
    reason: 'Allowed by rule',
    matchedRule: { id: 'test-rule', domain: 'api.example.com' } as AllowlistRule,
    ...defaultResult,
  };
  return {
    match: vi.fn().mockReturnValue(result),
    isDomainAllowed: vi.fn().mockReturnValue(result),
    reload: vi.fn(),
  } as any;
}

function createMockRateLimiter(allowed = true) {
  return {
    consume: vi.fn().mockResolvedValue({
      allowed,
      remaining: allowed ? 99 : 0,
      resetMs: allowed ? 60000 : 5000,
      limit: 100,
      headers: {},
    }),
    registerRule: vi.fn(),
    getStats: vi.fn(),
  } as any;
}

function createMockAuditLogger() {
  return {
    logRequest: vi.fn(),
    logRateLimit: vi.fn(),
    logError: vi.fn(),
    close: vi.fn(),
  } as any;
}

/**
 * Create a mock IncomingMessage (client request).
 */
function createMockRequest(
  options: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    body?: string;
    remoteAddress?: string;
  } = {},
): http.IncomingMessage {
  const {
    method = 'GET',
    url = 'http://api.example.com/v1/data',
    headers = {},
    body,
    remoteAddress = '127.0.0.1',
  } = options;

  const readable = new PassThrough();
  const req = Object.assign(readable, {
    method,
    url,
    headers: {
      host: 'api.example.com',
      ...headers,
    },
    rawHeaders: Object.entries({ host: 'api.example.com', ...headers }).flatMap(([k, v]) => [k, v]),
    socket: { remoteAddress },
    httpVersion: '1.1',
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    complete: true,
    aborted: false,
    statusCode: undefined,
    statusMessage: undefined,
    trailers: {},
    rawTrailers: [],
    connection: { remoteAddress },
  }) as unknown as http.IncomingMessage;

  if (body !== undefined) {
    process.nextTick(() => {
      readable.write(Buffer.from(body));
      readable.end();
    });
  } else {
    process.nextTick(() => readable.end());
  }

  return req;
}

/**
 * Create a mock ServerResponse that captures writeHead and end calls.
 */
function createMockResponse(): http.ServerResponse & {
  _status: number | undefined;
  _headers: Record<string, any>;
  _body: string;
  _ended: boolean;
} {
  const res = {
    _status: undefined as number | undefined,
    _headers: {} as Record<string, any>,
    _body: '',
    _ended: false,
    headersSent: false,
    writeHead: vi.fn(function (this: any, statusCode: number, headers?: any) {
      this._status = statusCode;
      if (headers) Object.assign(this._headers, headers);
      this.headersSent = true;
      return this;
    }),
    setHeader: vi.fn(function (this: any, name: string, value: any) {
      this._headers[name] = value;
      return this;
    }),
    end: vi.fn(function (this: any, data?: string | Buffer) {
      if (data) this._body += data.toString();
      this._ended = true;
    }),
    write: vi.fn(function (this: any, data: string | Buffer) {
      this._body += data.toString();
      return true;
    }),
    on: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    emit: vi.fn().mockReturnThis(),
    removeListener: vi.fn().mockReturnThis(),
  };
  return res as any;
}

/**
 * Create a mock upstream response (proxyRes) as an EventEmitter/Readable.
 */
function createMockProxyResponse(
  options: {
    statusCode?: number;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): http.IncomingMessage {
  const { statusCode = 200, headers = {}, body = 'OK' } = options;
  const stream = new PassThrough();
  const proxyRes = Object.assign(stream, {
    statusCode,
    headers: { 'content-type': 'application/json', ...headers },
    rawHeaders: [],
    trailers: {},
    rawTrailers: [],
    httpVersion: '1.1',
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    complete: true,
    aborted: false,
    statusMessage: 'OK',
    connection: null,
    socket: null,
  }) as unknown as http.IncomingMessage;

  process.nextTick(() => {
    stream.write(Buffer.from(body));
    stream.end();
  });

  return proxyRes;
}

// ---- Mock http.request ----

vi.mock('node:http', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof http;
  return {
    ...actual,
    default: {
      ...actual,
      request: vi.fn(),
      Agent: actual.Agent,
    },
    request: vi.fn(),
    Agent: actual.Agent,
  };
});

vi.mock('node:https', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    default: {
      ...actual,
      request: vi.fn(),
      Agent: actual.Agent,
    },
    request: vi.fn(),
    Agent: actual.Agent,
  };
});

function setupMockHttpRequest(proxyRes?: http.IncomingMessage) {
  const mockProxyReq = new EventEmitter() as EventEmitter & {
    destroy: ReturnType<typeof vi.fn>;
    socket: any;
    end: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };
  (mockProxyReq as any).destroy = vi.fn();
  (mockProxyReq as any).socket = { reused: false };
  (mockProxyReq as any).end = vi.fn();
  (mockProxyReq as any).write = vi.fn();

  // Make it writable for pipe
  const writable = new PassThrough();
  (mockProxyReq as any).write = writable.write.bind(writable);
  (mockProxyReq as any).end = writable.end.bind(writable);
  // PassThrough pipe support
  (mockProxyReq as any)._write = writable._write.bind(writable);
  (mockProxyReq as any)._final = writable._final?.bind(writable);
  (mockProxyReq as any)._writableState = writable._writableState;
  (mockProxyReq as any).writable = true;

  // Merge EventEmitter with writable-like behavior
  const combined = Object.assign(writable, {
    destroy: vi.fn(),
    socket: { reused: false },
  });

  // Keep EventEmitter listeners
  const origOn = combined.on.bind(combined);
  combined.on = vi.fn((...args: any[]) => origOn(...args)) as any;

  const response = proxyRes ?? createMockProxyResponse();

  httpRequestSpy.mockImplementation((_opts: any, callback: any) => {
    process.nextTick(() => {
      // Emit socket event
      const socketEmitter = new EventEmitter();
      Object.assign(socketEmitter, { reused: false });
      combined.emit('socket', socketEmitter);
      process.nextTick(() => socketEmitter.emit('connect'));

      // Call the response callback
      if (callback) callback(response);
    });
    return combined;
  });

  return combined;
}

// ---- Tests ----

describe('ForwardProxy', () => {
  let proxy: ForwardProxy;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockAllowlistMatcher: ReturnType<typeof createMockAllowlistMatcher>;
  let mockRateLimiter: ReturnType<typeof createMockRateLimiter>;
  let mockAuditLogger: ReturnType<typeof createMockAuditLogger>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    httpRequestSpy = vi.spyOn(http, 'request');
    mockLogger = createMockLogger();
    mockAllowlistMatcher = createMockAllowlistMatcher();
    mockRateLimiter = createMockRateLimiter();
    mockAuditLogger = createMockAuditLogger();

    proxy = new ForwardProxy({
      allowlistMatcher: mockAllowlistMatcher,
      rateLimiter: mockRateLimiter,
      auditLogger: mockAuditLogger,
      logger: mockLogger,
    });
  });

  afterEach(() => {
    proxy.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ---------- 1. Construction ----------

  describe('construction', () => {
    it('should create with default limits and timeouts', () => {
      const p = new ForwardProxy({
        allowlistMatcher: mockAllowlistMatcher,
        rateLimiter: mockRateLimiter,
        auditLogger: mockAuditLogger,
        logger: mockLogger,
      });

      // Should not throw and pool stats should be accessible
      const stats = p.getPoolStats();
      expect(stats).toBeDefined();
      expect(stats.totalRequests).toBe(0);
      p.destroy();
    });

    it('should create with custom limits and timeouts', () => {
      const customLimits = { ...DEFAULT_LIMITS, maxRequestBodySize: 1024 };
      const customTimeouts = { ...DEFAULT_TIMEOUTS, connectTimeout: 5000 };

      const p = new ForwardProxy({
        allowlistMatcher: mockAllowlistMatcher,
        rateLimiter: mockRateLimiter,
        auditLogger: mockAuditLogger,
        logger: mockLogger,
        limits: customLimits,
        timeouts: customTimeouts,
      });

      expect(p.getPoolStats()).toBeDefined();
      p.destroy();
    });

    it('should accept connection pool configuration', () => {
      const p = new ForwardProxy({
        allowlistMatcher: mockAllowlistMatcher,
        rateLimiter: mockRateLimiter,
        auditLogger: mockAuditLogger,
        logger: mockLogger,
        connectionPool: { maxSocketsPerHost: 20 },
      });

      expect(p.getPoolStats()).toBeDefined();
      p.destroy();
    });
  });

  describe('createForwardProxy factory', () => {
    it('should create a ForwardProxy instance', () => {
      const p = createForwardProxy({
        allowlistMatcher: mockAllowlistMatcher,
        rateLimiter: mockRateLimiter,
        auditLogger: mockAuditLogger,
        logger: mockLogger,
      });
      expect(p).toBeInstanceOf(ForwardProxy);
      p.destroy();
    });
  });

  // ---------- 2. Allowed requests ----------

  describe('request handling for allowed domains', () => {
    it('should forward request to allowed domain and return 200', async () => {
      const mockProxyRes = createMockProxyResponse({ statusCode: 200, body: '{"ok":true}' });
      setupMockHttpRequest(mockProxyRes);

      const req = createMockRequest({ url: 'http://api.example.com/v1/data' });
      const res = createMockResponse();

      await proxy.handleRequest(req, res);

      expect(mockAllowlistMatcher.match).toHaveBeenCalled();
      expect(mockRateLimiter.consume).toHaveBeenCalled();
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    });

    it('should call auditLogger.logRequest on allowed request', async () => {
      setupMockHttpRequest(createMockProxyResponse());

      const req = createMockRequest();
      const res = createMockResponse();

      await proxy.handleRequest(req, res);

      expect(mockAuditLogger.logRequest).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'api.example.com' }),
        expect.objectContaining({ allowed: true }),
        expect.any(Number),
      );
    });
  });

  // ---------- 3. Denied requests (403) ----------

  describe('request handling for denied domains', () => {
    it('should return 403 when domain is not allowed', async () => {
      mockAllowlistMatcher.match.mockReturnValue({
        allowed: false,
        reason: 'Domain not in allowlist',
      });

      const req = createMockRequest({ url: 'http://evil.com/steal' });
      const res = createMockResponse();

      await proxy.handleRequest(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(
        403,
        expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      );
      const body403 = JSON.parse(res._body);
      expect(body403.error).toBe('DOMAIN_NOT_ALLOWED');
      expect(body403.message).toContain('not permitted');
      expect(body403.requestId).toBeDefined();
    });

    it('should log denied request to audit logger', async () => {
      mockAllowlistMatcher.match.mockReturnValue({
        allowed: false,
        reason: 'Domain not in allowlist',
      });

      const req = createMockRequest({ url: 'http://evil.com/steal' });
      const res = createMockResponse();

      await proxy.handleRequest(req, res);

      expect(mockAuditLogger.logRequest).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'evil.com' }),
        expect.objectContaining({ allowed: false }),
        expect.any(Number),
      );
    });

    it('should not call rate limiter when domain is denied', async () => {
      mockAllowlistMatcher.match.mockReturnValue({
        allowed: false,
        reason: 'Denied',
      });

      const req = createMockRequest({ url: 'http://evil.com/path' });
      const res = createMockResponse();

      await proxy.handleRequest(req, res);

      expect(mockRateLimiter.consume).not.toHaveBeenCalled();
    });
  });

  // ---------- 4. Header forwarding ----------

  describe('header forwarding', () => {
    it('should forward non-hop-by-hop headers', async () => {
      const mockProxyRes = createMockProxyResponse({
        headers: { 'x-custom': 'value', 'content-type': 'application/json' },
      });
      setupMockHttpRequest(mockProxyRes);

      const req = createMockRequest({
        headers: {
          'x-api-key': 'secret123',
          'content-type': 'application/json',
          accept: 'application/json',
        },
      });
      const res = createMockResponse();

      await proxy.handleRequest(req, res);

      const callArgs = httpRequestSpy.mock.calls[0]![0] as any;
      expect(callArgs.headers).toHaveProperty('x-api-key', 'secret123');
      expect(callArgs.headers).toHaveProperty('content-type', 'application/json');
      expect(callArgs.headers).toHaveProperty('accept', 'application/json');
    });

    it('should strip hop-by-hop headers from request', async () => {
      setupMockHttpRequest(createMockProxyResponse());

      const req = createMockRequest({
        headers: {
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'proxy-connection': 'keep-alive',
          'proxy-authorization': 'Basic abc',
          'transfer-encoding': 'chunked',
          te: 'trailers',
          upgrade: 'websocket',
          'x-real-header': 'value',
        },
      });
      const res = createMockResponse();

      await proxy.handleRequest(req, res);

      const callArgs = httpRequestSpy.mock.calls[0]![0] as any;
      expect(callArgs.headers).not.toHaveProperty('connection');
      expect(callArgs.headers).not.toHaveProperty('keep-alive');
      expect(callArgs.headers).not.toHaveProperty('proxy-connection');
      expect(callArgs.headers).not.toHaveProperty('proxy-authorization');
      expect(callArgs.headers).not.toHaveProperty('transfer-encoding');
      expect(callArgs.headers).not.toHaveProperty('te');
      expect(callArgs.headers).not.toHaveProperty('upgrade');
      expect(callArgs.headers).toHaveProperty('x-real-header', 'value');
    });

    it('should strip hop-by-hop headers from response', async () => {
      const mockProxyRes = createMockProxyResponse({
        headers: {
          'content-type': 'text/plain',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
          'x-custom-response': 'yes',
        },
      });
      setupMockHttpRequest(mockProxyRes);

      const req = createMockRequest();
      const res = createMockResponse();

      await proxy.handleRequest(req, res);

      expect(res.writeHead).toHaveBeenCalled();
      const writtenHeaders = (res.writeHead as any).mock.calls[0][1];
      expect(writtenHeaders).not.toHaveProperty('connection');
      expect(writtenHeaders).not.toHaveProperty('keep-alive');
      expect(writtenHeaders).not.toHaveProperty('transfer-encoding');
      expect(writtenHeaders).toHaveProperty('x-custom-response', 'yes');
    });
  });

  // ---------- 5. Error handling ----------

  describe('error handling', () => {
    it('should return 400 for invalid URL', async () => {
      const req = createMockRequest({ url: 'not-a-valid-url' });
      // Remove host header to ensure parseUrl fails
      req.headers = {};
      const res = createMockResponse();

      await proxy.handleRequest(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(
        400,
        expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      );
      const body400 = JSON.parse(res._body);
      expect(body400.error).toBe('INVALID_URL');
      expect(body400.message).toContain('Invalid request URL');
      expect(body400.requestId).toBeDefined();
    });

    it('should return 502 on upstream connection error', async () => {
      const combined = new PassThrough();
      Object.assign(combined, {
        destroy: vi.fn(() => combined.destroy()),
        socket: { reused: false },
      });

      httpRequestSpy.mockImplementation((_opts: any, _callback: any) => {
        process.nextTick(() => {
          combined.emit('error', new Error('ECONNREFUSED'));
        });
        return combined;
      });

      const req = createMockRequest();
      const res = createMockResponse();

      await proxy.handleRequest(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(
        502,
        expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      );
      const body502 = JSON.parse(res._body);
      expect(body502.error).toBe('UPSTREAM_ERROR');
      expect(body502.message).toContain('Failed to forward request');
      expect(body502.requestId).toBeDefined();
      expect(mockAuditLogger.logError).toHaveBeenCalled();
    });

    it('should return 504 on connect timeout', async () => {
      const p = new ForwardProxy({
        allowlistMatcher: mockAllowlistMatcher,
        rateLimiter: mockRateLimiter,
        auditLogger: mockAuditLogger,
        logger: mockLogger,
        timeouts: { ...DEFAULT_TIMEOUTS, connectTimeout: 100 },
      });

      const combined = new PassThrough();
      Object.assign(combined, {
        destroy: vi.fn(),
        socket: { reused: false },
      });

      httpRequestSpy.mockImplementation((_opts: any, _callback: any) => {
        // Don't call back or emit socket - simulate timeout
        return combined;
      });

      const req = createMockRequest();
      const res = createMockResponse();

      const handlePromise = p.handleRequest(req, res);
      await vi.advanceTimersByTimeAsync(200);
      await handlePromise;

      expect(res.writeHead).toHaveBeenCalledWith(
        504,
        expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      );
      const body504 = JSON.parse(res._body);
      expect(body504.error).toBe('GATEWAY_TIMEOUT');
      expect(body504.requestId).toBeDefined();
      p.destroy();
    });
  });

  // ---------- 6. Size limit enforcement ----------

  describe('size limit enforcement', () => {
    it('should return 414 for URL exceeding maxUrlLength', async () => {
      const longUrl = 'http://api.example.com/' + 'a'.repeat(DEFAULT_LIMITS.maxUrlLength + 1);
      const req = createMockRequest({ url: longUrl });
      const res = createMockResponse();

      await proxy.handleRequest(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(414, expect.any(Object));
    });

    it('should return 431 for headers exceeding maxHeaderSize', async () => {
      const p = new ForwardProxy({
        allowlistMatcher: mockAllowlistMatcher,
        rateLimiter: mockRateLimiter,
        auditLogger: mockAuditLogger,
        logger: mockLogger,
        limits: { ...DEFAULT_LIMITS, maxHeaderSize: 50 },
      });

      const req = createMockRequest({
        headers: { 'x-big-header': 'a'.repeat(200) },
      });
      const res = createMockResponse();

      await p.handleRequest(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(431, expect.any(Object));
      p.destroy();
    });

    it('should return 413 for Content-Length exceeding maxRequestBodySize', async () => {
      const p = new ForwardProxy({
        allowlistMatcher: mockAllowlistMatcher,
        rateLimiter: mockRateLimiter,
        auditLogger: mockAuditLogger,
        logger: mockLogger,
        limits: { ...DEFAULT_LIMITS, maxRequestBodySize: 100 },
      });

      const req = createMockRequest({
        method: 'POST',
        headers: { 'content-length': '9999999' },
      });
      const res = createMockResponse();

      await p.handleRequest(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(413, expect.any(Object));
      p.destroy();
    });

    it('should return 502 when response Content-Length exceeds maxResponseBodySize', async () => {
      const p = new ForwardProxy({
        allowlistMatcher: mockAllowlistMatcher,
        rateLimiter: mockRateLimiter,
        auditLogger: mockAuditLogger,
        logger: mockLogger,
        limits: { ...DEFAULT_LIMITS, maxResponseBodySize: 100 },
      });

      const mockProxyRes = createMockProxyResponse({
        headers: { 'content-length': '999999' },
        body: 'x'.repeat(200),
      });
      setupMockHttpRequest(mockProxyRes);

      const req = createMockRequest();
      const res = createMockResponse();

      await p.handleRequest(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(
        502,
        expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      );
      const bodyRespTooLarge = JSON.parse(res._body);
      expect(bodyRespTooLarge.error).toBe('RESPONSE_TOO_LARGE');
      expect(bodyRespTooLarge.message).toContain('size limit');
      expect(bodyRespTooLarge.requestId).toBeDefined();
      p.destroy();
    });
  });

  // ---------- 7. Rate limiting ----------

  describe('rate limiting integration', () => {
    it('should return 429 when rate limit is exceeded', async () => {
      mockRateLimiter.consume.mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetMs: 30000,
        limit: 100,
        headers: {},
      });

      const req = createMockRequest();
      const res = createMockResponse();

      await proxy.handleRequest(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(
        429,
        expect.objectContaining({
          'Content-Type': 'application/json',
          'Retry-After': '30',
        }),
      );
      const body429 = JSON.parse(res._body);
      expect(body429.error).toBe('RATE_LIMIT_EXCEEDED');
      expect(body429.message).toContain('Rate limit exceeded');
      expect(body429.requestId).toBeDefined();
    });

    it('should set Retry-After header when rate limited', async () => {
      mockRateLimiter.consume.mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetMs: 30000,
        limit: 100,
        headers: {},
      });

      const req = createMockRequest();
      const res = createMockResponse();

      await proxy.handleRequest(req, res);

      // Retry-After is now set via writeHead headers (as a string)
      const writeHeadArgs = (res.writeHead as any).mock.calls[0];
      expect(writeHeadArgs[0]).toBe(429);
      expect(writeHeadArgs[1]).toHaveProperty('Retry-After', '30');
    });

    it('should log rate limit to audit logger', async () => {
      mockRateLimiter.consume.mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetMs: 5000,
        limit: 100,
        headers: {},
      });

      const req = createMockRequest();
      const res = createMockResponse();

      await proxy.handleRequest(req, res);

      expect(mockAuditLogger.logRateLimit).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'api.example.com' }),
        expect.objectContaining({ allowed: false }),
        expect.any(Object),
      );
    });

    it('should use matched rule id as rate limit key prefix', async () => {
      const rule: AllowlistRule = { id: 'openai-rule', domain: 'api.openai.com' };
      mockAllowlistMatcher.match.mockReturnValue({
        allowed: true,
        reason: 'Matched',
        matchedRule: rule,
      });

      setupMockHttpRequest(createMockProxyResponse());

      const req = createMockRequest({ url: 'http://api.openai.com/v1/chat' });
      const res = createMockResponse();

      await proxy.handleRequest(req, res);

      expect(mockRateLimiter.consume).toHaveBeenCalledWith(
        expect.stringContaining('openai-rule'),
        'openai-rule',
      );
    });
  });

  // ---------- 8. Circuit breaker (not directly in ForwardProxy, but error paths) ----------

  describe('circuit breaker integration (error classification)', () => {
    it('should log errors for upstream failures', async () => {
      const combined = new PassThrough();
      Object.assign(combined, {
        destroy: vi.fn(() => combined.destroy()),
        socket: { reused: false },
      });

      httpRequestSpy.mockImplementation((_opts: any, _callback: any) => {
        process.nextTick(() => {
          combined.emit('error', new Error('ECONNRESET'));
        });
        return combined;
      });

      const req = createMockRequest();
      const res = createMockResponse();

      await proxy.handleRequest(req, res);

      expect(mockAuditLogger.logError).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'api.example.com' }),
        expect.any(Error),
      );
      expect(res.writeHead).toHaveBeenCalledWith(
        502,
        expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      );
    });
  });

  // ---------- 9. Connection pool usage ----------

  describe('connection pool usage', () => {
    it('should provide pool statistics via getPoolStats', () => {
      const stats = proxy.getPoolStats();
      expect(stats).toHaveProperty('totalSockets');
      expect(stats).toHaveProperty('totalFreeSockets');
      expect(stats).toHaveProperty('totalRequests');
      expect(stats).toHaveProperty('http');
      expect(stats).toHaveProperty('https');
    });

    it('should destroy the connection pool', () => {
      // Just verifying destroy doesn't throw
      const p = new ForwardProxy({
        allowlistMatcher: mockAllowlistMatcher,
        rateLimiter: mockRateLimiter,
        auditLogger: mockAuditLogger,
        logger: mockLogger,
      });
      expect(() => p.destroy()).not.toThrow();
    });

    it('should pass agent to http.request options', async () => {
      setupMockHttpRequest(createMockProxyResponse());

      const req = createMockRequest();
      const res = createMockResponse();

      await proxy.handleRequest(req, res);

      const callArgs = httpRequestSpy.mock.calls[0]![0] as any;
      expect(callArgs).toHaveProperty('agent');
      expect(callArgs.agent).toBeDefined();
    });
  });

  // ---------- 10. HTTP methods ----------

  describe('various HTTP methods', () => {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      it(`should forward ${method} requests`, async () => {
        setupMockHttpRequest(createMockProxyResponse());

        const req = createMockRequest({
          method,
          url: `http://api.example.com/v1/resource`,
          body: ['POST', 'PUT', 'PATCH'].includes(method) ? '{"data":1}' : undefined,
        });
        const res = createMockResponse();

        await proxy.handleRequest(req, res);

        const callArgs = httpRequestSpy.mock.calls[0]![0] as any;
        expect(callArgs.method).toBe(method);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      });
    }
  });

  // ---------- URL parsing ----------

  describe('URL parsing', () => {
    it('should parse absolute URLs', async () => {
      setupMockHttpRequest(createMockProxyResponse());

      const req = createMockRequest({ url: 'http://api.example.com/v1/test?q=1' });
      const res = createMockResponse();

      await proxy.handleRequest(req, res);

      const callArgs = httpRequestSpy.mock.calls[0]![0] as any;
      expect(callArgs.hostname).toBe('api.example.com');
      expect(callArgs.path).toBe('/v1/test?q=1');
    });

    it('should construct URL from Host header for relative URLs', async () => {
      setupMockHttpRequest(createMockProxyResponse());

      const req = createMockRequest({ url: '/v1/data' });
      req.headers.host = 'api.example.com';
      const res = createMockResponse();

      await proxy.handleRequest(req, res);

      const callArgs = httpRequestSpy.mock.calls[0]![0] as any;
      expect(callArgs.hostname).toBe('api.example.com');
      expect(callArgs.path).toBe('/v1/data');
    });

    it('should use default port 80 for http', async () => {
      setupMockHttpRequest(createMockProxyResponse());

      const req = createMockRequest({ url: 'http://api.example.com/test' });
      const res = createMockResponse();

      await proxy.handleRequest(req, res);

      const callArgs = httpRequestSpy.mock.calls[0]![0] as any;
      expect(callArgs.port).toBe(80);
    });
  });

  // ---------- Client IP extraction ----------

  describe('client IP extraction', () => {
    it('should use x-forwarded-for header when present', async () => {
      mockAllowlistMatcher.match.mockReturnValue({
        allowed: false,
        reason: 'Denied',
      });

      const req = createMockRequest({
        headers: { 'x-forwarded-for': '10.0.0.1, 10.0.0.2' },
      });
      const res = createMockResponse();

      await proxy.handleRequest(req, res);

      expect(mockAllowlistMatcher.match).toHaveBeenCalledWith(
        expect.objectContaining({ sourceIp: '10.0.0.1' }),
      );
    });

    it('should use socket remoteAddress when no x-forwarded-for', async () => {
      mockAllowlistMatcher.match.mockReturnValue({
        allowed: false,
        reason: 'Denied',
      });

      const req = createMockRequest({ remoteAddress: '192.168.1.100' });
      const res = createMockResponse();

      await proxy.handleRequest(req, res);

      expect(mockAllowlistMatcher.match).toHaveBeenCalledWith(
        expect.objectContaining({ sourceIp: '192.168.1.100' }),
      );
    });
  });
});
