import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  PrometheusMetrics,
  createPrometheusMetrics,
  DEFAULT_PROMETHEUS_CONFIG,
} from '../src/admin/prometheus-metrics.js';

describe('PrometheusMetrics', () => {
  let metrics: PrometheusMetrics;

  beforeEach(() => {
    metrics = new PrometheusMetrics({
      prefix: 'test_proxy',
      enableDefaultMetrics: false, // Disable for faster tests
    });
  });

  afterEach(() => {
    metrics.clear();
  });

  describe('configuration', () => {
    it('should use default config', () => {
      const defaultMetrics = new PrometheusMetrics();
      expect(defaultMetrics.getContentType()).toContain('text/plain');
      defaultMetrics.clear();
    });

    it('should accept custom prefix', async () => {
      metrics.recordRequest('GET', '200', 'test-rule');
      const output = await metrics.getMetrics();
      expect(output).toContain('test_proxy_requests_total');
    });

    it('should support default labels', async () => {
      const labeledMetrics = new PrometheusMetrics({
        prefix: 'test',
        enableDefaultMetrics: false,
        defaultLabels: { env: 'test' },
      });
      labeledMetrics.recordRequest('GET', '200');
      const output = await labeledMetrics.getMetrics();
      expect(output).toContain('env="test"');
      labeledMetrics.clear();
    });
  });

  describe('request metrics', () => {
    it('should record requests', async () => {
      metrics.recordRequest('GET', '200', 'api-rule');
      metrics.recordRequest('POST', '201', 'api-rule');
      metrics.recordRequest('GET', '404', 'unknown');

      const output = await metrics.getMetrics();
      expect(output).toContain('test_proxy_requests_total');
      expect(output).toContain('method="GET"');
      expect(output).toContain('status="200"');
      expect(output).toContain('rule="api-rule"');
    });

    it('should time requests', async () => {
      const stopTimer = metrics.startRequestTimer('GET', 'api.example.com');
      // Simulate some work
      await new Promise((resolve) => setTimeout(resolve, 10));
      const duration = stopTimer({ status: '200', rule: 'test' });

      expect(duration).toBeGreaterThan(0);

      const output = await metrics.getMetrics();
      expect(output).toContain('test_proxy_request_duration_seconds');
      expect(output).toContain('target_domain="api.example.com"');
    });
  });

  describe('bytes metrics', () => {
    it('should record bytes transferred', async () => {
      metrics.recordBytes('inbound', 1024);
      metrics.recordBytes('outbound', 2048);

      const output = await metrics.getMetrics();
      expect(output).toContain('test_proxy_bytes_transferred_total');
      expect(output).toContain('direction="inbound"');
      expect(output).toContain('direction="outbound"');
    });
  });

  describe('rate limit metrics', () => {
    it('should record rate limit hits', async () => {
      metrics.recordRateLimitHit('api-rule');
      metrics.recordRateLimitHit('api-rule');
      metrics.recordRateLimitHit('default');

      const output = await metrics.getMetrics();
      expect(output).toContain('test_proxy_rate_limit_hits_total');
      expect(output).toContain('rule="api-rule"');
    });
  });

  describe('allowlist metrics', () => {
    it('should record allowlist matches', async () => {
      metrics.recordAllowlistMatch('openai-rule', 'allow');
      metrics.recordAllowlistMatch('blocked-rule', 'deny');

      const output = await metrics.getMetrics();
      expect(output).toContain('test_proxy_allowlist_matches_total');
      expect(output).toContain('action="allow"');
      expect(output).toContain('action="deny"');
    });
  });

  describe('error metrics', () => {
    it('should record errors', async () => {
      metrics.recordError('timeout');
      metrics.recordError('connection');

      const output = await metrics.getMetrics();
      expect(output).toContain('test_proxy_errors_total');
      expect(output).toContain('type="timeout"');
    });
  });

  describe('connection metrics', () => {
    it('should track active connections', async () => {
      metrics.incActiveConnections('http');
      metrics.incActiveConnections('http');
      metrics.incActiveConnections('https');
      metrics.decActiveConnections('http');

      const output = await metrics.getMetrics();
      expect(output).toContain('test_proxy_active_connections');
      expect(output).toContain('type="http"');
      expect(output).toContain('type="https"');
    });

    it('should set connection counts directly', async () => {
      metrics.setActiveConnections('tunnel', 5);

      const output = await metrics.getMetrics();
      expect(output).toContain('test_proxy_active_connections');
      expect(output).toContain('type="tunnel"');
    });
  });

  describe('rules count', () => {
    it('should set rules count', async () => {
      metrics.setRulesCount(10);

      const output = await metrics.getMetrics();
      expect(output).toContain('test_proxy_rules_count');
      expect(output).toContain('10');
    });
  });

  describe('connection pool metrics', () => {
    it('should set connection pool metrics', async () => {
      metrics.setConnectionPoolMetrics('http', 5, 3, 2);
      metrics.setConnectionPoolMetrics('https', 10, 5, 0);

      const output = await metrics.getMetrics();
      expect(output).toContain('test_proxy_connection_pool_sockets');
      expect(output).toContain('protocol="http"');
      expect(output).toContain('state="active"');
      expect(output).toContain('state="free"');
    });
  });

  describe('certificate cache metrics', () => {
    it('should set cert cache size', async () => {
      metrics.setCertCacheSize(100);

      const output = await metrics.getMetrics();
      expect(output).toContain('test_proxy_cert_cache_size');
    });
  });

  describe('output format', () => {
    it('should return Prometheus text format', async () => {
      metrics.recordRequest('GET', '200', 'test');
      const output = await metrics.getMetrics();

      // Prometheus format should have HELP and TYPE comments
      expect(output).toContain('# HELP');
      expect(output).toContain('# TYPE');
    });

    it('should return correct content type', () => {
      expect(metrics.getContentType()).toMatch(/^text\/plain/);
    });
  });

  describe('reset', () => {
    it('should reset all metrics', async () => {
      metrics.recordRequest('GET', '200', 'test');

      const beforeReset = await metrics.getMetrics();
      expect(beforeReset).toContain('test_proxy_requests_total');

      metrics.resetMetrics();

      // After reset, record again to see the counter start fresh
      metrics.recordRequest('GET', '200', 'test');
      const afterReset = await metrics.getMetrics();
      // Should only have 1 request now
      expect(afterReset).toContain('test_proxy_requests_total{method="GET",status="200",rule="test"} 1');
    });
  });
});

describe('createPrometheusMetrics', () => {
  it('should create a metrics instance', () => {
    const metrics = createPrometheusMetrics({ prefix: 'test', enableDefaultMetrics: false });
    expect(metrics).toBeInstanceOf(PrometheusMetrics);
    metrics.clear();
  });
});
