import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { ProxyConfig } from '../src/types/config.js';
import type { AllowlistConfig } from '../src/types/allowlist.js';

// ---- Mock factories for dependencies ----

const mockAllowlistMatcher = {
  match: vi.fn().mockReturnValue({ allowed: true, reason: 'test' }),
  isDomainAllowed: vi.fn().mockReturnValue({ allowed: true, reason: 'test' }),
  reload: vi.fn(),
  getConfig: vi.fn().mockReturnValue({
    mode: 'strict',
    defaultAction: 'deny',
    rules: [],
  }),
};

const mockRateLimiter = {
  check: vi.fn().mockReturnValue({ allowed: true }),
  clear: vi.fn(),
  registerRules: vi.fn(),
};

const mockConnectHandler = {
  handleConnect: vi.fn().mockResolvedValue(undefined),
};

const mockForwardProxy = {
  handleRequest: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn(),
};

const mockCertManager = {
  initialize: vi.fn().mockResolvedValue(undefined),
  getCaCertPem: vi
    .fn()
    .mockReturnValue('-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----'),
};

const mockMitmInterceptor = {
  handleConnect: vi.fn().mockResolvedValue(undefined),
};

const mockWebSocketHandler = {
  handleUpgrade: vi.fn().mockResolvedValue(undefined),
  getStats: vi.fn().mockReturnValue({
    totalConnections: 0,
    activeConnections: 0,
    totalMessages: 0,
    totalBytesReceived: 0,
    totalBytesSent: 0,
  }),
};

const mockMetrics = {
  getMetrics: vi.fn().mockReturnValue({ requests: 0 }),
  recordRequest: vi.fn(),
};

const mockAdminServer = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
};

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

const mockAuditLogger = {
  log: vi.fn(),
  logConnect: vi.fn(),
  logRequest: vi.fn(),
};

const mockSendJsonError = vi.fn();
const mockGenerateRequestId = vi.fn().mockReturnValue('test-request-id');

// ---- Module mocks ----

vi.mock('../src/proxy/size-limiter.js', () => ({
  sendJsonError: (...args: unknown[]) => mockSendJsonError(...args),
  generateRequestId: () => mockGenerateRequestId(),
}));

vi.mock('../src/logging/logger.js', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

vi.mock('../src/logging/audit-logger.js', () => ({
  createAuditLogger: vi.fn(() => mockAuditLogger),
}));

vi.mock('../src/filter/allowlist-matcher.js', () => ({
  createAllowlistMatcher: vi.fn(() => mockAllowlistMatcher),
}));

vi.mock('../src/filter/rate-limiter.js', () => ({
  createRateLimiter: vi.fn(() => mockRateLimiter),
}));

vi.mock('../src/proxy/connect-handler.js', () => ({
  createConnectHandler: vi.fn(() => mockConnectHandler),
}));

vi.mock('../src/proxy/forward-proxy.js', () => ({
  createForwardProxy: vi.fn(() => mockForwardProxy),
}));

vi.mock('../src/proxy/mitm/cert-manager.js', () => ({
  createCertManager: vi.fn(() => mockCertManager),
}));

vi.mock('../src/proxy/mitm/interceptor.js', () => ({
  createMitmInterceptor: vi.fn(() => mockMitmInterceptor),
}));

vi.mock('../src/proxy/websocket-handler.js', () => ({
  createWebSocketHandler: vi.fn(() => mockWebSocketHandler),
  WebSocketHandler: {
    isWebSocketUpgrade: vi.fn().mockReturnValue(true),
  },
}));

vi.mock('../src/admin/metrics.js', () => ({
  createMetricsCollector: vi.fn(() => mockMetrics),
}));

vi.mock('../src/admin/admin-server.js', () => ({
  createAdminServer: vi.fn(() => mockAdminServer),
}));

// ---- Imports under test (must come after vi.mock calls) ----

import { ProxyServer, createProxyServer } from '../src/server.js';
import { createLogger } from '../src/logging/logger.js';
import { createAuditLogger } from '../src/logging/audit-logger.js';
import { createAllowlistMatcher } from '../src/filter/allowlist-matcher.js';
import { createRateLimiter } from '../src/filter/rate-limiter.js';
import { createConnectHandler } from '../src/proxy/connect-handler.js';
import { createForwardProxy } from '../src/proxy/forward-proxy.js';
import { createCertManager } from '../src/proxy/mitm/cert-manager.js';
import { createMitmInterceptor } from '../src/proxy/mitm/interceptor.js';
import { createWebSocketHandler, WebSocketHandler } from '../src/proxy/websocket-handler.js';
import { createMetricsCollector } from '../src/admin/metrics.js';
import { createAdminServer } from '../src/admin/admin-server.js';

// ---- Helpers ----

function createTunnelConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    server: {
      host: '127.0.0.1',
      port: 0,
      mode: 'tunnel',
      logging: {
        level: 'error',
        console: false,
      },
      ...overrides.server,
    },
    allowlist: {
      mode: 'strict',
      defaultAction: 'deny',
      rules: [{ id: 'test', domain: 'example.com', paths: ['/**'], methods: ['GET'] }],
      ...overrides.allowlist,
    },
  };
}

function createMitmConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return createTunnelConfig({
    ...overrides,
    server: {
      mode: 'mitm',
      tls: { autoGenerateCa: true },
      ...overrides.server,
    } as any,
  });
}

function createConfigWithAdmin(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return createTunnelConfig({
    ...overrides,
    server: {
      admin: { enabled: true, host: '127.0.0.1', port: 0 },
      ...overrides.server,
    } as any,
  });
}

/** Create a mock http.Server-like EventEmitter for testing server events. */
function createMockHttpServer(): EventEmitter & {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  address: ReturnType<typeof vi.fn>;
} {
  const emitter = new EventEmitter() as any;
  emitter.listen = vi.fn((_port: number, _host: string, cb: () => void) => {
    cb();
  });
  emitter.close = vi.fn((cb?: (err?: Error) => void) => {
    if (cb) cb();
  });
  emitter.address = vi.fn().mockReturnValue({ address: '127.0.0.1', port: 9999 });
  return emitter;
}

describe('ProxyServer', () => {
  let createServerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Spy on http.createServer to return a controllable mock
    const mockServer = createMockHttpServer();
    createServerSpy = vi.spyOn(http, 'createServer').mockReturnValue(mockServer as any);
  });

  afterEach(() => {
    createServerSpy?.mockRestore();
  });

  // ----------------------------------------------------------------
  // Constructor / Initialization
  // ----------------------------------------------------------------
  describe('constructor', () => {
    it('should create a server with tunnel mode config', () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      expect(createAllowlistMatcher).toHaveBeenCalledWith(config.allowlist);
      expect(createRateLimiter).toHaveBeenCalledWith(config.allowlist.rules);
      expect(createConnectHandler).toHaveBeenCalled();
      expect(createForwardProxy).toHaveBeenCalled();
      expect(createWebSocketHandler).toHaveBeenCalled();
      expect(createMetricsCollector).toHaveBeenCalled();
    });

    it('should use provided logger instead of creating one', () => {
      const config = createTunnelConfig();
      const customLogger = { ...mockLogger } as any;
      new ProxyServer({ config, logger: customLogger });

      // createLogger should still be importable but the custom logger should be used
      // The key indicator: createAuditLogger receives the custom logger
      expect(createAuditLogger).toHaveBeenCalledWith(
        expect.objectContaining({ logger: customLogger }),
      );
    });

    it('should create a default logger when none provided', () => {
      const config = createTunnelConfig();
      new ProxyServer({ config });

      expect(createLogger).toHaveBeenCalledWith({
        level: config.server.logging.level,
        pretty: config.server.logging.pretty,
      });
    });

    it('should not create MITM components in tunnel mode', () => {
      const config = createTunnelConfig();
      new ProxyServer({ config });

      expect(createCertManager).not.toHaveBeenCalled();
      expect(createMitmInterceptor).not.toHaveBeenCalled();
    });

    it('should create MITM components in mitm mode', () => {
      const config = createMitmConfig();
      new ProxyServer({ config });

      expect(createCertManager).toHaveBeenCalledWith(
        expect.objectContaining({ autoGenerate: true }),
      );
      expect(createMitmInterceptor).toHaveBeenCalledWith(
        expect.objectContaining({ certManager: mockCertManager }),
      );
    });

    it('should not create admin server when admin is not enabled', () => {
      const config = createTunnelConfig();
      new ProxyServer({ config });

      expect(createAdminServer).not.toHaveBeenCalled();
    });

    it('should create admin server when admin is enabled', () => {
      const config = createConfigWithAdmin();
      new ProxyServer({ config });

      expect(createAdminServer).toHaveBeenCalledWith(
        expect.objectContaining({
          host: '127.0.0.1',
          port: 0,
          logger: expect.anything(),
          metrics: mockMetrics,
        }),
      );
    });

    it('should pass handler options to connect handler and forward proxy', () => {
      const config = createTunnelConfig();
      new ProxyServer({ config });

      const expectedHandlerOptions = expect.objectContaining({
        allowlistMatcher: mockAllowlistMatcher,
        rateLimiter: mockRateLimiter,
        auditLogger: mockAuditLogger,
      });

      expect(createConnectHandler).toHaveBeenCalledWith(expectedHandlerOptions);
      expect(createForwardProxy).toHaveBeenCalledWith(expectedHandlerOptions);
    });
  });

  // ----------------------------------------------------------------
  // initialize()
  // ----------------------------------------------------------------
  describe('initialize', () => {
    it('should initialize cert manager in mitm mode', async () => {
      const config = createMitmConfig();
      const server = new ProxyServer({ config });

      await server.initialize();

      expect(mockCertManager.initialize).toHaveBeenCalled();
    });

    it('should not initialize cert manager in tunnel mode', async () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      await server.initialize();

      expect(mockCertManager.initialize).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------
  // start() / stop() lifecycle
  // ----------------------------------------------------------------
  describe('start', () => {
    it('should create an http server and start listening', async () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      await server.start();

      expect(http.createServer).toHaveBeenCalled();
      const mockHttpServer = createServerSpy.mock.results[0].value;
      expect(mockHttpServer.listen).toHaveBeenCalledWith(
        config.server.port,
        config.server.host,
        expect.any(Function),
      );
    });

    it('should register connect, upgrade, and error event handlers', async () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      await server.start();

      const mockHttpServer = createServerSpy.mock.results[0].value as EventEmitter;
      expect(mockHttpServer.listenerCount('connect')).toBe(1);
      expect(mockHttpServer.listenerCount('upgrade')).toBe(1);
      expect(mockHttpServer.listenerCount('error')).toBe(1);
    });

    it('should start admin server when enabled', async () => {
      const config = createConfigWithAdmin();
      const server = new ProxyServer({ config });

      await server.start();

      expect(mockAdminServer.start).toHaveBeenCalled();
    });

    it('should not start admin server when not enabled', async () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      await server.start();

      expect(mockAdminServer.start).not.toHaveBeenCalled();
    });

    it('should call initialize (cert manager) before listening', async () => {
      const config = createMitmConfig();
      const server = new ProxyServer({ config });

      await server.start();

      expect(mockCertManager.initialize).toHaveBeenCalled();
    });

    it('should set isRunning after listen callback', async () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      // Before start, getAddress returns null (no server yet)
      expect(server.getAddress()).toBeNull();

      await server.start();

      // After start, address should be available
      const addr = server.getAddress();
      expect(addr).toEqual({ host: '127.0.0.1', port: 9999 });
    });
  });

  describe('stop', () => {
    it('should close the http server', async () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      await server.start();
      await server.stop();

      const mockHttpServer = createServerSpy.mock.results[0].value;
      expect(mockHttpServer.close).toHaveBeenCalled();
    });

    it('should stop admin server after closing main server', async () => {
      const config = createConfigWithAdmin();
      const server = new ProxyServer({ config });

      await server.start();

      const callOrder: string[] = [];
      mockAdminServer.stop.mockImplementation(() => {
        callOrder.push('admin-stop');
        return Promise.resolve();
      });
      const mockHttpServer = createServerSpy.mock.results[0].value;
      mockHttpServer.close.mockImplementation((cb?: (err?: Error) => void) => {
        callOrder.push('server-close');
        if (cb) cb();
      });

      await server.stop();

      expect(callOrder).toEqual(['server-close', 'admin-stop']);
    });

    it('should resolve without error when server was never started', async () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      // stop() without start() should not throw
      await expect(server.stop()).resolves.toBeUndefined();
    });

    it('should resolve and log error when server.close reports an error', async () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      await server.start();

      const closeError = new Error('close failed');
      const mockHttpServer = createServerSpy.mock.results[0].value;
      mockHttpServer.close.mockImplementation((cb?: (err?: Error) => void) => {
        if (cb) cb(closeError);
      });

      await expect(server.stop()).resolves.toBeUndefined();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: closeError }),
        expect.stringContaining('Error during server close'),
      );
    });
  });

  // ----------------------------------------------------------------
  // Request handling
  // ----------------------------------------------------------------
  describe('handleRequest (HTTP forwarding)', () => {
    it('should delegate HTTP requests to forwardProxy', async () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      await server.start();

      // Grab the request handler passed to createServer
      const requestHandler = (http.createServer as any).mock.calls[0][0];
      const mockReq = { url: 'http://example.com/' } as any;
      const mockRes = {
        headersSent: false,
        writeHead: vi.fn(),
        end: vi.fn(),
      } as any;

      requestHandler(mockReq, mockRes);

      expect(mockForwardProxy.handleRequest).toHaveBeenCalledWith(mockReq, mockRes);
    });

    it('should send 500 JSON error if forwardProxy rejects and headers not sent', async () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      mockForwardProxy.handleRequest.mockRejectedValueOnce(new Error('proxy error'));

      await server.start();

      const requestHandler = (http.createServer as any).mock.calls[0][0];
      const mockReq = { url: 'http://example.com/' } as any;
      const mockRes = {
        headersSent: false,
        writeHead: vi.fn(),
        end: vi.fn(),
      } as any;

      requestHandler(mockReq, mockRes);

      // Wait for the async rejection to propagate
      await vi.waitFor(() => {
        expect(mockSendJsonError).toHaveBeenCalledWith(
          mockRes,
          500,
          'INTERNAL_ERROR',
          'Internal server error',
        );
      });
    });

    it('should not write response if headers already sent', async () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      mockForwardProxy.handleRequest.mockRejectedValueOnce(new Error('proxy error'));

      await server.start();

      const requestHandler = (http.createServer as any).mock.calls[0][0];
      const mockReq = { url: 'http://example.com/' } as any;
      const mockRes = {
        headersSent: true,
        writeHead: vi.fn(),
        end: vi.fn(),
      } as any;

      requestHandler(mockReq, mockRes);

      await vi.waitFor(() => {
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.objectContaining({ error: expect.any(Error) }),
          'Request handling error',
        );
      });

      expect(mockRes.writeHead).not.toHaveBeenCalled();
      expect(mockSendJsonError).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------
  // CONNECT handling
  // ----------------------------------------------------------------
  describe('handleConnect', () => {
    it('should delegate to connectHandler in tunnel mode', async () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      await server.start();

      const mockHttpServer = createServerSpy.mock.results[0].value as EventEmitter;
      const mockReq = { url: 'example.com:443' } as any;
      const mockSocket = { destroy: vi.fn() } as any;
      const head = Buffer.alloc(0);

      mockHttpServer.emit('connect', mockReq, mockSocket, head);

      expect(mockConnectHandler.handleConnect).toHaveBeenCalledWith(mockReq, mockSocket, head);
    });

    it('should delegate to mitmInterceptor in mitm mode', async () => {
      const config = createMitmConfig();
      const server = new ProxyServer({ config });

      await server.start();

      const mockHttpServer = createServerSpy.mock.results[0].value as EventEmitter;
      const mockReq = { url: 'example.com:443' } as any;
      const mockSocket = { destroy: vi.fn() } as any;
      const head = Buffer.alloc(0);

      mockHttpServer.emit('connect', mockReq, mockSocket, head);

      expect(mockMitmInterceptor.handleConnect).toHaveBeenCalledWith(mockReq, mockSocket, head);
      expect(mockConnectHandler.handleConnect).not.toHaveBeenCalled();
    });

    it('should destroy socket on connect handler error in tunnel mode', async () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      mockConnectHandler.handleConnect.mockRejectedValueOnce(new Error('connect failed'));

      await server.start();

      const mockHttpServer = createServerSpy.mock.results[0].value as EventEmitter;
      const mockReq = { url: 'example.com:443' } as any;
      const mockSocket = { destroy: vi.fn() } as any;
      const head = Buffer.alloc(0);

      mockHttpServer.emit('connect', mockReq, mockSocket, head);

      await vi.waitFor(() => {
        expect(mockSocket.destroy).toHaveBeenCalled();
      });
    });

    it('should destroy socket on mitm interceptor error', async () => {
      const config = createMitmConfig();
      const server = new ProxyServer({ config });

      mockMitmInterceptor.handleConnect.mockRejectedValueOnce(new Error('mitm failed'));

      await server.start();

      const mockHttpServer = createServerSpy.mock.results[0].value as EventEmitter;
      const mockReq = { url: 'example.com:443' } as any;
      const mockSocket = { destroy: vi.fn() } as any;
      const head = Buffer.alloc(0);

      mockHttpServer.emit('connect', mockReq, mockSocket, head);

      await vi.waitFor(() => {
        expect(mockSocket.destroy).toHaveBeenCalled();
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.objectContaining({ error: expect.any(Error) }),
          'MITM handling error',
        );
      });
    });
  });

  // ----------------------------------------------------------------
  // Upgrade (WebSocket) handling
  // ----------------------------------------------------------------
  describe('handleUpgrade', () => {
    it('should delegate WebSocket upgrades to webSocketHandler', async () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      (WebSocketHandler.isWebSocketUpgrade as ReturnType<typeof vi.fn>).mockReturnValue(true);

      await server.start();

      const mockHttpServer = createServerSpy.mock.results[0].value as EventEmitter;
      const mockReq = { headers: { upgrade: 'websocket', connection: 'upgrade' } } as any;
      const mockSocket = { destroy: vi.fn(), write: vi.fn() } as any;
      const head = Buffer.alloc(0);

      mockHttpServer.emit('upgrade', mockReq, mockSocket, head);

      expect(mockWebSocketHandler.handleUpgrade).toHaveBeenCalledWith(mockReq, mockSocket, head);
    });

    it('should reject non-WebSocket upgrades with 400', async () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      (WebSocketHandler.isWebSocketUpgrade as ReturnType<typeof vi.fn>).mockReturnValue(false);

      await server.start();

      const mockHttpServer = createServerSpy.mock.results[0].value as EventEmitter;
      const mockReq = { headers: { upgrade: 'h2c' } } as any;
      const mockSocket = { destroy: vi.fn(), write: vi.fn() } as any;
      const head = Buffer.alloc(0);

      mockHttpServer.emit('upgrade', mockReq, mockSocket, head);

      expect(mockSocket.write).toHaveBeenCalledWith('HTTP/1.1 400 Bad Request\r\n\r\n');
      expect(mockSocket.destroy).toHaveBeenCalled();
      expect(mockWebSocketHandler.handleUpgrade).not.toHaveBeenCalled();
    });

    it('should destroy socket on WebSocket handler error', async () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      (WebSocketHandler.isWebSocketUpgrade as ReturnType<typeof vi.fn>).mockReturnValue(true);
      mockWebSocketHandler.handleUpgrade.mockRejectedValueOnce(new Error('ws error'));

      await server.start();

      const mockHttpServer = createServerSpy.mock.results[0].value as EventEmitter;
      const mockReq = { headers: { upgrade: 'websocket', connection: 'upgrade' } } as any;
      const mockSocket = { destroy: vi.fn(), write: vi.fn() } as any;
      const head = Buffer.alloc(0);

      mockHttpServer.emit('upgrade', mockReq, mockSocket, head);

      await vi.waitFor(() => {
        expect(mockSocket.destroy).toHaveBeenCalled();
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.objectContaining({ error: expect.any(Error) }),
          'WebSocket handling error',
        );
      });
    });
  });

  // ----------------------------------------------------------------
  // Server error event
  // ----------------------------------------------------------------
  describe('server error event', () => {
    it('should log server errors', async () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      await server.start();

      const mockHttpServer = createServerSpy.mock.results[0].value as EventEmitter;
      const error = new Error('EADDRINUSE');

      mockHttpServer.emit('error', error);

      expect(mockLogger.error).toHaveBeenCalledWith({ error }, 'Server error');
    });
  });

  // ----------------------------------------------------------------
  // reloadAllowlist
  // ----------------------------------------------------------------
  describe('reloadAllowlist', () => {
    it('should reload matcher and rate limiter with new config', () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      const newAllowlist: AllowlistConfig = {
        mode: 'permissive',
        defaultAction: 'allow',
        rules: [{ id: 'new-rule', domain: 'new.example.com' }],
      };

      server.reloadAllowlist(newAllowlist);

      expect(mockAllowlistMatcher.reload).toHaveBeenCalledWith(newAllowlist);
      expect(mockRateLimiter.clear).toHaveBeenCalled();
      expect(mockRateLimiter.registerRules).toHaveBeenCalledWith(newAllowlist.rules);
    });

    it('should log that configuration was reloaded', () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      server.reloadAllowlist({
        mode: 'strict',
        defaultAction: 'deny',
        rules: [],
      });

      expect(mockLogger.info).toHaveBeenCalledWith('Allowlist configuration reloaded');
    });
  });

  // ----------------------------------------------------------------
  // getAllowlistConfig
  // ----------------------------------------------------------------
  describe('getAllowlistConfig', () => {
    it('should return config from the matcher', () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      const result = server.getAllowlistConfig();
      expect(mockAllowlistMatcher.getConfig).toHaveBeenCalled();
      expect(result).toEqual({
        mode: 'strict',
        defaultAction: 'deny',
        rules: [],
      });
    });
  });

  // ----------------------------------------------------------------
  // getAddress
  // ----------------------------------------------------------------
  describe('getAddress', () => {
    it('should return null before server starts', () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });
      expect(server.getAddress()).toBeNull();
    });

    it('should return host and port after server starts', async () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      await server.start();

      const addr = server.getAddress();
      expect(addr).toEqual({ host: '127.0.0.1', port: 9999 });
    });

    it('should return null when server.address() returns a string', async () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      await server.start();

      const mockHttpServer = createServerSpy.mock.results[0].value;
      mockHttpServer.address.mockReturnValue('/tmp/test.sock');

      expect(server.getAddress()).toBeNull();
    });

    it('should return null when server.address() returns null', async () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      await server.start();

      const mockHttpServer = createServerSpy.mock.results[0].value;
      mockHttpServer.address.mockReturnValue(null);

      expect(server.getAddress()).toBeNull();
    });
  });

  // ----------------------------------------------------------------
  // getCaCertPem
  // ----------------------------------------------------------------
  describe('getCaCertPem', () => {
    it('should return null in tunnel mode (no cert manager)', () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });
      expect(server.getCaCertPem()).toBeNull();
    });

    it('should return CA cert PEM in mitm mode', () => {
      const config = createMitmConfig();
      const server = new ProxyServer({ config });

      const pem = server.getCaCertPem();
      expect(pem).toContain('BEGIN CERTIFICATE');
      expect(mockCertManager.getCaCertPem).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------
  // getMetrics
  // ----------------------------------------------------------------
  describe('getMetrics', () => {
    it('should call metrics collector with rules count', () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      server.getMetrics();

      expect(mockMetrics.getMetrics).toHaveBeenCalledWith(config.allowlist.rules.length);
    });
  });

  // ----------------------------------------------------------------
  // getMetricsCollector
  // ----------------------------------------------------------------
  describe('getMetricsCollector', () => {
    it('should return the metrics collector instance', () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      expect(server.getMetricsCollector()).toBe(mockMetrics);
    });
  });

  // ----------------------------------------------------------------
  // getWebSocketStats
  // ----------------------------------------------------------------
  describe('getWebSocketStats', () => {
    it('should return stats from websocket handler', () => {
      const config = createTunnelConfig();
      const server = new ProxyServer({ config });

      const stats = server.getWebSocketStats();
      expect(mockWebSocketHandler.getStats).toHaveBeenCalled();
      expect(stats).toEqual(expect.objectContaining({ totalConnections: 0 }));
    });
  });

  // ----------------------------------------------------------------
  // createProxyServer factory
  // ----------------------------------------------------------------
  describe('createProxyServer', () => {
    it('should return a ProxyServer instance', () => {
      const config = createTunnelConfig();
      const server = createProxyServer({ config });
      expect(server).toBeInstanceOf(ProxyServer);
    });
  });

  // ----------------------------------------------------------------
  // MITM mode with TLS path config
  // ----------------------------------------------------------------
  describe('MITM mode with TLS paths', () => {
    it('should pass caCertPath and caKeyPath to cert manager', () => {
      const config = createTunnelConfig({
        server: {
          mode: 'mitm',
          tls: {
            caCertPath: '/path/to/ca.pem',
            caKeyPath: '/path/to/ca-key.pem',
            autoGenerateCa: false,
          },
        } as any,
      });

      new ProxyServer({ config });

      expect(createCertManager).toHaveBeenCalledWith({
        caCertPath: '/path/to/ca.pem',
        caKeyPath: '/path/to/ca-key.pem',
        autoGenerate: false,
      });
    });
  });

  // ----------------------------------------------------------------
  // Admin server getRulesCount and isReady callbacks
  // ----------------------------------------------------------------
  describe('admin server callbacks', () => {
    it('should pass working getRulesCount callback', () => {
      const config = createConfigWithAdmin();
      new ProxyServer({ config });

      const callArgs = (createAdminServer as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.getRulesCount()).toBe(config.allowlist.rules.length);
    });

    it('should pass isReady callback that returns false before start', () => {
      const config = createConfigWithAdmin();
      new ProxyServer({ config });

      const callArgs = (createAdminServer as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.isReady()).toBe(false);
    });

    it('should pass isReady callback that returns true after start', async () => {
      const config = createConfigWithAdmin();
      const server = new ProxyServer({ config });

      await server.start();

      const callArgs = (createAdminServer as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.isReady()).toBe(true);
    });

    it('should pass isReady callback that returns false after stop', async () => {
      const config = createConfigWithAdmin();
      const server = new ProxyServer({ config });

      await server.start();
      await server.stop();

      const callArgs = (createAdminServer as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.isReady()).toBe(false);
    });
  });
});
