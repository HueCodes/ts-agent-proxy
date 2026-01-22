import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsCollector, createMetricsCollector } from '../src/admin/metrics.js';
import type { PoolStats } from '../src/proxy/connection-pool.js';
import type { LruCacheStats } from '../src/utils/lru-cache.js';

describe('MetricsCollector', () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    metrics = new MetricsCollector();
  });

  describe('request tracking', () => {
    it('should track allowed requests', () => {
      metrics.recordRequest('allowed');
      metrics.recordRequest('allowed');

      const snapshot = metrics.getMetrics(0);
      expect(snapshot.requestsTotal).toBe(2);
      expect(snapshot.requestsAllowed).toBe(2);
    });

    it('should track denied requests', () => {
      metrics.recordRequest('denied');
      metrics.recordRequest('denied');
      metrics.recordRequest('denied');

      const snapshot = metrics.getMetrics(0);
      expect(snapshot.requestsDenied).toBe(3);
    });

    it('should track rate limited requests', () => {
      metrics.recordRequest('rate_limited');

      const snapshot = metrics.getMetrics(0);
      expect(snapshot.requestsRateLimited).toBe(1);
    });

    it('should track per-rule metrics', () => {
      metrics.recordRequest('allowed', 'rule1');
      metrics.recordRequest('allowed', 'rule1');
      metrics.recordRequest('denied', 'rule1');
      metrics.recordRequest('allowed', 'rule2');

      const snapshot = metrics.getMetrics(0);
      expect(snapshot.byRule.rule1.allowed).toBe(2);
      expect(snapshot.byRule.rule1.denied).toBe(1);
      expect(snapshot.byRule.rule2.allowed).toBe(1);
    });
  });

  describe('connection tracking', () => {
    it('should track active connections', () => {
      metrics.connectionOpened();
      metrics.connectionOpened();
      metrics.connectionOpened();

      const snapshot = metrics.getMetrics(0);
      expect(snapshot.activeConnections).toBe(3);
    });

    it('should decrement on connection close', () => {
      metrics.connectionOpened();
      metrics.connectionOpened();
      metrics.connectionClosed();

      const snapshot = metrics.getMetrics(0);
      expect(snapshot.activeConnections).toBe(1);
    });

    it('should not go below zero', () => {
      metrics.connectionClosed();
      metrics.connectionClosed();

      const snapshot = metrics.getMetrics(0);
      expect(snapshot.activeConnections).toBe(0);
    });
  });

  describe('uptime tracking', () => {
    it('should include uptime in seconds', () => {
      const snapshot = metrics.getMetrics(0);
      expect(snapshot.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });
  });

  describe('reset', () => {
    it('should reset all metrics', () => {
      metrics.recordRequest('allowed', 'rule1');
      metrics.recordRequest('denied');
      metrics.connectionOpened();

      metrics.reset();

      const snapshot = metrics.getMetrics(0);
      expect(snapshot.requestsTotal).toBe(0);
      expect(snapshot.requestsAllowed).toBe(0);
      expect(snapshot.requestsDenied).toBe(0);
      expect(snapshot.activeConnections).toBe(0);
      expect(Object.keys(snapshot.byRule)).toHaveLength(0);
    });
  });

  describe('timestamp', () => {
    it('should include ISO timestamp', () => {
      const snapshot = metrics.getMetrics(0);
      expect(snapshot.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('external metrics sources', () => {
    it('should include connection pool metrics when registered', () => {
      const mockPoolStats: PoolStats = {
        totalSockets: 5,
        totalFreeSockets: 2,
        pendingRequests: 1,
        socketsPerHost: {},
        freeSocketsPerHost: {},
        totalRequests: 100,
        totalConnectionsCreated: 60,
        totalConnectionsReused: 40,
        http: {
          activeSockets: 3,
          freeSockets: 1,
          pendingRequests: 0,
          socketsCreated: 30,
          socketsReused: 20,
          reuseRate: 0.4,
        },
        https: {
          activeSockets: 2,
          freeSockets: 1,
          pendingRequests: 1,
          socketsCreated: 30,
          socketsReused: 20,
          reuseRate: 0.4,
        },
      };

      metrics.registerSources({
        connectionPool: () => mockPoolStats,
      });

      const snapshot = metrics.getMetrics(0);
      expect(snapshot.connectionPool).toBeDefined();
      expect(snapshot.connectionPool!.http.active).toBe(3);
      expect(snapshot.connectionPool!.http.reuseRate).toBe(0.4);
      expect(snapshot.connectionPool!.https.active).toBe(2);
    });

    it('should include certificate cache metrics when registered', () => {
      const mockCacheStats: LruCacheStats = {
        size: 50,
        maxSize: 1000,
        hits: 450,
        misses: 50,
        hitRate: 0.9,
        evictions: 10,
        expirations: 5,
      };

      metrics.registerSources({
        certificateCache: () => mockCacheStats,
      });

      const snapshot = metrics.getMetrics(0);
      expect(snapshot.cache).toBeDefined();
      expect(snapshot.cache!.certificates.size).toBe(50);
      expect(snapshot.cache!.certificates.hitRate).toBe(0.9);
    });

    it('should include domain trie metrics when registered', () => {
      const mockTrieStats = {
        ruleCount: 25,
        exactDomains: 20,
        nodeCount: 100,
        maxDepth: 5,
      };

      metrics.registerSources({
        domainTrie: () => mockTrieStats,
      });

      const snapshot = metrics.getMetrics(0);
      expect(snapshot.cache).toBeDefined();
      expect(snapshot.cache!.domainTrie.ruleCount).toBe(25);
      expect(snapshot.cache!.domainTrie.maxDepth).toBe(5);
    });

    it('should include rate limiter metrics when registered', () => {
      const mockRateLimiterStats = {
        totalRequests: 1000,
        totalAllowed: 950,
        totalRejected: 50,
        rejectionRate: 0.05,
        registeredRules: 5,
      };

      metrics.registerSources({
        rateLimiter: () => mockRateLimiterStats,
      });

      const snapshot = metrics.getMetrics(0);
      expect(snapshot.rateLimiter).toBeDefined();
      expect(snapshot.rateLimiter!.totalRequests).toBe(1000);
      expect(snapshot.rateLimiter!.rejectionRate).toBe(0.05);
    });

    it('should merge multiple source registrations', () => {
      metrics.registerSources({
        certificateCache: () => ({
          size: 10,
          maxSize: 100,
          hits: 5,
          misses: 5,
          hitRate: 0.5,
          evictions: 0,
          expirations: 0,
        }),
      });

      metrics.registerSources({
        domainTrie: () => ({
          ruleCount: 10,
          exactDomains: 8,
          nodeCount: 50,
          maxDepth: 3,
        }),
      });

      const snapshot = metrics.getMetrics(0);
      expect(snapshot.cache!.certificates.size).toBe(10);
      expect(snapshot.cache!.domainTrie.ruleCount).toBe(10);
    });

    it('should not include optional metrics when not registered', () => {
      const snapshot = metrics.getMetrics(0);
      expect(snapshot.connectionPool).toBeUndefined();
      expect(snapshot.cache).toBeUndefined();
      expect(snapshot.rateLimiter).toBeUndefined();
    });
  });
});

describe('createMetricsCollector', () => {
  it('should create a new metrics collector', () => {
    const metrics = createMetricsCollector();
    expect(metrics).toBeInstanceOf(MetricsCollector);
  });
});
