/**
 * Tests for the AdminServer module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { AdminServer, createAdminServer } from '../src/admin/admin-server.js';
import type { AdminServerConfig } from '../src/admin/admin-server.js';
import type { MetricsCollector, ProxyMetrics } from '../src/admin/metrics.js';
import type { PrometheusMetrics } from '../src/admin/prometheus-metrics.js';

// Mock logger
function createMockLogger() {
  const logger: any = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => logger),
    level: 'info',
  };
  return logger;
}

// Mock metrics collector
function createMockMetricsCollector(): MetricsCollector {
  return {
    recordRequest: vi.fn(),
    recordLatency: vi.fn(),
    connectionOpened: vi.fn(),
    connectionClosed: vi.fn(),
    reset: vi.fn(),
    registerSources: vi.fn(),
    getMetrics: vi.fn(
      (_rulesCount: number): ProxyMetrics => ({
        requestsTotal: 42,
        requestsAllowed: 30,
        requestsDenied: 10,
        requestsRateLimited: 2,
        activeConnections: 5,
        uptimeSeconds: 120,
        rulesCount: _rulesCount,
        timestamp: new Date().toISOString(),
        byRule: {},
      }),
    ),
  } as any;
}

// Mock prometheus metrics
function createMockPrometheusMetrics(): PrometheusMetrics {
  return {
    setRulesCount: vi.fn(),
    getMetrics: vi.fn(
      async () => '# HELP proxy_requests_total Total requests\nproxy_requests_total 42\n',
    ),
    getContentType: vi.fn(() => 'text/plain; version=0.0.4; charset=utf-8'),
    recordRequest: vi.fn(),
    recordLatency: vi.fn(),
    recordError: vi.fn(),
    recordRateLimit: vi.fn(),
    recordAllowlistMatch: vi.fn(),
    recordBytesTransferred: vi.fn(),
    setActiveConnections: vi.fn(),
    setConnectionPoolMetrics: vi.fn(),
    setCertCacheSize: vi.fn(),
    getRegistry: vi.fn(),
  } as any;
}

// Helper to make HTTP requests to the admin server
function request(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            headers: res.headers,
            body,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function createDefaultConfig(overrides: Partial<AdminServerConfig> = {}): AdminServerConfig {
  return {
    host: '127.0.0.1',
    port: 0, // Use port 0 to get a random available port
    logger: createMockLogger(),
    metrics: createMockMetricsCollector(),
    getRulesCount: () => 5,
    isReady: () => true,
    ...overrides,
  };
}

describe('AdminServer', () => {
  let server: AdminServer;
  let port: number;

  afterEach(async () => {
    if (server) {
      await server.stop().catch(() => {});
    }
  });

  async function startServer(overrides: Partial<AdminServerConfig> = {}): Promise<void> {
    const config = createDefaultConfig(overrides);
    server = new AdminServer(config);
    await server.start();
    const addr = server.getAddress();
    port = addr!.port;
  }

  describe('construction and initialization', () => {
    it('should create an instance with valid config', () => {
      const config = createDefaultConfig();
      const adminServer = new AdminServer(config);
      expect(adminServer).toBeInstanceOf(AdminServer);
    });

    it('should return null address before starting', () => {
      const config = createDefaultConfig();
      const adminServer = new AdminServer(config);
      expect(adminServer.getAddress()).toBeNull();
    });

    it('should use default auth config when auth is not provided', () => {
      const config = createDefaultConfig();
      const adminServer = new AdminServer(config);
      // Should not throw - default auth config (method: none) is used
      expect(adminServer).toBeInstanceOf(AdminServer);
    });
  });

  describe('createAdminServer factory', () => {
    it('should create an AdminServer instance', () => {
      const config = createDefaultConfig();
      const adminServer = createAdminServer(config);
      expect(adminServer).toBeInstanceOf(AdminServer);
    });
  });

  describe('start and stop lifecycle', () => {
    it('should start and listen on the configured host/port', async () => {
      await startServer();
      const addr = server.getAddress();
      expect(addr).not.toBeNull();
      expect(addr!.host).toBe('127.0.0.1');
      expect(addr!.port).toBeGreaterThan(0);
    });

    it('should log a message when started', async () => {
      const logger = createMockLogger();
      await startServer({ logger });
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ host: '127.0.0.1' }),
        'Admin server started',
      );
    });

    it('should stop cleanly', async () => {
      const logger = createMockLogger();
      await startServer({ logger });
      await server.stop();
      expect(logger.info).toHaveBeenCalledWith('Admin server stopped');
    });

    it('should resolve immediately when stopping a server that was never started', async () => {
      const config = createDefaultConfig();
      server = new AdminServer(config);
      // Should not throw
      await server.stop();
    });

    it('should return address after starting', async () => {
      await startServer();
      const addr = server.getAddress();
      expect(addr).toEqual({
        host: '127.0.0.1',
        port: expect.any(Number),
      });
    });
  });

  describe('GET /health', () => {
    it('should return 200 with health status', async () => {
      await startServer();
      const res = await request(port, '/health');

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('ok');
      expect(body).toHaveProperty('uptime');
      expect(body).toHaveProperty('timestamp');
      expect(typeof body.uptime).toBe('number');
      expect(body.uptime).toBeGreaterThanOrEqual(0);
    });

    it('should return a valid ISO timestamp', async () => {
      await startServer();
      const res = await request(port, '/health');
      const body = JSON.parse(res.body);
      expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should set Content-Type to application/json', async () => {
      await startServer();
      const res = await request(port, '/health');
      expect(res.headers['content-type']).toBe('application/json');
    });

    it('should set Cache-Control to no-cache', async () => {
      await startServer();
      const res = await request(port, '/health');
      expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    });
  });

  describe('GET /ready', () => {
    it('should return 200 when proxy is ready', async () => {
      await startServer({ isReady: () => true });
      const res = await request(port, '/ready');

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ready).toBe(true);
    });

    it('should return 503 when proxy is not ready', async () => {
      await startServer({ isReady: () => false });
      const res = await request(port, '/ready');

      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.ready).toBe(false);
      expect(body.reason).toBe('Proxy not ready');
    });
  });

  describe('GET /metrics', () => {
    it('should return 200 with JSON metrics', async () => {
      const metrics = createMockMetricsCollector();
      await startServer({ metrics });
      const res = await request(port, '/metrics');

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.requestsTotal).toBe(42);
      expect(body.requestsAllowed).toBe(30);
      expect(body.requestsDenied).toBe(10);
      expect(body.activeConnections).toBe(5);
    });

    it('should pass rules count to metrics collector', async () => {
      const metrics = createMockMetricsCollector();
      const getRulesCount = vi.fn(() => 10);
      await startServer({ metrics, getRulesCount });
      await request(port, '/metrics');

      expect(metrics.getMetrics).toHaveBeenCalledWith(10);
    });

    it('should set Content-Type to application/json', async () => {
      await startServer();
      const res = await request(port, '/metrics');
      expect(res.headers['content-type']).toBe('application/json');
    });
  });

  describe('GET /metrics/prometheus', () => {
    it('should return prometheus-format metrics when configured', async () => {
      const prometheusMetrics = createMockPrometheusMetrics();
      await startServer({ prometheusMetrics });
      const res = await request(port, '/metrics/prometheus');

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('proxy_requests_total');
      expect(res.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    });

    it('should update rules count gauge before exporting', async () => {
      const prometheusMetrics = createMockPrometheusMetrics();
      const getRulesCount = vi.fn(() => 7);
      await startServer({ prometheusMetrics, getRulesCount });
      await request(port, '/metrics/prometheus');

      expect(prometheusMetrics.setRulesCount).toHaveBeenCalledWith(7);
    });

    it('should return 404 when prometheus metrics are not configured', async () => {
      await startServer({ prometheusMetrics: undefined });
      const res = await request(port, '/metrics/prometheus');

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Prometheus metrics not configured');
    });

    it('should return 500 when prometheus metrics generation fails', async () => {
      const prometheusMetrics = createMockPrometheusMetrics();
      (prometheusMetrics.getMetrics as any).mockRejectedValue(new Error('Registry error'));
      await startServer({ prometheusMetrics });
      const res = await request(port, '/metrics/prometheus');

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Failed to generate metrics');
    });
  });

  describe('unknown routes return 404', () => {
    it('should return 404 for unknown paths', async () => {
      await startServer();
      const res = await request(port, '/unknown');

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Not found');
    });

    it('should include available endpoints in 404 response', async () => {
      await startServer();
      const res = await request(port, '/nonexistent');
      const body = JSON.parse(res.body);

      expect(body.endpoints).toEqual(
        expect.arrayContaining(['/health', '/ready', '/metrics', '/metrics/prometheus']),
      );
    });

    it('should return 404 for root path', async () => {
      await startServer();
      const res = await request(port, '/');

      expect(res.statusCode).toBe(404);
    });
  });

  describe('authentication middleware', () => {
    it('should allow unauthenticated access to /health and /ready with bearer auth configured', async () => {
      await startServer({
        auth: {
          method: 'bearer',
          bearerToken: 'my-secret-token-1234',
          protectedEndpoints: ['/metrics', '/config'],
        },
      });

      const healthRes = await request(port, '/health');
      expect(healthRes.statusCode).toBe(200);

      const readyRes = await request(port, '/ready');
      expect(readyRes.statusCode).toBe(200);
    });

    it('should require bearer token for protected endpoints', async () => {
      await startServer({
        auth: {
          method: 'bearer',
          bearerToken: 'my-secret-token-1234',
          protectedEndpoints: ['/metrics'],
        },
      });

      const res = await request(port, '/metrics');
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Unauthorized');
    });

    it('should allow access with valid bearer token', async () => {
      const token = 'my-secret-token-1234';
      await startServer({
        auth: {
          method: 'bearer',
          bearerToken: token,
          protectedEndpoints: ['/metrics'],
        },
      });

      const res = await request(port, '/metrics', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('should reject with invalid bearer token', async () => {
      await startServer({
        auth: {
          method: 'bearer',
          bearerToken: 'my-secret-token-1234',
          protectedEndpoints: ['/metrics'],
        },
      });

      const res = await request(port, '/metrics', {
        headers: { Authorization: 'Bearer wrong-token-value' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('should reject from disallowed IP with ip-allowlist auth', async () => {
      await startServer({
        auth: {
          method: 'ip-allowlist',
          allowedIps: ['203.0.113.0/24'],
          protectedEndpoints: ['/metrics'],
        },
      });

      // Requests from 127.0.0.1 (localhost) should be rejected since
      // it is not in the allowlist
      const res = await request(port, '/metrics');
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Forbidden');
    });

    it('should handle rate limiting', async () => {
      await startServer({
        auth: {
          method: 'none',
          rateLimitPerMinute: 2,
        },
      });

      // First two should succeed
      const res1 = await request(port, '/health');
      expect(res1.statusCode).toBe(200);

      const res2 = await request(port, '/health');
      expect(res2.statusCode).toBe(200);

      // Third should be rate limited
      const res3 = await request(port, '/health');
      expect(res3.statusCode).toBe(429);
      const body = JSON.parse(res3.body);
      expect(body.error).toBe('Too Many Requests');
    });
  });

  describe('error handling', () => {
    it('should log server errors', async () => {
      const logger = createMockLogger();
      const config = createDefaultConfig({ logger });
      server = new AdminServer(config);
      await server.start();
      port = server.getAddress()!.port;

      // Trigger the server error handler by emitting an error event
      // Access the underlying server via reflection
      const internalServer = (server as any).server as http.Server;
      const testError = new Error('test error');
      internalServer.emit('error', testError);

      expect(logger.error).toHaveBeenCalledWith({ error: testError }, 'Admin server error');
    });

    it('should return 500 when request handler throws', async () => {
      const metrics = createMockMetricsCollector();
      // Make getMetrics throw to trigger error handling in handleRequest
      (metrics.getMetrics as any).mockImplementation(() => {
        throw new Error('Metrics collection failed');
      });
      await startServer({ metrics });

      const res = await request(port, '/metrics');
      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Internal server error');
    });

    it('should log the error path for request errors', async () => {
      const logger = createMockLogger();
      const metrics = createMockMetricsCollector();
      (metrics.getMetrics as any).mockImplementation(() => {
        throw new Error('boom');
      });
      await startServer({ logger, metrics });

      await request(port, '/metrics');
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/metrics' }),
        'Admin request error',
      );
    });
  });

  describe('common response headers', () => {
    it('should set Content-Type to application/json on all JSON endpoints', async () => {
      await startServer();

      for (const path of ['/health', '/ready', '/metrics']) {
        const res = await request(port, path);
        expect(res.headers['content-type']).toBe('application/json');
      }
    });

    it('should set Cache-Control on all endpoints', async () => {
      await startServer();

      for (const path of ['/health', '/ready', '/metrics']) {
        const res = await request(port, path);
        expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
      }
    });
  });
});
