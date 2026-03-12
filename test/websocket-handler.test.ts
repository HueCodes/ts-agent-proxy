import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import { WebSocketHandler, createWebSocketHandler } from '../src/proxy/websocket-handler.js';
import type { AllowlistMatcher } from '../src/filter/allowlist-matcher.js';
import type { RateLimiter } from '../src/filter/rate-limiter.js';
import type { AuditLogger } from '../src/logging/audit-logger.js';
import type { Logger } from '../src/logging/logger.js';

vi.mock('node:net', async () => {
  const actual = await vi.importActual('node:net');
  return {
    ...actual,
    default: {
      ...(actual as any).default,
      connect: vi.fn(),
    },
  };
});

vi.mock('node:tls', async () => {
  const actual = await vi.importActual('node:tls');
  return {
    ...actual,
    default: {
      ...(actual as any).default,
      connect: vi.fn(),
    },
  };
});

describe('WebSocketHandler', () => {
  let handler: WebSocketHandler;
  let mockAllowlistMatcher: AllowlistMatcher;
  let mockRateLimiter: RateLimiter;
  let mockAuditLogger: AuditLogger;
  let mockLogger: Logger;

  beforeEach(() => {
    mockAllowlistMatcher = {
      match: vi.fn().mockReturnValue({ allowed: true, reason: 'Matched' }),
      reload: vi.fn(),
      getConfig: vi.fn(),
    } as unknown as AllowlistMatcher;

    mockRateLimiter = {
      consume: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }),
      clear: vi.fn(),
      registerRules: vi.fn(),
    } as unknown as RateLimiter;

    mockAuditLogger = {
      logRequest: vi.fn(),
      logRateLimit: vi.fn(),
      logError: vi.fn(),
    } as unknown as AuditLogger;

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as Logger;

    handler = new WebSocketHandler({
      allowlistMatcher: mockAllowlistMatcher,
      rateLimiter: mockRateLimiter,
      auditLogger: mockAuditLogger,
      logger: mockLogger,
    });
  });

  describe('isWebSocketUpgrade', () => {
    it('should detect WebSocket upgrade request', () => {
      const req = {
        headers: {
          upgrade: 'websocket',
          connection: 'Upgrade',
        },
      } as IncomingMessage;

      expect(WebSocketHandler.isWebSocketUpgrade(req)).toBe(true);
    });

    it('should detect WebSocket with multiple connection values', () => {
      const req = {
        headers: {
          upgrade: 'websocket',
          connection: 'keep-alive, Upgrade',
        },
      } as IncomingMessage;

      expect(WebSocketHandler.isWebSocketUpgrade(req)).toBe(true);
    });

    it('should return false for non-WebSocket upgrade', () => {
      const req = {
        headers: {
          upgrade: 'h2c',
          connection: 'Upgrade',
        },
      } as IncomingMessage;

      expect(WebSocketHandler.isWebSocketUpgrade(req)).toBe(false);
    });

    it('should return false for missing upgrade header', () => {
      const req = {
        headers: {
          connection: 'Upgrade',
        },
      } as IncomingMessage;

      expect(WebSocketHandler.isWebSocketUpgrade(req)).toBe(false);
    });

    it('should return false for missing connection header', () => {
      const req = {
        headers: {
          upgrade: 'websocket',
        },
      } as IncomingMessage;

      expect(WebSocketHandler.isWebSocketUpgrade(req)).toBe(false);
    });

    it('should return false for connection without upgrade', () => {
      const req = {
        headers: {
          upgrade: 'websocket',
          connection: 'keep-alive',
        },
      } as IncomingMessage;

      expect(WebSocketHandler.isWebSocketUpgrade(req)).toBe(false);
    });
  });

  describe('statistics', () => {
    it('should return initial statistics', () => {
      const stats = handler.getStats();

      expect(stats.totalConnections).toBe(0);
      expect(stats.activeConnections).toBe(0);
      expect(stats.messagesForwarded).toBe(0);
      expect(stats.bytesTransferred).toBe(0);
      expect(stats.connectionsRejected).toBe(0);
    });

    it('should reset statistics', () => {
      // Manually modify internal state for testing
      const stats = handler.getStats();
      stats.totalConnections = 10;

      handler.resetStats();

      expect(handler.getStats().totalConnections).toBe(0);
    });
  });

  describe('configuration', () => {
    it('should accept custom timeouts', () => {
      const customHandler = createWebSocketHandler({
        allowlistMatcher: mockAllowlistMatcher,
        rateLimiter: mockRateLimiter,
        auditLogger: mockAuditLogger,
        logger: mockLogger,
        connectionTimeout: 5000,
        idleTimeout: 60000,
        inspectMessages: true,
      });

      expect(customHandler).toBeDefined();
    });
  });

  describe('createWebSocketHandler', () => {
    it('should create handler instance', () => {
      const createdHandler = createWebSocketHandler({
        allowlistMatcher: mockAllowlistMatcher,
        rateLimiter: mockRateLimiter,
        auditLogger: mockAuditLogger,
        logger: mockLogger,
      });

      expect(createdHandler).toBeInstanceOf(WebSocketHandler);
    });
  });
});

describe('WebSocketHandler URL parsing', () => {
  let handler: WebSocketHandler;
  let mockAllowlistMatcher: AllowlistMatcher;
  let mockRateLimiter: RateLimiter;
  let mockAuditLogger: AuditLogger;
  let mockLogger: Logger;
  let mockSocket: any;

  beforeEach(() => {
    mockAllowlistMatcher = {
      match: vi.fn().mockReturnValue({ allowed: false, reason: 'Blocked' }),
      reload: vi.fn(),
      getConfig: vi.fn(),
    } as unknown as AllowlistMatcher;

    mockRateLimiter = {
      consume: vi.fn().mockResolvedValue({ allowed: true }),
      clear: vi.fn(),
      registerRules: vi.fn(),
    } as unknown as RateLimiter;

    mockAuditLogger = {
      logRequest: vi.fn(),
      logRateLimit: vi.fn(),
      logError: vi.fn(),
    } as unknown as AuditLogger;

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as Logger;

    mockSocket = {
      write: vi.fn(),
      destroy: vi.fn(),
      remoteAddress: '127.0.0.1',
      on: vi.fn(),
    };

    handler = new WebSocketHandler({
      allowlistMatcher: mockAllowlistMatcher,
      rateLimiter: mockRateLimiter,
      auditLogger: mockAuditLogger,
      logger: mockLogger,
    });
  });

  it('should reject request without host header', async () => {
    const req = {
      url: '/path',
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
      },
    } as IncomingMessage;

    await handler.handleUpgrade(req, mockSocket, Buffer.alloc(0));

    expect(mockSocket.write).toHaveBeenCalledWith(expect.stringContaining('400 Bad Request'));
    expect(mockSocket.destroy).toHaveBeenCalled();
  });

  it('should reject non-WebSocket upgrade', async () => {
    const req = {
      url: '/path',
      headers: {
        host: 'example.com',
        upgrade: 'h2c',
        connection: 'Upgrade',
      },
    } as IncomingMessage;

    await handler.handleUpgrade(req, mockSocket, Buffer.alloc(0));

    expect(mockSocket.write).toHaveBeenCalledWith(expect.stringContaining('400 Bad Request'));
  });

  it('should check allowlist for WebSocket requests', async () => {
    const req = {
      url: '/ws',
      headers: {
        host: 'api.example.com',
        upgrade: 'websocket',
        connection: 'Upgrade',
      },
      socket: { remoteAddress: '192.168.1.1' },
    } as unknown as IncomingMessage;

    await handler.handleUpgrade(req, mockSocket, Buffer.alloc(0));

    expect(mockAllowlistMatcher.match).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'api.example.com',
        path: '/ws',
      }),
    );
  });

  it('should reject when allowlist denies', async () => {
    mockAllowlistMatcher.match = vi.fn().mockReturnValue({
      allowed: false,
      reason: 'Not allowed',
    });

    const req = {
      url: '/ws',
      headers: {
        host: 'blocked.example.com',
        upgrade: 'websocket',
        connection: 'Upgrade',
      },
      socket: { remoteAddress: '192.168.1.1' },
    } as unknown as IncomingMessage;

    await handler.handleUpgrade(req, mockSocket, Buffer.alloc(0));

    expect(mockSocket.write).toHaveBeenCalledWith(expect.stringContaining('403 Forbidden'));
    expect(mockAuditLogger.logRequest).toHaveBeenCalled();
  });

  it('should check rate limiting', async () => {
    mockAllowlistMatcher.match = vi.fn().mockReturnValue({
      allowed: true,
      reason: 'Allowed',
      matchedRule: { id: 'test-rule' },
    });

    mockRateLimiter.consume = vi.fn().mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetMs: 60000,
    });

    const req = {
      url: '/ws',
      headers: {
        host: 'api.example.com',
        upgrade: 'websocket',
        connection: 'Upgrade',
      },
      socket: { remoteAddress: '192.168.1.1' },
    } as unknown as IncomingMessage;

    await handler.handleUpgrade(req, mockSocket, Buffer.alloc(0));

    expect(mockSocket.write).toHaveBeenCalledWith(expect.stringContaining('429 Too Many Requests'));
    expect(mockAuditLogger.logRateLimit).toHaveBeenCalled();
  });

  it('should extract client IP from x-forwarded-for', async () => {
    mockAllowlistMatcher.match = vi.fn().mockReturnValue({
      allowed: false,
      reason: 'Blocked',
    });

    const req = {
      url: '/ws',
      headers: {
        host: 'api.example.com',
        upgrade: 'websocket',
        connection: 'Upgrade',
        'x-forwarded-for': '10.0.0.1, 192.168.1.1',
      },
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as IncomingMessage;

    await handler.handleUpgrade(req, mockSocket, Buffer.alloc(0));

    expect(mockAllowlistMatcher.match).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceIp: '10.0.0.1',
      }),
    );
  });
});

/**
 * Helper to create a mock socket (EventEmitter with socket methods).
 */
function createMockSocket(): EventEmitter & {
  write: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  setTimeout: ReturnType<typeof vi.fn>;
  remoteAddress?: string;
} {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    write: vi.fn(),
    destroy: vi.fn(),
    setTimeout: vi.fn(),
    remoteAddress: '127.0.0.1',
  });
}

function createMocks() {
  const mockAllowlistMatcher = {
    match: vi.fn().mockReturnValue({ allowed: true, reason: 'Matched', matchedRule: { id: 'rule1' } }),
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

function makeUpgradeReq(overrides: Partial<{
  url: string;
  host: string;
  headers: Record<string, string | string[]>;
  encrypted: boolean;
}> = {}) {
  return {
    url: overrides.url ?? '/ws',
    headers: {
      host: overrides.host ?? 'example.com',
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      ...(overrides.headers ?? {}),
    },
    socket: { remoteAddress: '127.0.0.1', encrypted: overrides.encrypted ?? false },
  } as unknown as IncomingMessage;
}

describe('WebSocketHandler proxyWebSocket', () => {
  let mocks: ReturnType<typeof createMocks>;
  let handler: WebSocketHandler;
  let mockUpstreamSocket: ReturnType<typeof createMockSocket>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMocks();
    handler = new WebSocketHandler({
      ...mocks,
      allowlistMatcher: mocks.mockAllowlistMatcher,
      rateLimiter: mocks.mockRateLimiter,
      auditLogger: mocks.mockAuditLogger,
      logger: mocks.mockLogger,
      connectionTimeout: 5000,
      idleTimeout: 10000,
    });

    mockUpstreamSocket = createMockSocket();
    (net.connect as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockUpstreamSocket);
    (tls.connect as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockUpstreamSocket);
  });

  afterEach(() => {
    mockUpstreamSocket.removeAllListeners();
  });

  it('should connect to upstream via net.connect for ws:// URLs', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq({ url: '/chat', host: 'ws.example.com:8080' });

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    // Simulate connect event then 101 response
    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('connect')).toBeGreaterThan(0);
    });

    mockUpstreamSocket.emit('connect');
    const upgradeResponse = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n';
    mockUpstreamSocket.emit('data', Buffer.from(upgradeResponse));

    await upgradePromise;

    expect(net.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'ws.example.com',
        port: 8080,
      }),
    );
    expect(clientSocket.write).toHaveBeenCalledWith(
      Buffer.from(upgradeResponse),
    );
  });

  it('should connect via tls.connect for wss:// URLs', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq({ url: 'wss://secure.example.com/ws' });

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('connect')).toBeGreaterThan(0);
    });

    mockUpstreamSocket.emit('connect');
    const upgradeResponse = 'HTTP/1.1 101 Switching Protocols\r\n\r\n';
    mockUpstreamSocket.emit('data', Buffer.from(upgradeResponse));

    await upgradePromise;

    expect(tls.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'secure.example.com',
        port: 443,
        servername: 'secure.example.com',
      }),
    );
  });

  it('should connect via tls.connect for https:// URLs', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq({ url: 'https://secure.example.com:9443/ws' });

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('connect')).toBeGreaterThan(0);
    });

    mockUpstreamSocket.emit('connect');
    mockUpstreamSocket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));

    await upgradePromise;

    expect(tls.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'secure.example.com',
        port: 9443,
      }),
    );
  });

  it('should use net.connect for http:// URLs', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq({ url: 'http://plain.example.com/ws' });

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('connect')).toBeGreaterThan(0);
    });

    mockUpstreamSocket.emit('connect');
    mockUpstreamSocket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));

    await upgradePromise;

    expect(net.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'plain.example.com',
        port: 80,
      }),
    );
  });

  it('should write upgrade request headers including forwarded headers on connect', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq({
      host: 'example.com',
      url: '/ws?token=abc',
      headers: {
        origin: 'https://app.example.com',
        'sec-websocket-protocol': 'graphql-ws',
      },
    });

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('connect')).toBeGreaterThan(0);
    });

    mockUpstreamSocket.emit('connect');

    // Check the upgrade request written to upstream
    const writtenData = mockUpstreamSocket.write.mock.calls[0]![0] as string;
    expect(writtenData).toContain('GET /ws?token=abc HTTP/1.1');
    expect(writtenData).toContain('Host: example.com');
    expect(writtenData).toContain('upgrade: websocket');
    expect(writtenData).toContain('connection: Upgrade');
    expect(writtenData).toContain('sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==');
    expect(writtenData).toContain('origin: https://app.example.com');
    expect(writtenData).toContain('sec-websocket-protocol: graphql-ws');

    mockUpstreamSocket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
    await upgradePromise;
  });

  it('should write head buffer after upgrade request if head is non-empty', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq();
    const headData = Buffer.from('initial-data');

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, headData);

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('connect')).toBeGreaterThan(0);
    });

    mockUpstreamSocket.emit('connect');

    // First write is the upgrade request, second is the head buffer
    expect(mockUpstreamSocket.write).toHaveBeenCalledTimes(2);
    expect(mockUpstreamSocket.write.mock.calls[1]![0]).toEqual(headData);

    mockUpstreamSocket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
    await upgradePromise;
  });

  it('should reject when upstream returns non-101 response', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq();

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('connect')).toBeGreaterThan(0);
    });

    mockUpstreamSocket.emit('connect');
    const errorResponse = 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n';
    mockUpstreamSocket.emit('data', Buffer.from(errorResponse));

    // Should catch error internally and call rejectUpgrade with 502
    await upgradePromise;

    // The error response is forwarded to client, then socket destroyed
    expect(clientSocket.write).toHaveBeenCalled();
    expect(mockUpstreamSocket.destroy).toHaveBeenCalled();
    // The catch block in handleUpgrade logs the error and rejects with 502
    expect(mocks.mockLogger.error).toHaveBeenCalled();
    expect(mocks.mockAuditLogger.logError).toHaveBeenCalled();
  });

  it('should handle upstream connection timeout', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq();

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('timeout')).toBeGreaterThan(0);
    });

    mockUpstreamSocket.emit('timeout');

    // The timeout rejects the promise, which is caught in handleUpgrade
    await upgradePromise;

    expect(mockUpstreamSocket.destroy).toHaveBeenCalled();
    expect(mocks.mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'example.com' }),
      'WebSocket upstream timeout',
    );
    expect(mocks.mockLogger.error).toHaveBeenCalled();
  });

  it('should handle upstream connection error', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq();

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('error')).toBeGreaterThan(0);
    });

    mockUpstreamSocket.emit('error', new Error('ECONNREFUSED'));

    await upgradePromise;

    expect(mocks.mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      expect.any(String),
    );
    expect(mocks.mockAuditLogger.logError).toHaveBeenCalled();
  });

  it('should increment activeConnections on connect and decrement on client close', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq();

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('connect')).toBeGreaterThan(0);
    });

    mockUpstreamSocket.emit('connect');
    expect(handler.getStats().activeConnections).toBe(1);

    mockUpstreamSocket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
    await upgradePromise;

    // Simulate client close
    clientSocket.emit('close');
    expect(handler.getStats().activeConnections).toBe(0);
    expect(mockUpstreamSocket.destroy).toHaveBeenCalled();
  });

  it('should destroy client socket when upstream closes', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq();

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('connect')).toBeGreaterThan(0);
    });

    mockUpstreamSocket.emit('connect');
    mockUpstreamSocket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
    await upgradePromise;

    mockUpstreamSocket.emit('close');
    expect(clientSocket.destroy).toHaveBeenCalled();
  });

  it('should destroy upstream socket when client errors', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq();

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('connect')).toBeGreaterThan(0);
    });

    mockUpstreamSocket.emit('connect');
    mockUpstreamSocket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
    await upgradePromise;

    clientSocket.emit('error', new Error('client reset'));
    expect(mockUpstreamSocket.destroy).toHaveBeenCalled();
  });

  it('should forward remaining data after upgrade response headers', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq();

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('connect')).toBeGreaterThan(0);
    });

    mockUpstreamSocket.emit('connect');
    // Send 101 response with trailing data in same chunk
    const responseWithData = 'HTTP/1.1 101 Switching Protocols\r\n\r\nextra-frame-data';
    mockUpstreamSocket.emit('data', Buffer.from(responseWithData));

    await upgradePromise;

    // First write: the response headers, second write: the remaining data
    const writes = clientSocket.write.mock.calls;
    expect(writes.length).toBe(2);
    expect(writes[1]![0].toString()).toBe('extra-frame-data');
    expect(handler.getStats().bytesTransferred).toBe(Buffer.byteLength('extra-frame-data'));
  });

  it('should pipe upstream data to client after headers are parsed', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq();

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('connect')).toBeGreaterThan(0);
    });

    mockUpstreamSocket.emit('connect');
    mockUpstreamSocket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));

    await upgradePromise;

    // Now send data from upstream after headers parsed
    const wsFrame = Buffer.from('ws-frame-payload');
    mockUpstreamSocket.emit('data', wsFrame);

    expect(clientSocket.write).toHaveBeenCalledWith(wsFrame);
    expect(handler.getStats().messagesForwarded).toBe(1);
    expect(handler.getStats().bytesTransferred).toBe(wsFrame.length);
  });

  it('should pipe client data to upstream after headers are parsed', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq();

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('connect')).toBeGreaterThan(0);
    });

    mockUpstreamSocket.emit('connect');
    mockUpstreamSocket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));

    await upgradePromise;

    // Send data from client to upstream
    const clientData = Buffer.from('client-message');
    clientSocket.emit('data', clientData);

    expect(mockUpstreamSocket.write).toHaveBeenCalledWith(clientData);
    expect(handler.getStats().messagesForwarded).toBe(1);
    expect(handler.getStats().bytesTransferred).toBe(clientData.length);
  });

  it('should not pipe client data to upstream before headers are parsed', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq();

    handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('connect')).toBeGreaterThan(0);
    });

    mockUpstreamSocket.emit('connect');

    // Clear the write call from the upgrade request
    mockUpstreamSocket.write.mockClear();

    // Client sends data before headers parsed - should be ignored
    clientSocket.emit('data', Buffer.from('early-data'));

    expect(mockUpstreamSocket.write).not.toHaveBeenCalled();
  });

  it('should handle chunked upgrade response headers', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq();

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('connect')).toBeGreaterThan(0);
    });

    mockUpstreamSocket.emit('connect');
    // Send response in two chunks
    mockUpstreamSocket.emit('data', Buffer.from('HTTP/1.1 101 Switching'));
    mockUpstreamSocket.emit('data', Buffer.from(' Protocols\r\n\r\n'));

    await upgradePromise;

    expect(clientSocket.write).toHaveBeenCalled();
  });

  it('should increment totalConnections and connectionsRejected on proxy error', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq();

    handler.resetStats();
    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('error')).toBeGreaterThan(0);
    });

    mockUpstreamSocket.emit('error', new Error('connection failed'));

    await upgradePromise;

    expect(handler.getStats().totalConnections).toBe(1);
    // rejectUpgrade is called with 502
    expect(clientSocket.write).toHaveBeenCalledWith(expect.stringContaining('502 Bad Gateway'));
  });
});

describe('WebSocketHandler setupPipe (idle timeout)', () => {
  let mocks: ReturnType<typeof createMocks>;
  let handler: WebSocketHandler;
  let mockUpstreamSocket: ReturnType<typeof createMockSocket>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMocks();
    handler = new WebSocketHandler({
      ...mocks,
      allowlistMatcher: mocks.mockAllowlistMatcher,
      rateLimiter: mocks.mockRateLimiter,
      auditLogger: mocks.mockAuditLogger,
      logger: mocks.mockLogger,
      connectionTimeout: 5000,
      idleTimeout: 10000,
    });

    mockUpstreamSocket = createMockSocket();
    (net.connect as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockUpstreamSocket);
  });

  afterEach(() => {
    mockUpstreamSocket.removeAllListeners();
  });

  it('should set idle timeout on upstream socket after successful upgrade', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq();

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('connect')).toBeGreaterThan(0);
    });

    mockUpstreamSocket.emit('connect');
    mockUpstreamSocket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
    await upgradePromise;

    // setupPipe sets idle timeout
    expect(mockUpstreamSocket.setTimeout).toHaveBeenCalledWith(10000);
    expect(clientSocket.setTimeout).toHaveBeenCalledWith(10000);
  });

  it('should destroy both sockets on idle timeout after successful upgrade', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq();

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('connect')).toBeGreaterThan(0);
    });

    mockUpstreamSocket.emit('connect');
    mockUpstreamSocket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
    await upgradePromise;

    // setupPipe adds a NEW timeout handler for idle timeout
    // The 'timeout' event from connect handler was already bound, but setupPipe adds another
    // We need to trigger timeout after setup - emit it
    mockUpstreamSocket.emit('timeout');

    expect(mockUpstreamSocket.destroy).toHaveBeenCalled();
    expect(clientSocket.destroy).toHaveBeenCalled();
  });

  it('should log the successful WebSocket connection via audit logger', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq();

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('connect')).toBeGreaterThan(0);
    });

    mockUpstreamSocket.emit('connect');
    mockUpstreamSocket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
    await upgradePromise;

    expect(mocks.mockAuditLogger.logRequest).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'example.com' }),
      expect.objectContaining({ allowed: true }),
      expect.objectContaining({
        durationMs: 0,
        response: { statusCode: 101, statusMessage: 'Switching Protocols' },
      }),
    );
  });
});

describe('WebSocketHandler parseTargetUrl edge cases', () => {
  let mocks: ReturnType<typeof createMocks>;
  let handler: WebSocketHandler;
  let mockUpstreamSocket: ReturnType<typeof createMockSocket>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMocks();
    handler = new WebSocketHandler({
      ...mocks,
      allowlistMatcher: mocks.mockAllowlistMatcher,
      rateLimiter: mocks.mockRateLimiter,
      auditLogger: mocks.mockAuditLogger,
      logger: mocks.mockLogger,
    });

    mockUpstreamSocket = createMockSocket();
    (net.connect as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockUpstreamSocket);
    (tls.connect as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockUpstreamSocket);
  });

  afterEach(() => {
    mockUpstreamSocket.removeAllListeners();
  });

  it('should construct wss:// URL when socket is encrypted', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq({ encrypted: true });

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('connect')).toBeGreaterThan(0);
    });

    // Since encrypted socket -> wss:// -> isSecure = true -> tls.connect
    expect(tls.connect).toHaveBeenCalled();

    mockUpstreamSocket.emit('connect');
    mockUpstreamSocket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
    await upgradePromise;
  });

  it('should handle ws:// full URL correctly', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq({ url: 'ws://ws.example.com:9090/path' });

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('connect')).toBeGreaterThan(0);
    });

    expect(net.connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'ws.example.com', port: 9090 }),
    );

    mockUpstreamSocket.emit('connect');
    mockUpstreamSocket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
    await upgradePromise;
  });

  it('should use default port 80 for ws:// without explicit port', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq({ url: 'ws://ws.example.com/path' });

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('connect')).toBeGreaterThan(0);
    });

    expect(net.connect).toHaveBeenCalledWith(
      expect.objectContaining({ port: 80 }),
    );

    mockUpstreamSocket.emit('connect');
    mockUpstreamSocket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
    await upgradePromise;
  });

  it('should use default port 443 for wss:// without explicit port', async () => {
    const clientSocket = createMockSocket();
    const req = makeUpgradeReq({ url: 'wss://wss.example.com/path' });

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('connect')).toBeGreaterThan(0);
    });

    expect(tls.connect).toHaveBeenCalledWith(
      expect.objectContaining({ port: 443 }),
    );

    mockUpstreamSocket.emit('connect');
    mockUpstreamSocket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
    await upgradePromise;
  });

  it('should handle missing req.url gracefully (defaults to /)', async () => {
    // allowlist blocks to avoid needing upstream socket setup
    (mocks.mockAllowlistMatcher.match as ReturnType<typeof vi.fn>).mockReturnValue({ allowed: false, reason: 'Blocked' });

    const clientSocket = createMockSocket();
    const req = {
      url: undefined,
      headers: {
        host: 'example.com',
        upgrade: 'websocket',
        connection: 'Upgrade',
      },
      socket: { remoteAddress: '127.0.0.1', encrypted: false },
    } as unknown as IncomingMessage;

    await handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    // Should parse successfully (url defaults to /) and reach allowlist check
    expect(mocks.mockAllowlistMatcher.match).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/' }),
    );
  });

  it('should reject with 400 for non-websocket upgrade', async () => {
    const clientSocket = createMockSocket();
    const req = {
      url: '/path',
      headers: {
        host: 'example.com',
        upgrade: 'h2c',
        connection: 'Upgrade',
      },
      socket: { remoteAddress: '127.0.0.1', encrypted: false },
    } as unknown as IncomingMessage;

    await handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    // Non-websocket upgrade should be rejected with 400
    expect(clientSocket.write).toHaveBeenCalledWith(expect.stringContaining('400'));
  });
});

describe('WebSocketHandler rejectUpgrade', () => {
  let mocks: ReturnType<typeof createMocks>;
  let handler: WebSocketHandler;

  beforeEach(() => {
    mocks = createMocks();
    handler = new WebSocketHandler({
      ...mocks,
      allowlistMatcher: mocks.mockAllowlistMatcher,
      rateLimiter: mocks.mockRateLimiter,
      auditLogger: mocks.mockAuditLogger,
      logger: mocks.mockLogger,
    });
  });

  it('should format HTTP rejection response with correct status code and message', async () => {
    const clientSocket = createMockSocket();
    const req = {
      url: '/ws',
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        // No host header -> 400
      },
      socket: { remoteAddress: '127.0.0.1', encrypted: false },
    } as unknown as IncomingMessage;

    await handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    const response = clientSocket.write.mock.calls[0]![0] as string;
    expect(response).toContain('HTTP/1.1 400');
    expect(response).toContain('Content-Type: text/plain');
    expect(response).toContain('Connection: close');
    expect(response).toContain('Content-Length:');
    expect(clientSocket.destroy).toHaveBeenCalled();
  });

  it('should format 403 Forbidden response for denied requests', async () => {
    (mocks.mockAllowlistMatcher.match as ReturnType<typeof vi.fn>).mockReturnValue({
      allowed: false,
      reason: 'Not allowed',
    });

    const clientSocket = createMockSocket();
    const req = makeUpgradeReq();

    await handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    const response = clientSocket.write.mock.calls[0]![0] as string;
    expect(response).toContain('HTTP/1.1 403');
    expect(response).toContain('Forbidden: WebSocket target not allowed');
  });

  it('should format 429 Too Many Requests response', async () => {
    (mocks.mockRateLimiter.consume as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false,
      remaining: 0,
    });

    const clientSocket = createMockSocket();
    const req = makeUpgradeReq();

    await handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    const response = clientSocket.write.mock.calls[0]![0] as string;
    expect(response).toContain('HTTP/1.1 429');
    expect(response).toContain('Too Many Requests');
  });

  it('should format 502 Bad Gateway when proxy fails', async () => {
    const mockUpstreamSocket = createMockSocket();
    (net.connect as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockUpstreamSocket);

    const clientSocket = createMockSocket();
    const req = makeUpgradeReq();

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('error')).toBeGreaterThan(0);
    });

    mockUpstreamSocket.emit('error', new Error('ECONNREFUSED'));
    await upgradePromise;

    // Find the 502 write (might be second call if upstream also wrote)
    const allWrites = clientSocket.write.mock.calls.map((c: any[]) => String(c[0]));
    expect(allWrites.some((w: string) => w.includes('502 Bad Gateway'))).toBe(true);
  });
});

describe('WebSocketHandler activeConnections edge case', () => {
  let mocks: ReturnType<typeof createMocks>;
  let handler: WebSocketHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMocks();
    handler = new WebSocketHandler({
      ...mocks,
      allowlistMatcher: mocks.mockAllowlistMatcher,
      rateLimiter: mocks.mockRateLimiter,
      auditLogger: mocks.mockAuditLogger,
      logger: mocks.mockLogger,
    });
  });

  it('should not go below 0 activeConnections on multiple closes', async () => {
    const mockUpstreamSocket = createMockSocket();
    (net.connect as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockUpstreamSocket);

    const clientSocket = createMockSocket();
    const req = makeUpgradeReq();

    const upgradePromise = handler.handleUpgrade(req, clientSocket as any, Buffer.alloc(0));

    await vi.waitFor(() => {
      expect(mockUpstreamSocket.listenerCount('connect')).toBeGreaterThan(0);
    });

    mockUpstreamSocket.emit('connect');
    mockUpstreamSocket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
    await upgradePromise;

    expect(handler.getStats().activeConnections).toBe(1);

    clientSocket.emit('close');
    expect(handler.getStats().activeConnections).toBe(0);

    // Second close should not go below 0
    clientSocket.emit('close');
    expect(handler.getStats().activeConnections).toBe(0);
  });
});
