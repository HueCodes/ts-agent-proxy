/**
 * Tests for the CONNECT tunnel handler.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { ConnectHandler, createConnectHandler } from '../src/proxy/connect-handler.js';
import type { ConnectHandlerOptions } from '../src/proxy/connect-handler.js';
import type { AllowlistMatcher } from '../src/filter/allowlist-matcher.js';
import type { RateLimiter } from '../src/filter/rate-limiter.js';
import type { AuditLogger } from '../src/logging/audit-logger.js';
import type { Logger } from '../src/logging/logger.js';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { TimeoutsConfig } from '../src/types/config.js';
import { DEFAULT_TIMEOUTS } from '../src/types/config.js';

// --- Mock helpers ---

class MockSocket extends EventEmitter {
  write = vi.fn().mockReturnValue(true);
  end = vi.fn();
  destroy = vi.fn();
  pipe = vi.fn().mockReturnThis();
  remoteAddress = '127.0.0.1';
  writable = true;
}

function createMockRequest(options: {
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
}): IncomingMessage {
  const socket = new MockSocket();
  socket.remoteAddress = options.remoteAddress ?? '127.0.0.1';
  return {
    url: options.url ?? 'example.com:443',
    headers: options.headers ?? {},
    socket,
  } as unknown as IncomingMessage;
}

function createMocks() {
  const mockAllowlistMatcher = {
    match: vi.fn().mockReturnValue({ allowed: true, reason: 'Matched' }),
    isDomainAllowed: vi.fn().mockReturnValue({
      allowed: true,
      reason: 'Domain allowed',
      matchedRule: { id: 'rule-1', domain: 'example.com' },
    }),
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

// --- Tests ---

describe('ConnectHandler', () => {
  let handler: ConnectHandler;
  let mockAllowlistMatcher: AllowlistMatcher;
  let mockRateLimiter: RateLimiter;
  let mockAuditLogger: AuditLogger;
  let mockLogger: Logger;
  let netConnectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    const mocks = createMocks();
    mockAllowlistMatcher = mocks.mockAllowlistMatcher;
    mockRateLimiter = mocks.mockRateLimiter;
    mockAuditLogger = mocks.mockAuditLogger;
    mockLogger = mocks.mockLogger;

    handler = new ConnectHandler({
      allowlistMatcher: mockAllowlistMatcher,
      rateLimiter: mockRateLimiter,
      auditLogger: mockAuditLogger,
      logger: mockLogger,
    });

    // Default: net.connect returns a mock server socket that connects immediately
    netConnectSpy = vi.spyOn(net, 'connect').mockImplementation(((
      _port: number,
      _host: string,
      callback?: () => void,
    ) => {
      const serverSocket = new MockSocket();
      // Schedule the connect callback asynchronously so we can set up listeners
      if (callback) {
        setTimeout(callback, 0);
      }
      return serverSocket as unknown as net.Socket;
    }) as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // 1. Construction
  describe('construction', () => {
    it('should create a handler with default timeouts', () => {
      const h = new ConnectHandler({
        allowlistMatcher: mockAllowlistMatcher,
        rateLimiter: mockRateLimiter,
        auditLogger: mockAuditLogger,
        logger: mockLogger,
      });
      expect(h).toBeInstanceOf(ConnectHandler);
    });

    it('should create a handler with custom timeouts', () => {
      const customTimeouts: TimeoutsConfig = {
        connectTimeout: 5000,
        responseTimeout: 15000,
        idleTimeout: 30000,
        requestTimeout: 15000,
      };
      const h = new ConnectHandler({
        allowlistMatcher: mockAllowlistMatcher,
        rateLimiter: mockRateLimiter,
        auditLogger: mockAuditLogger,
        logger: mockLogger,
        timeouts: customTimeouts,
      });
      expect(h).toBeInstanceOf(ConnectHandler);
    });
  });

  // 2. CONNECT request handling for allowed domains
  describe('handleConnect - allowed domains', () => {
    it('should establish a tunnel for an allowed domain', async () => {
      const req = createMockRequest({ url: 'api.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      // Should have called net.connect with correct host/port
      expect(netConnectSpy).toHaveBeenCalledWith(443, 'api.example.com', expect.any(Function));

      // Should write 200 Connection Established
      expect((clientSocket as any).write).toHaveBeenCalledWith(
        expect.stringContaining('200 Connection Established'),
      );
    });

    it('should write the head buffer to the server socket', async () => {
      const req = createMockRequest({ url: 'api.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.from('initial-data');

      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      // Get the server socket from net.connect
      const serverSocket = netConnectSpy.mock.results[0].value as MockSocket;
      expect(serverSocket.write).toHaveBeenCalledWith(head);
    });

    it('should pipe client and server sockets together', async () => {
      const req = createMockRequest({ url: 'api.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      const serverSocket = netConnectSpy.mock.results[0].value as MockSocket;
      expect((clientSocket as any).pipe).toHaveBeenCalledWith(serverSocket);
      expect(serverSocket.pipe).toHaveBeenCalledWith(clientSocket);
    });

    it('should log the request via audit logger on success', async () => {
      const req = createMockRequest({ url: 'api.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockAuditLogger.logRequest as any).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'api.example.com', port: 443 }),
        expect.objectContaining({ allowed: true, reason: 'Tunnel established' }),
        expect.any(Number),
      );
    });
  });

  // 3. CONNECT request handling for denied domains
  describe('handleConnect - denied domains', () => {
    beforeEach(() => {
      (mockAllowlistMatcher.isDomainAllowed as any).mockReturnValue({
        allowed: false,
        reason: 'No matching rule',
      });
    });

    it('should send 403 Forbidden for a denied domain', async () => {
      const req = createMockRequest({ url: 'evil.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      await handler.handleConnect(req, clientSocket, head);

      expect((clientSocket as any).write).toHaveBeenCalledWith(
        expect.stringContaining('403 Forbidden'),
      );
      expect((clientSocket as any).write).toHaveBeenCalledWith(
        expect.stringContaining('Domain not allowed: evil.example.com'),
      );
      expect((clientSocket as any).end).toHaveBeenCalled();
    });

    it('should not attempt to connect to denied domains', async () => {
      const req = createMockRequest({ url: 'evil.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      await handler.handleConnect(req, clientSocket, head);

      expect(netConnectSpy).not.toHaveBeenCalled();
    });

    it('should log denied requests via audit logger', async () => {
      const req = createMockRequest({ url: 'evil.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      await handler.handleConnect(req, clientSocket, head);

      expect(mockAuditLogger.logRequest as any).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'evil.example.com', port: 443 }),
        expect.objectContaining({ allowed: false }),
        expect.any(Number),
      );
    });
  });

  // 4. Domain extraction from CONNECT target
  describe('domain parsing (via handleConnect)', () => {
    it('should parse host and port from CONNECT target', async () => {
      const req = createMockRequest({ url: 'myhost.com:8443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      expect(netConnectSpy).toHaveBeenCalledWith(8443, 'myhost.com', expect.any(Function));
    });

    it('should default port to 443 if not specified', async () => {
      const req = createMockRequest({ url: 'myhost.com' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      expect(netConnectSpy).toHaveBeenCalledWith(443, 'myhost.com', expect.any(Function));
    });

    it('should handle empty URL gracefully', async () => {
      const req = createMockRequest({ url: '' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      // URL becomes '' -> host='', port=443
      // isDomainAllowed is called with '' which may be denied
      (mockAllowlistMatcher.isDomainAllowed as any).mockReturnValue({
        allowed: false,
        reason: 'Empty domain',
      });

      await handler.handleConnect(req, clientSocket, head);

      expect(mockAllowlistMatcher.isDomainAllowed as any).toHaveBeenCalledWith('');
    });

    it('should extract client IP from x-forwarded-for header', async () => {
      const req = createMockRequest({
        url: 'example.com:443',
        headers: { 'x-forwarded-for': '10.0.0.1, 192.168.1.1' },
      });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockAuditLogger.logRequest as any).toHaveBeenCalledWith(
        expect.objectContaining({ sourceIp: '10.0.0.1' }),
        expect.any(Object),
        expect.any(Number),
      );
    });

    it('should use socket remoteAddress when x-forwarded-for is absent', async () => {
      const req = createMockRequest({
        url: 'example.com:443',
        remoteAddress: '192.168.5.5',
      });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockAuditLogger.logRequest as any).toHaveBeenCalledWith(
        expect.objectContaining({ sourceIp: '192.168.5.5' }),
        expect.any(Object),
        expect.any(Number),
      );
    });
  });

  // 5. Error handling during tunnel establishment
  describe('error handling during tunnel establishment', () => {
    it('should send 502 Bad Gateway when server connection fails', async () => {
      netConnectSpy.mockImplementation(((_port: number, _host: string, _callback?: () => void) => {
        const serverSocket = new MockSocket();
        process.nextTick(() => {
          serverSocket.emit('error', new Error('Connection refused'));
        });
        return serverSocket as unknown as net.Socket;
      }) as any);

      const req = createMockRequest({ url: 'api.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(0);
      // The promise rejects when server emits error, which is caught internally
      await expect(promise).resolves.toBeUndefined();

      expect((clientSocket as any).write).toHaveBeenCalledWith(
        expect.stringContaining('502 Bad Gateway'),
      );
      expect((clientSocket as any).end).toHaveBeenCalled();
    });

    it('should log errors via audit logger', async () => {
      const connectionError = new Error('ECONNREFUSED');

      netConnectSpy.mockImplementation(((_port: number, _host: string, _callback?: () => void) => {
        const serverSocket = new MockSocket();
        process.nextTick(() => {
          serverSocket.emit('error', connectionError);
        });
        return serverSocket as unknown as net.Socket;
      }) as any);

      const req = createMockRequest({ url: 'api.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockAuditLogger.logError as any).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'api.example.com', port: 443 }),
        connectionError,
      );
    });
  });

  // 6. Socket cleanup on errors
  describe('socket cleanup', () => {
    it('should destroy server socket when client socket errors', async () => {
      const req = createMockRequest({ url: 'api.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      const serverSocket = netConnectSpy.mock.results[0].value as MockSocket;

      // Simulate client socket error
      (clientSocket as unknown as EventEmitter).emit('error', new Error('client error'));

      expect(serverSocket.destroy).toHaveBeenCalled();
    });

    it('should destroy server socket when client socket closes', async () => {
      const req = createMockRequest({ url: 'api.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      const serverSocket = netConnectSpy.mock.results[0].value as MockSocket;

      (clientSocket as unknown as EventEmitter).emit('close');

      expect(serverSocket.destroy).toHaveBeenCalled();
    });

    it('should destroy client socket when server socket closes', async () => {
      const req = createMockRequest({ url: 'api.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      const serverSocket = netConnectSpy.mock.results[0].value as MockSocket;

      serverSocket.emit('close');

      expect((clientSocket as any).destroy).toHaveBeenCalled();
    });

    it('should destroy client socket when server socket errors', async () => {
      const req = createMockRequest({ url: 'api.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      // Connect succeeds first, then server errors later
      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      const serverSocket = netConnectSpy.mock.results[0].value as MockSocket;

      // Server error after tunnel is established (already resolved)
      serverSocket.emit('error', new Error('server crash'));

      expect((clientSocket as any).destroy).toHaveBeenCalled();
    });
  });

  // 7. Timeout handling
  describe('timeout handling', () => {
    it('should send 504 Gateway Timeout when connect times out', async () => {
      const customTimeouts: TimeoutsConfig = {
        connectTimeout: 500,
        responseTimeout: 1000,
        idleTimeout: 2000,
        requestTimeout: 1000,
      };

      handler = new ConnectHandler({
        allowlistMatcher: mockAllowlistMatcher,
        rateLimiter: mockRateLimiter,
        auditLogger: mockAuditLogger,
        logger: mockLogger,
        timeouts: customTimeouts,
      });

      // Never call the connect callback
      netConnectSpy.mockImplementation(((_port: number, _host: string, _callback?: () => void) => {
        const serverSocket = new MockSocket();
        // Do NOT call the callback -- simulates hanging connect
        return serverSocket as unknown as net.Socket;
      }) as any);

      const req = createMockRequest({ url: 'slow.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      const promise = handler.handleConnect(req, clientSocket, head);

      // Advance past connect timeout
      await vi.advanceTimersByTimeAsync(600);
      await promise;

      expect((clientSocket as any).write).toHaveBeenCalledWith(
        expect.stringContaining('504 Gateway Timeout'),
      );
      expect((clientSocket as any).destroy).toHaveBeenCalled();
    });

    it('should log timeout errors via audit logger', async () => {
      const customTimeouts: TimeoutsConfig = {
        connectTimeout: 500,
        responseTimeout: 1000,
        idleTimeout: 2000,
        requestTimeout: 1000,
      };

      handler = new ConnectHandler({
        allowlistMatcher: mockAllowlistMatcher,
        rateLimiter: mockRateLimiter,
        auditLogger: mockAuditLogger,
        logger: mockLogger,
        timeouts: customTimeouts,
      });

      netConnectSpy.mockImplementation(((_port: number, _host: string, _callback?: () => void) => {
        const serverSocket = new MockSocket();
        return serverSocket as unknown as net.Socket;
      }) as any);

      const req = createMockRequest({ url: 'slow.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(600);
      await promise;

      expect(mockAuditLogger.logError as any).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'slow.example.com' }),
        expect.any(Error),
      );
    });

    it('should destroy both sockets on idle timeout', async () => {
      const customTimeouts: TimeoutsConfig = {
        connectTimeout: 5000,
        responseTimeout: 5000,
        idleTimeout: 1000,
        requestTimeout: 5000,
      };

      handler = new ConnectHandler({
        allowlistMatcher: mockAllowlistMatcher,
        rateLimiter: mockRateLimiter,
        auditLogger: mockAuditLogger,
        logger: mockLogger,
        timeouts: customTimeouts,
      });

      const req = createMockRequest({ url: 'api.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      const serverSocket = netConnectSpy.mock.results[0].value as MockSocket;

      // Advance past idle timeout
      await vi.advanceTimersByTimeAsync(1100);

      expect((clientSocket as any).destroy).toHaveBeenCalled();
      expect(serverSocket.destroy).toHaveBeenCalled();
    });

    it('should reset idle timeout on data activity', async () => {
      const customTimeouts: TimeoutsConfig = {
        connectTimeout: 5000,
        responseTimeout: 5000,
        idleTimeout: 1000,
        requestTimeout: 5000,
      };

      handler = new ConnectHandler({
        allowlistMatcher: mockAllowlistMatcher,
        rateLimiter: mockRateLimiter,
        auditLogger: mockAuditLogger,
        logger: mockLogger,
        timeouts: customTimeouts,
      });

      const req = createMockRequest({ url: 'api.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      const serverSocket = netConnectSpy.mock.results[0].value as MockSocket;

      // Advance 800ms (within idle timeout)
      await vi.advanceTimersByTimeAsync(800);
      // Emit data to reset idle timeout
      (clientSocket as unknown as EventEmitter).emit('data', Buffer.from('keepalive'));

      // Advance another 800ms (total 1600ms from start, but only 800ms since reset)
      await vi.advanceTimersByTimeAsync(800);

      // Should NOT be destroyed yet
      expect((clientSocket as any).destroy).not.toHaveBeenCalled();
      expect(serverSocket.destroy).not.toHaveBeenCalled();

      // Advance past idle timeout from last activity
      await vi.advanceTimersByTimeAsync(300);

      expect((clientSocket as any).destroy).toHaveBeenCalled();
      expect(serverSocket.destroy).toHaveBeenCalled();
    });
  });

  // 8. Rate limiting
  describe('rate limiting', () => {
    it('should send 429 when rate limited', async () => {
      (mockRateLimiter.consume as any).mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetMs: 5000,
      });

      const req = createMockRequest({ url: 'api.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      await handler.handleConnect(req, clientSocket, head);

      expect((clientSocket as any).write).toHaveBeenCalledWith(
        expect.stringContaining('429 Too Many Requests'),
      );
      expect((clientSocket as any).write).toHaveBeenCalledWith(
        expect.stringContaining('Retry-After: 5'),
      );
      expect((clientSocket as any).end).toHaveBeenCalled();
    });

    it('should not establish tunnel when rate limited', async () => {
      (mockRateLimiter.consume as any).mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetMs: 10000,
      });

      const req = createMockRequest({ url: 'api.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      await handler.handleConnect(req, clientSocket, head);

      expect(netConnectSpy).not.toHaveBeenCalled();
    });

    it('should log rate limit events via audit logger', async () => {
      const rateLimitResult = {
        allowed: false,
        remaining: 0,
        resetMs: 5000,
      };
      (mockRateLimiter.consume as any).mockResolvedValue(rateLimitResult);

      const req = createMockRequest({ url: 'api.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      await handler.handleConnect(req, clientSocket, head);

      expect(mockAuditLogger.logRateLimit as any).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'api.example.com', port: 443 }),
        rateLimitResult,
        expect.objectContaining({ id: 'rule-1' }),
      );
    });

    it('should compute rate limit key from matched rule and source IP', async () => {
      (mockAllowlistMatcher.isDomainAllowed as any).mockReturnValue({
        allowed: true,
        reason: 'Matched',
        matchedRule: { id: 'my-rule-42', domain: 'example.com' },
      });

      const req = createMockRequest({
        url: 'api.example.com:443',
        headers: { 'x-forwarded-for': '10.0.0.5' },
      });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockRateLimiter.consume as any).toHaveBeenCalledWith(
        'my-rule-42:10.0.0.5',
        'my-rule-42',
      );
    });

    it('should use "default" key when no matched rule', async () => {
      (mockAllowlistMatcher.isDomainAllowed as any).mockReturnValue({
        allowed: true,
        reason: 'Default allow',
        matchedRule: undefined,
      });

      const req = createMockRequest({ url: 'api.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockRateLimiter.consume as any).toHaveBeenCalledWith('default:127.0.0.1', undefined);
    });

    it('should ceil the retry-after seconds', async () => {
      (mockRateLimiter.consume as any).mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetMs: 1500, // 1.5s -> ceil to 2
      });

      const req = createMockRequest({ url: 'api.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      await handler.handleConnect(req, clientSocket, head);

      expect((clientSocket as any).write).toHaveBeenCalledWith(
        expect.stringContaining('Retry-After: 2'),
      );
    });
  });

  // 9. Logging
  describe('logging', () => {
    it('should log debug message when CONNECT is received', async () => {
      const req = createMockRequest({ url: 'api.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockLogger.debug as any).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'api.example.com', port: 443 }),
        'CONNECT request received',
      );
    });

    it('should log debug when tunnel is established', async () => {
      const req = createMockRequest({ url: 'api.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockLogger.debug as any).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'api.example.com', port: 443 }),
        'Tunnel established',
      );
    });

    it('should log error when tunnel connection fails', async () => {
      netConnectSpy.mockImplementation(((_port: number, _host: string, _callback?: () => void) => {
        const serverSocket = new MockSocket();
        process.nextTick(() => {
          serverSocket.emit('error', new Error('ECONNREFUSED'));
        });
        return serverSocket as unknown as net.Socket;
      }) as any);

      const req = createMockRequest({ url: 'api.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockLogger.error as any).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'api.example.com', error: 'ECONNREFUSED' }),
        'Tunnel connection failed',
      );
    });

    it('should log warning on connect timeout', async () => {
      const customTimeouts: TimeoutsConfig = {
        connectTimeout: 500,
        responseTimeout: 1000,
        idleTimeout: 2000,
        requestTimeout: 1000,
      };

      handler = new ConnectHandler({
        allowlistMatcher: mockAllowlistMatcher,
        rateLimiter: mockRateLimiter,
        auditLogger: mockAuditLogger,
        logger: mockLogger,
        timeouts: customTimeouts,
      });

      netConnectSpy.mockImplementation(((_port: number, _host: string, _callback?: () => void) => {
        const serverSocket = new MockSocket();
        return serverSocket as unknown as net.Socket;
      }) as any);

      const req = createMockRequest({ url: 'slow.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(600);
      await promise;

      expect(mockLogger.warn as any).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'slow.example.com', timeout: 500 }),
        'Tunnel connect timeout',
      );
    });
  });

  // 10. createConnectHandler factory
  describe('createConnectHandler', () => {
    it('should return a ConnectHandler instance', () => {
      const h = createConnectHandler({
        allowlistMatcher: mockAllowlistMatcher,
        rateLimiter: mockRateLimiter,
        auditLogger: mockAuditLogger,
        logger: mockLogger,
      });
      expect(h).toBeInstanceOf(ConnectHandler);
    });
  });

  // Edge case: multiple errors should not double-reject
  describe('double-error safety', () => {
    it('should handle multiple errors on server socket without throwing', async () => {
      netConnectSpy.mockImplementation(((_port: number, _host: string, _callback?: () => void) => {
        const serverSocket = new MockSocket();
        process.nextTick(() => {
          serverSocket.emit('error', new Error('first error'));
          serverSocket.emit('error', new Error('second error'));
        });
        return serverSocket as unknown as net.Socket;
      }) as any);

      const req = createMockRequest({ url: 'api.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      // Should not throw
      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(0);
      await expect(promise).resolves.toBeUndefined();
    });
  });

  // 200 response content
  describe('response format', () => {
    it('should include Proxy-Agent header in 200 response', async () => {
      const req = createMockRequest({ url: 'api.example.com:443' });
      const clientSocket = new MockSocket() as unknown as Socket;
      const head = Buffer.alloc(0);

      const promise = handler.handleConnect(req, clientSocket, head);
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      expect((clientSocket as any).write).toHaveBeenCalledWith(
        expect.stringContaining('Proxy-Agent: ts-agent-proxy'),
      );
    });
  });
});
