import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ConnectionPool,
  createConnectionPool,
  DEFAULT_POOL_CONFIG,
} from '../src/proxy/connection-pool.js';

describe('ConnectionPool', () => {
  let pool: ConnectionPool;

  beforeEach(() => {
    pool = new ConnectionPool();
  });

  afterEach(() => {
    pool.destroy();
  });

  describe('configuration', () => {
    it('should use default config', () => {
      const config = pool.getConfig();
      expect(config.maxSocketsPerHost).toBe(DEFAULT_POOL_CONFIG.maxSocketsPerHost);
      expect(config.maxFreeSocketsPerHost).toBe(DEFAULT_POOL_CONFIG.maxFreeSocketsPerHost);
      expect(config.keepAlive).toBe(DEFAULT_POOL_CONFIG.keepAlive);
    });

    it('should accept custom config', () => {
      const customPool = new ConnectionPool({
        maxSocketsPerHost: 20,
        maxFreeSocketsPerHost: 10,
        keepAliveTimeout: 30000,
      });

      const config = customPool.getConfig();
      expect(config.maxSocketsPerHost).toBe(20);
      expect(config.maxFreeSocketsPerHost).toBe(10);
      expect(config.keepAliveTimeout).toBe(30000);

      customPool.destroy();
    });
  });

  describe('agents', () => {
    it('should provide HTTP agent', () => {
      const agent = pool.getHttpAgent();
      expect(agent).toBeDefined();
      expect(agent.keepAlive).toBe(true);
    });

    it('should provide HTTPS agent', () => {
      const agent = pool.getHttpsAgent();
      expect(agent).toBeDefined();
      expect(agent.keepAlive).toBe(true);
    });

    it('should return correct agent for protocol', () => {
      const httpAgent = pool.getAgentForProtocol('http:');
      const httpsAgent = pool.getAgentForProtocol('https:');

      expect(httpAgent).toBe(pool.getHttpAgent());
      expect(httpsAgent).toBe(pool.getHttpsAgent());
    });

    it('should default to HTTP agent for unknown protocol', () => {
      const agent = pool.getAgentForProtocol('ftp:');
      expect(agent).toBe(pool.getHttpAgent());
    });
  });

  describe('statistics', () => {
    it('should track total requests', () => {
      pool.recordRequest(false, 'http');
      pool.recordRequest(true, 'http');
      pool.recordRequest(false, 'https');

      const stats = pool.getStats();
      expect(stats.totalRequests).toBe(3);
    });

    it('should track connections created and reused', () => {
      pool.recordRequest(false, 'http');
      pool.recordRequest(false, 'http');
      pool.recordRequest(true, 'http');

      const stats = pool.getStats();
      expect(stats.totalConnectionsCreated).toBe(2);
      expect(stats.totalConnectionsReused).toBe(1);
    });

    it('should track per-protocol stats', () => {
      pool.recordRequest(false, 'http');
      pool.recordRequest(true, 'http');
      pool.recordRequest(false, 'https');
      pool.recordRequest(false, 'https');
      pool.recordRequest(true, 'https');
      pool.recordRequest(true, 'https');

      const stats = pool.getStats();

      expect(stats.http.socketsCreated).toBe(1);
      expect(stats.http.socketsReused).toBe(1);
      expect(stats.http.reuseRate).toBe(0.5);

      expect(stats.https.socketsCreated).toBe(2);
      expect(stats.https.socketsReused).toBe(2);
      expect(stats.https.reuseRate).toBe(0.5);
    });

    it('should calculate reuse ratio', () => {
      expect(pool.getReuseRatio()).toBe(0);

      pool.recordRequest(false, 'http');
      pool.recordRequest(true, 'http');
      pool.recordRequest(true, 'http');
      pool.recordRequest(true, 'http');

      expect(pool.getReuseRatio()).toBe(0.75);
    });

    it('should report zero stats initially', () => {
      const stats = pool.getStats();
      expect(stats.totalRequests).toBe(0);
      expect(stats.totalConnectionsCreated).toBe(0);
      expect(stats.totalConnectionsReused).toBe(0);
      expect(stats.totalSockets).toBe(0);
      expect(stats.totalFreeSockets).toBe(0);
      expect(stats.pendingRequests).toBe(0);
    });

    it('should include socket counts in stats', () => {
      const stats = pool.getStats();
      expect(stats.socketsPerHost).toEqual({});
      expect(stats.freeSocketsPerHost).toEqual({});
    });
  });

  describe('destroy', () => {
    it('should clean up agents on destroy', () => {
      const httpAgent = pool.getHttpAgent();
      const httpsAgent = pool.getHttpsAgent();

      pool.destroy();

      // Agents should be destroyed (no sockets left)
      expect(Object.keys((httpAgent as any).sockets || {})).toHaveLength(0);
      expect(Object.keys((httpsAgent as any).sockets || {})).toHaveLength(0);
    });
  });
});

describe('createConnectionPool', () => {
  it('should create pool with default config', () => {
    const pool = createConnectionPool();
    expect(pool.getConfig().maxSocketsPerHost).toBe(DEFAULT_POOL_CONFIG.maxSocketsPerHost);
    pool.destroy();
  });

  it('should create pool with custom config', () => {
    const pool = createConnectionPool({ maxSocketsPerHost: 50 });
    expect(pool.getConfig().maxSocketsPerHost).toBe(50);
    pool.destroy();
  });

  it('should accept logger', () => {
    const mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => mockLogger,
    };

    const pool = createConnectionPool({}, mockLogger as any);
    expect(pool).toBeDefined();
    pool.destroy();
  });
});
