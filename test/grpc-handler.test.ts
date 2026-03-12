/**
 * Tests for the GrpcHandler class.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import http2 from 'node:http2';
import { GrpcHandler, createGrpcHandler, isGrpcRequest } from '../src/proxy/grpc-handler.js';
import type { GrpcHandlerConfig } from '../src/proxy/grpc-handler.js';
import type { AllowlistMatcher } from '../src/filter/allowlist-matcher.js';
import type { RateLimiter } from '../src/filter/rate-limiter.js';
import type { AuditLogger } from '../src/logging/audit-logger.js';
import type { Logger } from '../src/logging/logger.js';
import { GrpcStatus } from '../src/proxy/grpc-parser.js';

const {
  HTTP2_HEADER_METHOD,
  HTTP2_HEADER_PATH,
  HTTP2_HEADER_SCHEME,
  HTTP2_HEADER_AUTHORITY,
  HTTP2_HEADER_STATUS,
  HTTP2_HEADER_CONTENT_TYPE,
} = http2.constants;

// --- Mock http2.connect ---

vi.mock('node:http2', async () => {
  const actual = await vi.importActual<typeof import('node:http2')>('node:http2');
  return {
    ...actual,
    default: {
      ...actual.default,
      connect: vi.fn(),
      constants: actual.default.constants,
    },
  };
});

// --- Mock helpers ---

class MockStream extends EventEmitter {
  destroyed = false;
  respond = vi.fn();
  write = vi.fn();
  end = vi.fn();
  close = vi.fn();
  destroy = vi.fn(() => {
    this.destroyed = true;
  });
  session = {
    socket: {
      remoteAddress: '10.0.0.1',
    },
  };
}

class MockUpstreamStream extends EventEmitter {
  destroyed = false;
  write = vi.fn();
  end = vi.fn();
  close = vi.fn();
  destroy = vi.fn(() => {
    this.destroyed = true;
  });
}

class MockSession extends EventEmitter {
  destroyed = false;
  closed = false;
  request = vi.fn();
  close = vi.fn(() => {
    this.closed = true;
  });
  destroy = vi.fn(() => {
    this.destroyed = true;
  });
  setTimeout = vi.fn();
}

function createMocks() {
  const mockAllowlistMatcher = {
    match: vi.fn().mockReturnValue({
      allowed: true,
      reason: 'Matched',
      matchedRule: { id: 'rule-1', domain: 'api.example.com' },
    }),
    isDomainAllowed: vi.fn().mockReturnValue({ allowed: true, reason: 'OK' }),
    reload: vi.fn(),
    getConfig: vi.fn(),
  } as unknown as AllowlistMatcher;

  const mockRateLimiter = {
    consume: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }),
    clear: vi.fn(),
    registerRules: vi.fn(),
  } as unknown as RateLimiter;

  const mockAuditLogger = {
    logRequest: vi.fn(),
    logRateLimit: vi.fn(),
    logError: vi.fn(),
  } as unknown as AuditLogger;

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;

  return { mockAllowlistMatcher, mockRateLimiter, mockAuditLogger, mockLogger };
}

function createConfig(mocks: ReturnType<typeof createMocks>): GrpcHandlerConfig {
  return {
    allowlistMatcher: mocks.mockAllowlistMatcher,
    rateLimiter: mocks.mockRateLimiter,
    auditLogger: mocks.mockAuditLogger,
    logger: mocks.mockLogger,
    defaultPort: 443,
    connectionTimeout: 10000,
    requestTimeout: 30000,
  };
}

function makeGrpcHeaders(overrides: Record<string, string> = {}): http2.IncomingHttpHeaders {
  return {
    [HTTP2_HEADER_METHOD]: 'POST',
    [HTTP2_HEADER_PATH]: '/myapp.UserService/GetUser',
    [HTTP2_HEADER_SCHEME]: 'https',
    [HTTP2_HEADER_AUTHORITY]: 'api.example.com:443',
    [HTTP2_HEADER_CONTENT_TYPE]: 'application/grpc',
    ...overrides,
  } as http2.IncomingHttpHeaders;
}

/** Flush microtask queue so async handlers get set up before we emit events */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

// --- Tests ---

describe('GrpcHandler', () => {
  let mocks: ReturnType<typeof createMocks>;
  let handler: GrpcHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMocks();
    handler = new GrpcHandler(createConfig(mocks));
  });

  // ========== isGrpcRequest ==========

  describe('isGrpcRequest', () => {
    it('should return true for application/grpc content type', () => {
      const headers = makeGrpcHeaders();
      expect(handler.isGrpcRequest(headers)).toBe(true);
    });

    it('should return true for application/grpc+proto', () => {
      const headers = makeGrpcHeaders({
        [HTTP2_HEADER_CONTENT_TYPE]: 'application/grpc+proto',
      });
      expect(handler.isGrpcRequest(headers)).toBe(true);
    });

    it('should return true for application/grpc+json', () => {
      const headers = makeGrpcHeaders({
        [HTTP2_HEADER_CONTENT_TYPE]: 'application/grpc+json',
      });
      expect(handler.isGrpcRequest(headers)).toBe(true);
    });

    it('should return false for non-gRPC content type', () => {
      const headers = makeGrpcHeaders({
        [HTTP2_HEADER_CONTENT_TYPE]: 'application/json',
      });
      expect(handler.isGrpcRequest(headers)).toBe(false);
    });

    it('should return false when content-type is missing', () => {
      const headers = { [HTTP2_HEADER_METHOD]: 'POST' } as http2.IncomingHttpHeaders;
      expect(handler.isGrpcRequest(headers)).toBe(false);
    });
  });

  // ========== handleStream ==========

  describe('handleStream', () => {
    let mockStream: MockStream;

    beforeEach(() => {
      mockStream = new MockStream();
    });

    it('should send INVALID_ARGUMENT for an invalid gRPC path', async () => {
      const headers = makeGrpcHeaders({
        [HTTP2_HEADER_PATH]: '/invalid-no-slash',
      });

      await handler.handleStream(
        mockStream as unknown as http2.ServerHttp2Stream,
        headers,
      );

      expect(mockStream.respond).toHaveBeenCalledWith(
        expect.objectContaining({
          [HTTP2_HEADER_STATUS]: 200,
          'grpc-status': String(GrpcStatus.INVALID_ARGUMENT),
        }),
        { endStream: true },
      );
    });

    it('should send PERMISSION_DENIED when allowlist denies the request', async () => {
      (mocks.mockAllowlistMatcher.match as ReturnType<typeof vi.fn>).mockReturnValue({
        allowed: false,
        reason: 'Domain not allowed',
      });

      const headers = makeGrpcHeaders();

      await handler.handleStream(
        mockStream as unknown as http2.ServerHttp2Stream,
        headers,
      );

      expect(mockStream.respond).toHaveBeenCalledWith(
        expect.objectContaining({
          'grpc-status': String(GrpcStatus.PERMISSION_DENIED),
        }),
        { endStream: true },
      );

      expect(mocks.mockAuditLogger.logRequest).toHaveBeenCalled();
    });

    it('should increment requestsRejected when allowlist denies', async () => {
      (mocks.mockAllowlistMatcher.match as ReturnType<typeof vi.fn>).mockReturnValue({
        allowed: false,
        reason: 'Denied',
      });

      const headers = makeGrpcHeaders();

      await handler.handleStream(
        mockStream as unknown as http2.ServerHttp2Stream,
        headers,
      );

      const stats = handler.getStats();
      expect(stats.requestsRejected).toBe(1);
    });

    it('should send PERMISSION_DENIED when gRPC matcher denies the request', async () => {
      // Allowlist allows, but the matched rule has gRPC config that restricts services
      (mocks.mockAllowlistMatcher.match as ReturnType<typeof vi.fn>).mockReturnValue({
        allowed: true,
        reason: 'Matched',
        matchedRule: {
          id: 'rule-1',
          domain: 'api.example.com',
          grpc: {
            services: ['otherpackage.OtherService'],
          },
        },
      });

      const headers = makeGrpcHeaders({
        [HTTP2_HEADER_PATH]: '/myapp.UserService/GetUser',
      });

      await handler.handleStream(
        mockStream as unknown as http2.ServerHttp2Stream,
        headers,
      );

      expect(mockStream.respond).toHaveBeenCalledWith(
        expect.objectContaining({
          'grpc-status': String(GrpcStatus.PERMISSION_DENIED),
        }),
        { endStream: true },
      );
    });

    it('should send RESOURCE_EXHAUSTED when rate limited', async () => {
      (mocks.mockRateLimiter.consume as ReturnType<typeof vi.fn>).mockResolvedValue({
        allowed: false,
        remaining: 0,
        retryAfter: 60,
      });

      const headers = makeGrpcHeaders();

      await handler.handleStream(
        mockStream as unknown as http2.ServerHttp2Stream,
        headers,
      );

      expect(mockStream.respond).toHaveBeenCalledWith(
        expect.objectContaining({
          'grpc-status': String(GrpcStatus.RESOURCE_EXHAUSTED),
        }),
        { endStream: true },
      );

      expect(mocks.mockAuditLogger.logRateLimit).toHaveBeenCalled();
    });

    it('should proxy to upstream on a successful request', async () => {
      const mockSession = new MockSession();
      const mockUpstreamStream = new MockUpstreamStream();
      mockSession.request.mockReturnValue(mockUpstreamStream);
      (http2.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockSession);

      const headers = makeGrpcHeaders();

      const handlePromise = handler.handleStream(
        mockStream as unknown as http2.ServerHttp2Stream,
        headers,
      );

      await flushMicrotasks();

      // Simulate upstream response
      mockUpstreamStream.emit('response', {
        [HTTP2_HEADER_STATUS]: 200,
        [HTTP2_HEADER_CONTENT_TYPE]: 'application/grpc',
      });

      // Simulate upstream end
      mockUpstreamStream.emit('end');

      await handlePromise;

      expect(mockSession.request).toHaveBeenCalledWith(
        expect.objectContaining({
          [HTTP2_HEADER_METHOD]: 'POST',
          [HTTP2_HEADER_PATH]: '/myapp.UserService/GetUser',
        }),
      );

      expect(mockStream.respond).toHaveBeenCalled();
    });

    it('should pipe data from client to upstream', async () => {
      const mockSession = new MockSession();
      const mockUpstreamStream = new MockUpstreamStream();
      mockSession.request.mockReturnValue(mockUpstreamStream);
      (http2.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockSession);

      const headers = makeGrpcHeaders();

      const handlePromise = handler.handleStream(
        mockStream as unknown as http2.ServerHttp2Stream,
        headers,
      );

      await flushMicrotasks();

      // Simulate client data
      const clientData = Buffer.from('client-data');
      mockStream.emit('data', clientData);

      // Simulate upstream data
      const upstreamData = Buffer.from('upstream-data');
      mockUpstreamStream.emit('data', upstreamData);

      // Simulate upstream response and end
      mockUpstreamStream.emit('response', { [HTTP2_HEADER_STATUS]: 200 });
      mockUpstreamStream.emit('end');

      await handlePromise;

      expect(mockUpstreamStream.write).toHaveBeenCalledWith(clientData);
      expect(mockStream.write).toHaveBeenCalledWith(upstreamData);
    });

    it('should track bytes transferred and messages forwarded', async () => {
      const mockSession = new MockSession();
      const mockUpstreamStream = new MockUpstreamStream();
      mockSession.request.mockReturnValue(mockUpstreamStream);
      (http2.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockSession);

      const headers = makeGrpcHeaders();

      const handlePromise = handler.handleStream(
        mockStream as unknown as http2.ServerHttp2Stream,
        headers,
      );

      await flushMicrotasks();

      // Simulate bidirectional data flow
      const clientData = Buffer.from('hello');
      const upstreamData = Buffer.from('world!');
      mockStream.emit('data', clientData);
      mockUpstreamStream.emit('data', upstreamData);

      mockUpstreamStream.emit('response', { [HTTP2_HEADER_STATUS]: 200 });
      mockUpstreamStream.emit('end');

      await handlePromise;

      const stats = handler.getStats();
      expect(stats.bytesTransferred).toBe(clientData.length + upstreamData.length);
      expect(stats.messagesForwarded).toBe(2);
    });

    it('should track requests by service', async () => {
      const mockSession = new MockSession();
      const mockUpstreamStream = new MockUpstreamStream();
      mockSession.request.mockReturnValue(mockUpstreamStream);
      (http2.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockSession);

      const headers = makeGrpcHeaders();

      const handlePromise = handler.handleStream(
        mockStream as unknown as http2.ServerHttp2Stream,
        headers,
      );

      await flushMicrotasks();

      mockUpstreamStream.emit('response', { [HTTP2_HEADER_STATUS]: 200 });
      mockUpstreamStream.emit('end');

      await handlePromise;

      const stats = handler.getStats();
      expect(stats.requestsByService.get('myapp.UserService')).toBe(1);
    });

    it('should handle upstream errors gracefully', async () => {
      const mockSession = new MockSession();
      const mockUpstreamStream = new MockUpstreamStream();
      mockSession.request.mockReturnValue(mockUpstreamStream);
      (http2.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockSession);

      const headers = makeGrpcHeaders();

      const handlePromise = handler.handleStream(
        mockStream as unknown as http2.ServerHttp2Stream,
        headers,
      );

      await flushMicrotasks();

      // Simulate upstream error
      mockUpstreamStream.emit('error', new Error('Connection refused'));

      await handlePromise;

      expect(mocks.mockLogger.error).toHaveBeenCalled();
      expect(mockStream.respond).toHaveBeenCalledWith(
        expect.objectContaining({
          'grpc-status': String(GrpcStatus.UNAVAILABLE),
        }),
        { endStream: true },
      );
    });

    it('should forward custom metadata headers to upstream', async () => {
      const mockSession = new MockSession();
      const mockUpstreamStream = new MockUpstreamStream();
      mockSession.request.mockReturnValue(mockUpstreamStream);
      (http2.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockSession);

      const headers = makeGrpcHeaders({
        'x-custom-header': 'custom-value',
        'grpc-timeout': '5S',
      });

      const handlePromise = handler.handleStream(
        mockStream as unknown as http2.ServerHttp2Stream,
        headers,
      );

      await flushMicrotasks();

      mockUpstreamStream.emit('response', { [HTTP2_HEADER_STATUS]: 200 });
      mockUpstreamStream.emit('end');

      await handlePromise;

      expect(mockSession.request).toHaveBeenCalledWith(
        expect.objectContaining({
          'x-custom-header': 'custom-value',
          'grpc-timeout': '5S',
        }),
      );
    });

    it('should parse authority without port and use default port', async () => {
      const mockSession = new MockSession();
      const mockUpstreamStream = new MockUpstreamStream();
      mockSession.request.mockReturnValue(mockUpstreamStream);
      (http2.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockSession);

      const headers = makeGrpcHeaders({
        [HTTP2_HEADER_AUTHORITY]: 'api.example.com',
      });

      const handlePromise = handler.handleStream(
        mockStream as unknown as http2.ServerHttp2Stream,
        headers,
      );

      await flushMicrotasks();

      mockUpstreamStream.emit('response', { [HTTP2_HEADER_STATUS]: 200 });
      mockUpstreamStream.emit('end');

      await handlePromise;

      // Should connect with default port (443)
      expect(http2.connect).toHaveBeenCalledWith(
        'https://api.example.com:443',
        expect.any(Object),
      );
    });

    it('should track gRPC error status from trailers', async () => {
      const mockSession = new MockSession();
      const mockUpstreamStream = new MockUpstreamStream();
      mockSession.request.mockReturnValue(mockUpstreamStream);
      (http2.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockSession);

      const headers = makeGrpcHeaders();

      const handlePromise = handler.handleStream(
        mockStream as unknown as http2.ServerHttp2Stream,
        headers,
      );

      await flushMicrotasks();

      mockUpstreamStream.emit('response', { [HTTP2_HEADER_STATUS]: 200 });
      mockUpstreamStream.emit('trailers', {
        'grpc-status': String(GrpcStatus.NOT_FOUND),
        'grpc-message': 'User%20not%20found',
      });
      mockUpstreamStream.emit('end');

      await handlePromise;

      const stats = handler.getStats();
      expect(stats.errorsByStatus.get(GrpcStatus.NOT_FOUND)).toBe(1);
    });

    it('should end upstream when client ends', async () => {
      const mockSession = new MockSession();
      const mockUpstreamStream = new MockUpstreamStream();
      mockSession.request.mockReturnValue(mockUpstreamStream);
      (http2.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockSession);

      const headers = makeGrpcHeaders();

      const handlePromise = handler.handleStream(
        mockStream as unknown as http2.ServerHttp2Stream,
        headers,
      );

      await flushMicrotasks();

      // Client ends its side
      mockStream.emit('end');

      // Then upstream finishes
      mockUpstreamStream.emit('response', { [HTTP2_HEADER_STATUS]: 200 });
      mockUpstreamStream.emit('end');

      await handlePromise;

      expect(mockUpstreamStream.end).toHaveBeenCalled();
    });

    it('should not send error if stream is already destroyed', async () => {
      const mockSession = new MockSession();
      const mockUpstreamStream = new MockUpstreamStream();
      mockSession.request.mockReturnValue(mockUpstreamStream);
      (http2.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockSession);

      const headers = makeGrpcHeaders();
      mockStream.destroyed = true;

      const handlePromise = handler.handleStream(
        mockStream as unknown as http2.ServerHttp2Stream,
        headers,
      );

      await flushMicrotasks();

      mockUpstreamStream.emit('error', new Error('fail'));

      await handlePromise;

      // respond should not be called since stream is destroyed
      expect(mockStream.respond).not.toHaveBeenCalled();
    });

    it('should get client IP from stream session socket', async () => {
      // Set a specific remote address
      mockStream.session = {
        socket: { remoteAddress: '192.168.1.100' },
      };

      (mocks.mockAllowlistMatcher.match as ReturnType<typeof vi.fn>).mockReturnValue({
        allowed: false,
        reason: 'Denied',
      });

      const headers = makeGrpcHeaders();

      await handler.handleStream(
        mockStream as unknown as http2.ServerHttp2Stream,
        headers,
      );

      // The allowlist match should have been called with requestInfo containing the IP
      expect(mocks.mockAllowlistMatcher.match).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceIp: '192.168.1.100',
        }),
      );
    });

    it('should use "unknown" when socket has no remoteAddress', async () => {
      mockStream.session = { socket: {} };

      (mocks.mockAllowlistMatcher.match as ReturnType<typeof vi.fn>).mockReturnValue({
        allowed: false,
        reason: 'Denied',
      });

      const headers = makeGrpcHeaders();

      await handler.handleStream(
        mockStream as unknown as http2.ServerHttp2Stream,
        headers,
      );

      expect(mocks.mockAllowlistMatcher.match).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceIp: 'unknown',
        }),
      );
    });

    it('should increment totalRequests on each call', async () => {
      const headers = makeGrpcHeaders({
        [HTTP2_HEADER_PATH]: '/invalid',
      });

      await handler.handleStream(
        mockStream as unknown as http2.ServerHttp2Stream,
        headers,
      );

      const stats = handler.getStats();
      expect(stats.totalRequests).toBe(1);
    });

    it('should decrement activeStreams after completion', async () => {
      const headers = makeGrpcHeaders({
        [HTTP2_HEADER_PATH]: '/invalid',
      });

      await handler.handleStream(
        mockStream as unknown as http2.ServerHttp2Stream,
        headers,
      );

      const stats = handler.getStats();
      expect(stats.activeStreams).toBe(0);
    });

    it('should reuse existing upstream session for same host:port', async () => {
      const mockSession = new MockSession();
      const mockUpstreamStream1 = new MockUpstreamStream();
      const mockUpstreamStream2 = new MockUpstreamStream();
      mockSession.request
        .mockReturnValueOnce(mockUpstreamStream1)
        .mockReturnValueOnce(mockUpstreamStream2);
      (http2.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockSession);

      const headers = makeGrpcHeaders();

      // First request
      const p1 = handler.handleStream(
        mockStream as unknown as http2.ServerHttp2Stream,
        headers,
      );
      await flushMicrotasks();
      mockUpstreamStream1.emit('response', { [HTTP2_HEADER_STATUS]: 200 });
      mockUpstreamStream1.emit('end');
      await p1;

      // Second request
      const mockStream2 = new MockStream();
      const p2 = handler.handleStream(
        mockStream2 as unknown as http2.ServerHttp2Stream,
        headers,
      );
      await flushMicrotasks();
      mockUpstreamStream2.emit('response', { [HTTP2_HEADER_STATUS]: 200 });
      mockUpstreamStream2.emit('end');
      await p2;

      // http2.connect should only be called once (reuse session)
      expect(http2.connect).toHaveBeenCalledTimes(1);
    });
  });

  // ========== statistics ==========

  describe('statistics', () => {
    it('should return initial stats with all zeroes', () => {
      const stats = handler.getStats();
      expect(stats.totalRequests).toBe(0);
      expect(stats.activeStreams).toBe(0);
      expect(stats.messagesForwarded).toBe(0);
      expect(stats.bytesTransferred).toBe(0);
      expect(stats.requestsByService.size).toBe(0);
      expect(stats.errorsByStatus.size).toBe(0);
      expect(stats.requestsRejected).toBe(0);
    });

    it('should return a copy of stats (not the internal reference)', () => {
      const stats1 = handler.getStats();
      const stats2 = handler.getStats();
      expect(stats1).not.toBe(stats2);
      expect(stats1.requestsByService).not.toBe(stats2.requestsByService);
      expect(stats1.errorsByStatus).not.toBe(stats2.errorsByStatus);
    });

    it('should reset all stats to zero', async () => {
      // Generate some stats by sending an invalid path request
      const mockStream = new MockStream();
      const headers = makeGrpcHeaders({ [HTTP2_HEADER_PATH]: '/bad' });

      await handler.handleStream(
        mockStream as unknown as http2.ServerHttp2Stream,
        headers,
      );

      // Confirm stats are non-zero
      let stats = handler.getStats();
      expect(stats.totalRequests).toBeGreaterThan(0);

      handler.resetStats();
      stats = handler.getStats();

      expect(stats.totalRequests).toBe(0);
      expect(stats.activeStreams).toBe(0);
      expect(stats.messagesForwarded).toBe(0);
      expect(stats.bytesTransferred).toBe(0);
      expect(stats.requestsByService.size).toBe(0);
      expect(stats.errorsByStatus.size).toBe(0);
      expect(stats.requestsRejected).toBe(0);
    });

    it('should track errors by status code', async () => {
      // Invalid path will produce an INVALID_ARGUMENT error
      const mockStream = new MockStream();
      const headers = makeGrpcHeaders({ [HTTP2_HEADER_PATH]: '/bad' });

      await handler.handleStream(
        mockStream as unknown as http2.ServerHttp2Stream,
        headers,
      );

      const stats = handler.getStats();
      expect(stats.errorsByStatus.get(GrpcStatus.INVALID_ARGUMENT)).toBe(1);
    });
  });

  // ========== connection management ==========

  describe('connection management', () => {
    it('should return 0 active connections initially', () => {
      expect(handler.getActiveConnectionCount()).toBe(0);
    });

    it('should track active connections after proxy', async () => {
      const mockSession = new MockSession();
      const mockUpstreamStream = new MockUpstreamStream();
      mockSession.request.mockReturnValue(mockUpstreamStream);
      (http2.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockSession);

      const headers = makeGrpcHeaders();

      const handlePromise = handler.handleStream(
        new MockStream() as unknown as http2.ServerHttp2Stream,
        headers,
      );

      await flushMicrotasks();

      // Connection should be tracked
      expect(handler.getActiveConnectionCount()).toBe(1);

      mockUpstreamStream.emit('response', { [HTTP2_HEADER_STATUS]: 200 });
      mockUpstreamStream.emit('end');
      await handlePromise;
    });

    it('should close all upstream sessions on closeAll', async () => {
      const mockSession = new MockSession();
      const mockUpstreamStream = new MockUpstreamStream();
      mockSession.request.mockReturnValue(mockUpstreamStream);
      (http2.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockSession);

      const headers = makeGrpcHeaders();

      const handlePromise = handler.handleStream(
        new MockStream() as unknown as http2.ServerHttp2Stream,
        headers,
      );

      await flushMicrotasks();

      mockUpstreamStream.emit('response', { [HTTP2_HEADER_STATUS]: 200 });
      mockUpstreamStream.emit('end');
      await handlePromise;

      expect(handler.getActiveConnectionCount()).toBe(1);

      handler.closeAll();

      expect(mockSession.close).toHaveBeenCalled();
      expect(handler.getActiveConnectionCount()).toBe(0);
    });

    it('should not call close on already destroyed sessions', async () => {
      const mockSession = new MockSession();
      const mockUpstreamStream = new MockUpstreamStream();
      mockSession.request.mockReturnValue(mockUpstreamStream);
      (http2.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockSession);

      const headers = makeGrpcHeaders();

      const handlePromise = handler.handleStream(
        new MockStream() as unknown as http2.ServerHttp2Stream,
        headers,
      );

      await flushMicrotasks();

      mockUpstreamStream.emit('response', { [HTTP2_HEADER_STATUS]: 200 });
      mockUpstreamStream.emit('end');
      await handlePromise;

      // Simulate the session being destroyed before closeAll
      mockSession.destroyed = true;
      mockSession.close.mockClear();
      handler.closeAll();
      expect(mockSession.close).not.toHaveBeenCalled();
    });
  });

  // ========== factory functions ==========

  describe('factory functions', () => {
    it('should create a GrpcHandler instance via createGrpcHandler', () => {
      const config = createConfig(mocks);
      const instance = createGrpcHandler(config);
      expect(instance).toBeInstanceOf(GrpcHandler);
    });

    it('should use default values for optional config', () => {
      const config: GrpcHandlerConfig = {
        allowlistMatcher: mocks.mockAllowlistMatcher,
        rateLimiter: mocks.mockRateLimiter,
        auditLogger: mocks.mockAuditLogger,
        logger: mocks.mockLogger,
      };
      const instance = createGrpcHandler(config);
      expect(instance).toBeInstanceOf(GrpcHandler);
      // Should not throw when using defaults
      const stats = instance.getStats();
      expect(stats.totalRequests).toBe(0);
    });
  });

  // ========== standalone isGrpcRequest ==========

  describe('standalone isGrpcRequest', () => {
    it('should return true for application/grpc', () => {
      expect(isGrpcRequest({ 'content-type': 'application/grpc' })).toBe(true);
    });

    it('should return true for application/grpc+proto', () => {
      expect(isGrpcRequest({ 'content-type': 'application/grpc+proto' })).toBe(true);
    });

    it('should return false for application/json', () => {
      expect(isGrpcRequest({ 'content-type': 'application/json' })).toBe(false);
    });

    it('should return false when no content-type is set', () => {
      expect(isGrpcRequest({})).toBe(false);
    });

    it('should also check the HTTP2 content-type constant key', () => {
      expect(
        isGrpcRequest({ [HTTP2_HEADER_CONTENT_TYPE]: 'application/grpc' }),
      ).toBe(true);
    });
  });
});
