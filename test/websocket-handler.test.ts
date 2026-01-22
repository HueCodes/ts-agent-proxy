import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { WebSocketHandler, createWebSocketHandler } from '../src/proxy/websocket-handler.js';
import type { AllowlistMatcher } from '../src/filter/allowlist-matcher.js';
import type { RateLimiter } from '../src/filter/rate-limiter.js';
import type { AuditLogger } from '../src/logging/audit-logger.js';
import type { Logger } from '../src/logging/logger.js';

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

    expect(mockSocket.write).toHaveBeenCalledWith(
      expect.stringContaining('400 Bad Request')
    );
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

    expect(mockSocket.write).toHaveBeenCalledWith(
      expect.stringContaining('400 Bad Request')
    );
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
      })
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

    expect(mockSocket.write).toHaveBeenCalledWith(
      expect.stringContaining('403 Forbidden')
    );
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

    expect(mockSocket.write).toHaveBeenCalledWith(
      expect.stringContaining('429 Too Many Requests')
    );
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
      })
    );
  });
});
