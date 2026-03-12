import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import http2 from 'node:http2';
import {
  GrpcWebHandler,
  createGrpcWebHandler,
  isGrpcWebRequest,
} from '../src/proxy/grpc-web-handler.js';
import { GrpcStatus, GRPC_FRAME_HEADER_SIZE } from '../src/proxy/grpc-parser.js';

// ---- mock factories ----

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'debug',
    silent: vi.fn(),
  } as any;
}

function createMockAuditLogger() {
  return {
    logRequest: vi.fn(),
    logRateLimit: vi.fn(),
    logError: vi.fn(),
  } as any;
}

function createMockAllowlistMatcher(overrides: Partial<{ allowed: boolean; reason: string; matchedRule: any }> = {}) {
  const { allowed = true, reason = 'Allowed by rule', matchedRule = undefined } = overrides;
  return {
    match: vi.fn().mockReturnValue({ allowed, reason, matchedRule }),
  } as any;
}

function createMockRateLimiter(overrides: Partial<{ allowed: boolean }> = {}) {
  const { allowed = true } = overrides;
  return {
    consume: vi.fn().mockResolvedValue({
      allowed,
      remaining: 10,
      resetMs: 60000,
      limit: 100,
    }),
  } as any;
}

function createMockReq(overrides: Record<string, any> = {}) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    url: '/package.Service/Method',
    method: 'POST',
    headers: {
      'content-type': 'application/grpc-web',
      host: 'localhost:50051',
    },
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  }) as any;
}

function createMockRes() {
  return {
    setHeader: vi.fn(),
    end: vi.fn(),
    headersSent: false,
    statusCode: 200,
  } as any;
}

function createMockUpstreamStream() {
  const stream = new EventEmitter();
  Object.assign(stream, {
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
    destroyed: false,
    sentTrailers: {},
  });
  return stream as any;
}

function createDefaultConfig(overrides: Record<string, any> = {}) {
  return {
    allowlistMatcher: createMockAllowlistMatcher(),
    rateLimiter: createMockRateLimiter(),
    auditLogger: createMockAuditLogger(),
    logger: createMockLogger(),
    ...overrides,
  };
}

// ---- tests ----

describe('GrpcWebHandler', () => {
  let handler: GrpcWebHandler;
  let mockAllowlistMatcher: ReturnType<typeof createMockAllowlistMatcher>;
  let mockRateLimiter: ReturnType<typeof createMockRateLimiter>;
  let mockAuditLogger: ReturnType<typeof createMockAuditLogger>;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockAllowlistMatcher = createMockAllowlistMatcher();
    mockRateLimiter = createMockRateLimiter();
    mockAuditLogger = createMockAuditLogger();
    mockLogger = createMockLogger();
    handler = new GrpcWebHandler({
      allowlistMatcher: mockAllowlistMatcher,
      rateLimiter: mockRateLimiter,
      auditLogger: mockAuditLogger,
      logger: mockLogger,
    });
  });

  afterEach(() => {
    handler.closeAll();
  });

  // ---- isGrpcWebRequest ----

  describe('isGrpcWebRequest', () => {
    it('should return true for application/grpc-web', () => {
      const req = createMockReq({ headers: { 'content-type': 'application/grpc-web' } });
      expect(handler.isGrpcWebRequest(req)).toBe(true);
    });

    it('should return true for application/grpc-web+proto', () => {
      const req = createMockReq({ headers: { 'content-type': 'application/grpc-web+proto' } });
      expect(handler.isGrpcWebRequest(req)).toBe(true);
    });

    it('should return true for application/grpc-web-text', () => {
      const req = createMockReq({ headers: { 'content-type': 'application/grpc-web-text' } });
      expect(handler.isGrpcWebRequest(req)).toBe(true);
    });

    it('should return true for application/grpc-web-text+proto', () => {
      const req = createMockReq({ headers: { 'content-type': 'application/grpc-web-text+proto' } });
      expect(handler.isGrpcWebRequest(req)).toBe(true);
    });

    it('should return false for application/json', () => {
      const req = createMockReq({ headers: { 'content-type': 'application/json' } });
      expect(handler.isGrpcWebRequest(req)).toBe(false);
    });

    it('should return false for application/grpc (not grpc-web)', () => {
      const req = createMockReq({ headers: { 'content-type': 'application/grpc' } });
      expect(handler.isGrpcWebRequest(req)).toBe(false);
    });

    it('should return false when content-type is missing', () => {
      const req = createMockReq({ headers: {} });
      expect(handler.isGrpcWebRequest(req)).toBe(false);
    });
  });

  // ---- handleRequest ----

  describe('handleRequest', () => {
    it('should reject requests with invalid gRPC path', async () => {
      const req = createMockReq({ url: '/invalid' });
      const res = createMockRes();

      await handler.handleRequest(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/grpc-web');
      expect(res.end).toHaveBeenCalled();

      // Verify the trailer frame contains INVALID_ARGUMENT status
      const body = res.end.mock.calls[0][0] as Buffer;
      expect(body[0]).toBe(0x80); // trailer flag
      const trailerLen = body.readUInt32BE(1);
      const trailerStr = body.slice(GRPC_FRAME_HEADER_SIZE, GRPC_FRAME_HEADER_SIZE + trailerLen).toString('utf-8');
      expect(trailerStr).toContain(`grpc-status: ${GrpcStatus.INVALID_ARGUMENT}`);
      expect(trailerStr).toContain('Invalid%20gRPC%20path');
    });

    it('should reject requests with path that has too many segments', async () => {
      const req = createMockReq({ url: '/a/b/c' });
      const res = createMockRes();

      await handler.handleRequest(req, res);

      const body = res.end.mock.calls[0][0] as Buffer;
      const trailerStr = body.slice(GRPC_FRAME_HEADER_SIZE).toString('utf-8');
      expect(trailerStr).toContain(`grpc-status: ${GrpcStatus.INVALID_ARGUMENT}`);
    });

    it('should reject requests when allowlist denies', async () => {
      mockAllowlistMatcher.match.mockReturnValue({ allowed: false, reason: 'Domain not allowed' });

      const req = createMockReq();
      const res = createMockRes();

      await handler.handleRequest(req, res);

      const body = res.end.mock.calls[0][0] as Buffer;
      const trailerStr = body.slice(GRPC_FRAME_HEADER_SIZE).toString('utf-8');
      expect(trailerStr).toContain(`grpc-status: ${GrpcStatus.PERMISSION_DENIED}`);
      expect(trailerStr).toContain('Domain%20not%20allowed');
      expect(mockAuditLogger.logRequest).toHaveBeenCalled();
    });

    it('should reject requests when gRPC matcher denies', async () => {
      // Allowlist allows, but with a grpc rule that the matcher will evaluate
      mockAllowlistMatcher.match.mockReturnValue({
        allowed: true,
        reason: 'Allowed',
        matchedRule: {
          id: 'test-rule',
          domain: 'localhost',
          grpc: { services: ['other.Service'] },
        },
      });

      const req = createMockReq();
      const res = createMockRes();

      await handler.handleRequest(req, res);

      const body = res.end.mock.calls[0][0] as Buffer;
      const trailerStr = body.slice(GRPC_FRAME_HEADER_SIZE).toString('utf-8');
      expect(trailerStr).toContain(`grpc-status: ${GrpcStatus.PERMISSION_DENIED}`);
      expect(mockAuditLogger.logRequest).toHaveBeenCalled();
    });

    it('should reject requests when rate limited', async () => {
      mockRateLimiter.consume.mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetMs: 30000,
        limit: 100,
      });

      const req = createMockReq();
      const res = createMockRes();

      await handler.handleRequest(req, res);

      const body = res.end.mock.calls[0][0] as Buffer;
      const trailerStr = body.slice(GRPC_FRAME_HEADER_SIZE).toString('utf-8');
      expect(trailerStr).toContain(`grpc-status: ${GrpcStatus.RESOURCE_EXHAUSTED}`);
      expect(trailerStr).toContain('Rate%20limit%20exceeded');
      expect(mockAuditLogger.logRateLimit).toHaveBeenCalled();
    });

    it('should increment requestsRejected for denied allowlist', async () => {
      mockAllowlistMatcher.match.mockReturnValue({ allowed: false, reason: 'Denied' });
      const req = createMockReq();
      const res = createMockRes();

      await handler.handleRequest(req, res);

      expect(handler.getStats().requestsRejected).toBe(1);
    });

    it('should increment requestsRejected for rate limited', async () => {
      mockRateLimiter.consume.mockResolvedValue({ allowed: false, remaining: 0, resetMs: 0, limit: 10 });
      const req = createMockReq();
      const res = createMockRes();

      await handler.handleRequest(req, res);

      expect(handler.getStats().requestsRejected).toBe(1);
    });

    it('should increment textRequests for grpc-web-text content type', async () => {
      mockAllowlistMatcher.match.mockReturnValue({ allowed: false, reason: 'Denied' });
      const req = createMockReq({
        headers: { 'content-type': 'application/grpc-web-text', host: 'localhost:50051' },
      });
      const res = createMockRes();

      await handler.handleRequest(req, res);

      expect(handler.getStats().textRequests).toBe(1);
      expect(handler.getStats().binaryRequests).toBe(0);
    });

    it('should increment binaryRequests for grpc-web content type', async () => {
      mockAllowlistMatcher.match.mockReturnValue({ allowed: false, reason: 'Denied' });
      const req = createMockReq();
      const res = createMockRes();

      await handler.handleRequest(req, res);

      expect(handler.getStats().binaryRequests).toBe(1);
      expect(handler.getStats().textRequests).toBe(0);
    });

    it('should use base64 encoding for error responses in text mode', async () => {
      mockAllowlistMatcher.match.mockReturnValue({ allowed: false, reason: 'Denied' });
      const req = createMockReq({
        headers: { 'content-type': 'application/grpc-web-text', host: 'localhost:50051' },
      });
      const res = createMockRes();

      await handler.handleRequest(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/grpc-web-text');
      // The body should be base64-encoded
      const body = res.end.mock.calls[0][0] as Buffer;
      const decoded = Buffer.from(body.toString('utf-8'), 'base64');
      expect(decoded[0]).toBe(0x80); // trailer flag after decoding
    });

    it('should proxy to upstream on successful validation', async () => {
      const mockStream = createMockUpstreamStream();
      const mockSession = new EventEmitter();
      Object.assign(mockSession, {
        request: vi.fn().mockReturnValue(mockStream),
        destroyed: false,
        closed: false,
        close: vi.fn(),
      });

      vi.spyOn(http2, 'connect').mockReturnValue(mockSession as any);

      const req = createMockReq();
      const res = createMockRes();

      const handlePromise = handler.handleRequest(req, res);

      // Simulate request body
      process.nextTick(() => {
        req.emit('data', Buffer.from('test-body'));
        req.emit('end');
      });

      // Wait for upstream request to be set up, then simulate response
      await vi.waitFor(() => {
        expect((mockSession as any).request).toHaveBeenCalled();
      });

      process.nextTick(() => {
        mockStream.emit('response', {});
        mockStream.emit('data', Buffer.from('response-data'));
        mockStream.emit('end');
      });

      await handlePromise;

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/grpc-web');
      expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
      expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Expose-Headers', 'grpc-status,grpc-message');
      expect(res.end).toHaveBeenCalled();

      // Verify the response includes data + trailer frame
      const body = res.end.mock.calls[0][0] as Buffer;
      expect(body.length).toBeGreaterThan(GRPC_FRAME_HEADER_SIZE);

      vi.restoreAllMocks();
    });

    it('should handle upstream error and send UNAVAILABLE', async () => {
      const mockStream = createMockUpstreamStream();
      const mockSession = new EventEmitter();
      Object.assign(mockSession, {
        request: vi.fn().mockReturnValue(mockStream),
        destroyed: false,
        closed: false,
        close: vi.fn(),
      });

      vi.spyOn(http2, 'connect').mockReturnValue(mockSession as any);

      const req = createMockReq();
      const res = createMockRes();

      const handlePromise = handler.handleRequest(req, res);

      process.nextTick(() => {
        req.emit('data', Buffer.from('test'));
        req.emit('end');
      });

      await vi.waitFor(() => {
        expect((mockSession as any).request).toHaveBeenCalled();
      });

      process.nextTick(() => {
        mockStream.emit('error', new Error('Connection refused'));
      });

      await handlePromise;

      expect(mockLogger.error).toHaveBeenCalled();
      expect(mockAuditLogger.logError).toHaveBeenCalled();

      const body = res.end.mock.calls[0][0] as Buffer;
      const trailerStr = body.slice(GRPC_FRAME_HEADER_SIZE).toString('utf-8');
      expect(trailerStr).toContain(`grpc-status: ${GrpcStatus.UNAVAILABLE}`);

      vi.restoreAllMocks();
    });

    it('should not send error if headers already sent on upstream error', async () => {
      const mockStream = createMockUpstreamStream();
      const mockSession = new EventEmitter();
      Object.assign(mockSession, {
        request: vi.fn().mockReturnValue(mockStream),
        destroyed: false,
        closed: false,
        close: vi.fn(),
      });

      vi.spyOn(http2, 'connect').mockReturnValue(mockSession as any);

      const req = createMockReq();
      const res = createMockRes();
      res.headersSent = true;

      const handlePromise = handler.handleRequest(req, res);

      process.nextTick(() => {
        req.emit('data', Buffer.from('test'));
        req.emit('end');
      });

      await vi.waitFor(() => {
        expect((mockSession as any).request).toHaveBeenCalled();
      });

      process.nextTick(() => {
        mockStream.emit('error', new Error('Broken pipe'));
      });

      await handlePromise;

      // res.end should not have been called with an error response
      expect(res.end).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('should handle request error', async () => {
      const mockStream = createMockUpstreamStream();
      const mockSession = new EventEmitter();
      Object.assign(mockSession, {
        request: vi.fn().mockReturnValue(mockStream),
        destroyed: false,
        closed: false,
        close: vi.fn(),
      });

      vi.spyOn(http2, 'connect').mockReturnValue(mockSession as any);

      const req = createMockReq();
      const res = createMockRes();

      const handlePromise = handler.handleRequest(req, res);

      process.nextTick(() => {
        req.emit('error', new Error('Client disconnected'));
      });

      await handlePromise;

      // The error should propagate up and be caught by the try/catch
      expect(mockLogger.error).toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('should parse host header with port', async () => {
      mockAllowlistMatcher.match.mockReturnValue({ allowed: false, reason: 'Denied' });
      const req = createMockReq({
        headers: { 'content-type': 'application/grpc-web', host: 'grpc.example.com:9090' },
      });
      const res = createMockRes();

      await handler.handleRequest(req, res);

      const callArgs = mockAllowlistMatcher.match.mock.calls[0][0];
      expect(callArgs.host).toBe('grpc.example.com');
      expect(callArgs.port).toBe(9090);
    });

    it('should use default port when host has no port', async () => {
      mockAllowlistMatcher.match.mockReturnValue({ allowed: false, reason: 'Denied' });
      const req = createMockReq({
        headers: { 'content-type': 'application/grpc-web', host: 'grpc.example.com' },
      });
      const res = createMockRes();

      await handler.handleRequest(req, res);

      const callArgs = mockAllowlistMatcher.match.mock.calls[0][0];
      expect(callArgs.host).toBe('grpc.example.com');
      expect(callArgs.port).toBe(443); // default port
    });

    it('should use default port when port is NaN', async () => {
      mockAllowlistMatcher.match.mockReturnValue({ allowed: false, reason: 'Denied' });
      const req = createMockReq({
        headers: { 'content-type': 'application/grpc-web', host: 'grpc.example.com:abc' },
      });
      const res = createMockRes();

      await handler.handleRequest(req, res);

      const callArgs = mockAllowlistMatcher.match.mock.calls[0][0];
      expect(callArgs.port).toBe(443);
    });

    it('should get client IP from x-forwarded-for header', async () => {
      mockAllowlistMatcher.match.mockReturnValue({ allowed: false, reason: 'Denied' });
      const req = createMockReq({
        headers: {
          'content-type': 'application/grpc-web',
          host: 'localhost:50051',
          'x-forwarded-for': '10.0.0.1, 10.0.0.2',
        },
      });
      const res = createMockRes();

      await handler.handleRequest(req, res);

      const callArgs = mockAllowlistMatcher.match.mock.calls[0][0];
      expect(callArgs.sourceIp).toBe('10.0.0.1');
    });

    it('should fall back to socket remoteAddress for client IP', async () => {
      mockAllowlistMatcher.match.mockReturnValue({ allowed: false, reason: 'Denied' });
      const req = createMockReq();
      const res = createMockRes();

      await handler.handleRequest(req, res);

      const callArgs = mockAllowlistMatcher.match.mock.calls[0][0];
      expect(callArgs.sourceIp).toBe('127.0.0.1');
    });

    it('should use "unknown" when no IP source is available', async () => {
      mockAllowlistMatcher.match.mockReturnValue({ allowed: false, reason: 'Denied' });
      const req = createMockReq({ socket: {} });
      const res = createMockRes();

      await handler.handleRequest(req, res);

      const callArgs = mockAllowlistMatcher.match.mock.calls[0][0];
      expect(callArgs.sourceIp).toBe('unknown');
    });

    it('should use empty string for host when host header is missing', async () => {
      mockAllowlistMatcher.match.mockReturnValue({ allowed: false, reason: 'Denied' });
      const req = createMockReq({
        headers: { 'content-type': 'application/grpc-web' },
      });
      const res = createMockRes();

      await handler.handleRequest(req, res);

      const callArgs = mockAllowlistMatcher.match.mock.calls[0][0];
      expect(callArgs.host).toBe('');
      expect(callArgs.port).toBe(443);
    });

    it('should handle base64 request body for text format', async () => {
      const mockStream = createMockUpstreamStream();
      const mockSession = new EventEmitter();
      Object.assign(mockSession, {
        request: vi.fn().mockReturnValue(mockStream),
        destroyed: false,
        closed: false,
        close: vi.fn(),
      });

      vi.spyOn(http2, 'connect').mockReturnValue(mockSession as any);

      const originalBody = Buffer.from('hello-grpc');
      const base64Body = originalBody.toString('base64');

      const req = createMockReq({
        headers: { 'content-type': 'application/grpc-web-text', host: 'localhost:50051' },
      });
      const res = createMockRes();

      const handlePromise = handler.handleRequest(req, res);

      process.nextTick(() => {
        req.emit('data', Buffer.from(base64Body));
        req.emit('end');
      });

      await vi.waitFor(() => {
        expect((mockSession as any).request).toHaveBeenCalled();
      });

      // Verify the written body was base64-decoded
      const writtenData = mockStream.write.mock.calls[0][0] as Buffer;
      expect(writtenData.toString()).toBe('hello-grpc');

      process.nextTick(() => {
        mockStream.emit('response', {});
        mockStream.emit('data', Buffer.from('resp'));
        mockStream.emit('end');
      });

      await handlePromise;

      // Response should be base64-encoded for text format
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/grpc-web-text');
      const responseBody = res.end.mock.calls[0][0] as Buffer;
      // Should be valid base64
      const decoded = Buffer.from(responseBody.toString('utf-8'), 'base64');
      expect(decoded.length).toBeGreaterThan(0);

      vi.restoreAllMocks();
    });

    it('should forward grpc-timeout and custom headers', async () => {
      const mockStream = createMockUpstreamStream();
      const mockSession = new EventEmitter();
      Object.assign(mockSession, {
        request: vi.fn().mockReturnValue(mockStream),
        destroyed: false,
        closed: false,
        close: vi.fn(),
      });

      vi.spyOn(http2, 'connect').mockReturnValue(mockSession as any);

      const req = createMockReq({
        headers: {
          'content-type': 'application/grpc-web',
          host: 'localhost:50051',
          'grpc-timeout': '5S',
          'x-custom-header': 'custom-value',
          'grpc-encoding': 'gzip',
        },
      });
      const res = createMockRes();

      const handlePromise = handler.handleRequest(req, res);

      process.nextTick(() => {
        req.emit('data', Buffer.alloc(0));
        req.emit('end');
      });

      await vi.waitFor(() => {
        expect((mockSession as any).request).toHaveBeenCalled();
      });

      const upstreamHeaders = (mockSession as any).request.mock.calls[0][0];
      expect(upstreamHeaders['grpc-timeout']).toBe('5S');
      expect(upstreamHeaders['x-custom-header']).toBe('custom-value');
      expect(upstreamHeaders['grpc-encoding']).toBe('gzip');
      expect(upstreamHeaders['content-type']).toBe('application/grpc');
      expect(upstreamHeaders[':method']).toBe('POST');
      expect(upstreamHeaders['te']).toBe('trailers');

      // Clean up
      process.nextTick(() => {
        mockStream.emit('response', {});
        mockStream.emit('end');
      });

      await handlePromise;
      vi.restoreAllMocks();
    });

    it('should not forward grpc-web prefixed headers to upstream', async () => {
      const mockStream = createMockUpstreamStream();
      const mockSession = new EventEmitter();
      Object.assign(mockSession, {
        request: vi.fn().mockReturnValue(mockStream),
        destroyed: false,
        closed: false,
        close: vi.fn(),
      });

      vi.spyOn(http2, 'connect').mockReturnValue(mockSession as any);

      const req = createMockReq({
        headers: {
          'content-type': 'application/grpc-web',
          host: 'localhost:50051',
          'grpc-web-something': 'should-not-forward',
        },
      });
      const res = createMockRes();

      const handlePromise = handler.handleRequest(req, res);

      process.nextTick(() => {
        req.emit('data', Buffer.alloc(0));
        req.emit('end');
      });

      await vi.waitFor(() => {
        expect((mockSession as any).request).toHaveBeenCalled();
      });

      const upstreamHeaders = (mockSession as any).request.mock.calls[0][0];
      expect(upstreamHeaders['grpc-web-something']).toBeUndefined();

      process.nextTick(() => {
        mockStream.emit('response', {});
        mockStream.emit('end');
      });

      await handlePromise;
      vi.restoreAllMocks();
    });

    it('should track bytesTransferred for request and response data', async () => {
      const mockStream = createMockUpstreamStream();
      const mockSession = new EventEmitter();
      Object.assign(mockSession, {
        request: vi.fn().mockReturnValue(mockStream),
        destroyed: false,
        closed: false,
        close: vi.fn(),
      });

      vi.spyOn(http2, 'connect').mockReturnValue(mockSession as any);

      const req = createMockReq();
      const res = createMockRes();

      const handlePromise = handler.handleRequest(req, res);

      process.nextTick(() => {
        req.emit('data', Buffer.from('12345')); // 5 bytes
        req.emit('end');
      });

      await vi.waitFor(() => {
        expect((mockSession as any).request).toHaveBeenCalled();
      });

      process.nextTick(() => {
        mockStream.emit('response', {});
        mockStream.emit('data', Buffer.from('abcdefgh')); // 8 bytes
        mockStream.emit('end');
      });

      await handlePromise;

      expect(handler.getStats().bytesTransferred).toBe(13); // 5 + 8

      vi.restoreAllMocks();
    });

    it('should decrement activeRequests after completion', async () => {
      mockAllowlistMatcher.match.mockReturnValue({ allowed: false, reason: 'Denied' });
      const req = createMockReq();
      const res = createMockRes();

      await handler.handleRequest(req, res);

      expect(handler.getStats().activeRequests).toBe(0);
    });

    it('should decrement activeRequests after upstream error', async () => {
      const mockStream = createMockUpstreamStream();
      const mockSession = new EventEmitter();
      Object.assign(mockSession, {
        request: vi.fn().mockReturnValue(mockStream),
        destroyed: false,
        closed: false,
        close: vi.fn(),
      });

      vi.spyOn(http2, 'connect').mockReturnValue(mockSession as any);

      const req = createMockReq();
      const res = createMockRes();

      const handlePromise = handler.handleRequest(req, res);

      process.nextTick(() => {
        req.emit('data', Buffer.alloc(0));
        req.emit('end');
      });

      await vi.waitFor(() => {
        expect((mockSession as any).request).toHaveBeenCalled();
      });

      process.nextTick(() => {
        mockStream.emit('error', new Error('fail'));
      });

      await handlePromise;

      expect(handler.getStats().activeRequests).toBe(0);

      vi.restoreAllMocks();
    });

    it('should reuse existing upstream session', async () => {
      const mockStream1 = createMockUpstreamStream();
      const mockStream2 = createMockUpstreamStream();
      const mockSession = new EventEmitter();
      Object.assign(mockSession, {
        request: vi.fn().mockReturnValueOnce(mockStream1).mockReturnValueOnce(mockStream2),
        destroyed: false,
        closed: false,
        close: vi.fn(),
      });

      const connectSpy = vi.spyOn(http2, 'connect').mockReturnValue(mockSession as any);

      // First request
      const req1 = createMockReq();
      const res1 = createMockRes();

      const p1 = handler.handleRequest(req1, res1);
      process.nextTick(() => { req1.emit('data', Buffer.alloc(0)); req1.emit('end'); });
      await vi.waitFor(() => expect((mockSession as any).request).toHaveBeenCalledTimes(1));
      process.nextTick(() => { mockStream1.emit('response', {}); mockStream1.emit('end'); });
      await p1;

      // Second request to same host
      const req2 = createMockReq();
      const res2 = createMockRes();

      const p2 = handler.handleRequest(req2, res2);
      process.nextTick(() => { req2.emit('data', Buffer.alloc(0)); req2.emit('end'); });
      await vi.waitFor(() => expect((mockSession as any).request).toHaveBeenCalledTimes(2));
      process.nextTick(() => { mockStream2.emit('response', {}); mockStream2.emit('end'); });
      await p2;

      // http2.connect should only have been called once
      expect(connectSpy).toHaveBeenCalledTimes(1);

      vi.restoreAllMocks();
    });
  });

  // ---- handleCors ----

  describe('handleCors', () => {
    it('should handle OPTIONS requests and return true', () => {
      const req = createMockReq({ method: 'OPTIONS' });
      const res = createMockRes();

      const result = handler.handleCors(req, res);

      expect(result).toBe(true);
      expect(res.statusCode).toBe(204);
      expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
      expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Methods', 'POST, OPTIONS');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Headers',
        'Content-Type, X-Grpc-Web, X-User-Agent, Grpc-Timeout, Authorization',
      );
      expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Max-Age', '86400');
      expect(res.end).toHaveBeenCalled();
    });

    it('should return false for non-OPTIONS requests', () => {
      const req = createMockReq({ method: 'POST' });
      const res = createMockRes();

      const result = handler.handleCors(req, res);

      expect(result).toBe(false);
      expect(res.end).not.toHaveBeenCalled();
    });

    it('should return false for GET requests', () => {
      const req = createMockReq({ method: 'GET' });
      const res = createMockRes();

      const result = handler.handleCors(req, res);

      expect(result).toBe(false);
    });
  });

  // ---- statistics ----

  describe('statistics', () => {
    it('should return initial stats as all zeros', () => {
      const stats = handler.getStats();
      expect(stats).toEqual({
        totalRequests: 0,
        activeRequests: 0,
        bytesTransferred: 0,
        requestsRejected: 0,
        textRequests: 0,
        binaryRequests: 0,
      });
    });

    it('should increment totalRequests on each handleRequest call', async () => {
      mockAllowlistMatcher.match.mockReturnValue({ allowed: false, reason: 'Denied' });

      for (let i = 0; i < 3; i++) {
        await handler.handleRequest(createMockReq(), createMockRes());
      }

      expect(handler.getStats().totalRequests).toBe(3);
    });

    it('should return a copy of stats (not a reference)', () => {
      const stats1 = handler.getStats();
      stats1.totalRequests = 999;
      const stats2 = handler.getStats();
      expect(stats2.totalRequests).toBe(0);
    });

    it('should reset all stats to zero', async () => {
      mockAllowlistMatcher.match.mockReturnValue({ allowed: false, reason: 'Denied' });

      await handler.handleRequest(createMockReq(), createMockRes());
      await handler.handleRequest(
        createMockReq({
          headers: { 'content-type': 'application/grpc-web-text', host: 'localhost:50051' },
        }),
        createMockRes(),
      );

      expect(handler.getStats().totalRequests).toBe(2);

      handler.resetStats();

      expect(handler.getStats()).toEqual({
        totalRequests: 0,
        activeRequests: 0,
        bytesTransferred: 0,
        requestsRejected: 0,
        textRequests: 0,
        binaryRequests: 0,
      });
    });
  });

  // ---- connection management ----

  describe('connection management', () => {
    it('should close all upstream sessions', async () => {
      const mockStream = createMockUpstreamStream();
      const mockSession = new EventEmitter();
      Object.assign(mockSession, {
        request: vi.fn().mockReturnValue(mockStream),
        destroyed: false,
        closed: false,
        close: vi.fn(),
      });

      vi.spyOn(http2, 'connect').mockReturnValue(mockSession as any);

      const req = createMockReq();
      const res = createMockRes();

      const handlePromise = handler.handleRequest(req, res);

      process.nextTick(() => {
        req.emit('data', Buffer.alloc(0));
        req.emit('end');
      });

      await vi.waitFor(() => {
        expect((mockSession as any).request).toHaveBeenCalled();
      });

      process.nextTick(() => {
        mockStream.emit('response', {});
        mockStream.emit('end');
      });

      await handlePromise;

      handler.closeAll();

      expect((mockSession as any).close).toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('should not call close on already destroyed sessions', async () => {
      const mockStream = createMockUpstreamStream();
      const mockSession = new EventEmitter();
      Object.assign(mockSession, {
        request: vi.fn().mockReturnValue(mockStream),
        destroyed: false,
        closed: false,
        close: vi.fn(),
      });

      vi.spyOn(http2, 'connect').mockReturnValue(mockSession as any);

      const req = createMockReq();
      const res = createMockRes();

      const handlePromise = handler.handleRequest(req, res);

      process.nextTick(() => {
        req.emit('data', Buffer.alloc(0));
        req.emit('end');
      });

      await vi.waitFor(() => {
        expect((mockSession as any).request).toHaveBeenCalled();
      });

      process.nextTick(() => {
        mockStream.emit('response', {});
        mockStream.emit('end');
      });

      await handlePromise;

      // Mark session as destroyed
      (mockSession as any).destroyed = true;

      handler.closeAll();

      expect((mockSession as any).close).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('should handle closeAll with no sessions', () => {
      // Should not throw
      expect(() => handler.closeAll()).not.toThrow();
    });
  });

  // ---- encodeTrailerFrame (tested indirectly through error responses) ----

  describe('trailer frame encoding', () => {
    it('should produce valid trailer frame with correct flag byte and length', async () => {
      mockAllowlistMatcher.match.mockReturnValue({ allowed: false, reason: 'Denied' });
      const req = createMockReq();
      const res = createMockRes();

      await handler.handleRequest(req, res);

      const body = res.end.mock.calls[0][0] as Buffer;

      // First byte should be 0x80 (trailer flag)
      expect(body[0]).toBe(0x80);

      // Next 4 bytes are length (big-endian)
      const length = body.readUInt32BE(1);
      expect(length).toBe(body.length - GRPC_FRAME_HEADER_SIZE);
    });

    it('should include grpc-status in trailer frame', async () => {
      mockAllowlistMatcher.match.mockReturnValue({ allowed: false, reason: 'Denied' });
      const req = createMockReq();
      const res = createMockRes();

      await handler.handleRequest(req, res);

      const body = res.end.mock.calls[0][0] as Buffer;
      const trailerStr = body.slice(GRPC_FRAME_HEADER_SIZE).toString('utf-8');
      expect(trailerStr).toContain('grpc-status:');
    });

    it('should include grpc-message in trailer frame', async () => {
      mockAllowlistMatcher.match.mockReturnValue({ allowed: false, reason: 'Test error message' });
      const req = createMockReq();
      const res = createMockRes();

      await handler.handleRequest(req, res);

      const body = res.end.mock.calls[0][0] as Buffer;
      const trailerStr = body.slice(GRPC_FRAME_HEADER_SIZE).toString('utf-8');
      expect(trailerStr).toContain('grpc-message:');
      expect(trailerStr).toContain('Test%20error%20message');
    });

    it('should URL-encode the message in trailer frame', async () => {
      mockAllowlistMatcher.match.mockReturnValue({ allowed: false, reason: 'error with spaces & symbols' });
      const req = createMockReq();
      const res = createMockRes();

      await handler.handleRequest(req, res);

      const body = res.end.mock.calls[0][0] as Buffer;
      const trailerStr = body.slice(GRPC_FRAME_HEADER_SIZE).toString('utf-8');
      // encodeURIComponent encodes spaces as %20 and & as %26
      expect(trailerStr).toContain('error%20with%20spaces%20%26%20symbols');
    });
  });

  // ---- default config values ----

  describe('default configuration', () => {
    it('should use default port 443', async () => {
      mockAllowlistMatcher.match.mockReturnValue({ allowed: false, reason: 'Denied' });
      const req = createMockReq({
        headers: { 'content-type': 'application/grpc-web', host: 'example.com' },
      });
      const res = createMockRes();

      await handler.handleRequest(req, res);

      const callArgs = mockAllowlistMatcher.match.mock.calls[0][0];
      expect(callArgs.port).toBe(443);
    });

    it('should allow custom default port', async () => {
      const customHandler = new GrpcWebHandler({
        allowlistMatcher: mockAllowlistMatcher,
        rateLimiter: mockRateLimiter,
        auditLogger: mockAuditLogger,
        logger: mockLogger,
        defaultPort: 8080,
      });

      mockAllowlistMatcher.match.mockReturnValue({ allowed: false, reason: 'Denied' });
      const req = createMockReq({
        headers: { 'content-type': 'application/grpc-web', host: 'example.com' },
      });
      const res = createMockRes();

      await customHandler.handleRequest(req, res);

      const callArgs = mockAllowlistMatcher.match.mock.calls[0][0];
      expect(callArgs.port).toBe(8080);

      customHandler.closeAll();
    });
  });
});

// ---- standalone exports ----

describe('standalone isGrpcWebRequest', () => {
  it('should return true for grpc-web content type', () => {
    const req = createMockReq({ headers: { 'content-type': 'application/grpc-web+proto' } });
    expect(isGrpcWebRequest(req)).toBe(true);
  });

  it('should return false for non-grpc-web content type', () => {
    const req = createMockReq({ headers: { 'content-type': 'text/html' } });
    expect(isGrpcWebRequest(req)).toBe(false);
  });

  it('should return false when content-type is undefined', () => {
    const req = createMockReq({ headers: {} });
    expect(isGrpcWebRequest(req)).toBe(false);
  });
});

describe('createGrpcWebHandler', () => {
  it('should return a GrpcWebHandler instance', () => {
    const handler = createGrpcWebHandler(createDefaultConfig());
    expect(handler).toBeInstanceOf(GrpcWebHandler);
    handler.closeAll();
  });

  it('should create a functional handler', async () => {
    const config = createDefaultConfig();
    (config.allowlistMatcher as any).match.mockReturnValue({ allowed: false, reason: 'Denied' });

    const handler = createGrpcWebHandler(config);
    const req = createMockReq();
    const res = createMockRes();

    await handler.handleRequest(req, res);

    expect(res.end).toHaveBeenCalled();
    expect(handler.getStats().totalRequests).toBe(1);

    handler.closeAll();
  });
});
