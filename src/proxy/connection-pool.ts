/**
 * HTTP connection pooling for upstream servers.
 *
 * Provides persistent HTTP/HTTPS connections with configurable
 * pool sizes and keep-alive settings for improved performance.
 */

import http from 'node:http';
import https from 'node:https';
import type { Logger } from '../logging/logger.js';

/**
 * Connection pool configuration.
 */
export interface ConnectionPoolConfig {
  /** Maximum sockets per host (default: 10) */
  maxSocketsPerHost: number;
  /** Maximum free sockets per host (default: 5) */
  maxFreeSocketsPerHost: number;
  /** Maximum total sockets (default: 256) */
  maxTotalSockets: number;
  /** Keep-alive timeout in ms (default: 60000) */
  keepAliveTimeout: number;
  /** Free socket timeout in ms (default: 30000) */
  freeSocketTimeout: number;
  /** Enable TCP keep-alive (default: true) */
  keepAlive: boolean;
  /** TCP keep-alive initial delay in ms (default: 1000) */
  keepAliveInitialDelay: number;
  /** Scheduling strategy: 'fifo' or 'lifo' (default: 'lifo') */
  scheduling: 'fifo' | 'lifo';
}

/**
 * Default connection pool configuration.
 */
export const DEFAULT_POOL_CONFIG: ConnectionPoolConfig = {
  maxSocketsPerHost: 10,
  maxFreeSocketsPerHost: 5,
  maxTotalSockets: 256,
  keepAliveTimeout: 60000,
  freeSocketTimeout: 30000,
  keepAlive: true,
  keepAliveInitialDelay: 1000,
  scheduling: 'lifo',
};

/**
 * Per-protocol statistics.
 */
export interface ProtocolStats {
  /** Active sockets in use */
  activeSockets: number;
  /** Free (idle) sockets in pool */
  freeSockets: number;
  /** Pending requests waiting for sockets */
  pendingRequests: number;
  /** Total sockets created for this protocol */
  socketsCreated: number;
  /** Total sockets reused for this protocol */
  socketsReused: number;
  /** Socket reuse rate (0-1) */
  reuseRate: number;
}

/**
 * Connection pool statistics.
 */
export interface PoolStats {
  /** Total number of active sockets */
  totalSockets: number;
  /** Total number of free (idle) sockets */
  totalFreeSockets: number;
  /** Number of pending requests waiting for sockets */
  pendingRequests: number;
  /** Sockets per host */
  socketsPerHost: Record<string, number>;
  /** Free sockets per host */
  freeSocketsPerHost: Record<string, number>;
  /** Total requests made through the pool */
  totalRequests: number;
  /** Total connections created */
  totalConnectionsCreated: number;
  /** Total connections reused */
  totalConnectionsReused: number;
  /** HTTP-specific stats */
  http: ProtocolStats;
  /** HTTPS-specific stats */
  https: ProtocolStats;
}

/**
 * Connection pool manager for HTTP/HTTPS upstream connections.
 *
 * Provides pooled HTTP Agents with keep-alive support for
 * efficient connection reuse to upstream servers.
 */
export class ConnectionPool {
  private readonly config: ConnectionPoolConfig;
  private readonly httpAgent: http.Agent;
  private readonly httpsAgent: https.Agent;
  private readonly logger?: Logger;

  // Statistics
  private totalRequests = 0;
  private totalConnectionsCreated = 0;
  private totalConnectionsReused = 0;
  private httpConnectionsCreated = 0;
  private httpConnectionsReused = 0;
  private httpsConnectionsCreated = 0;
  private httpsConnectionsReused = 0;

  constructor(config: Partial<ConnectionPoolConfig> = {}, logger?: Logger) {
    this.config = { ...DEFAULT_POOL_CONFIG, ...config };
    this.logger = logger;

    // Create HTTP agent with connection pooling
    this.httpAgent = new http.Agent({
      keepAlive: this.config.keepAlive,
      keepAliveMsecs: this.config.keepAliveInitialDelay,
      maxSockets: this.config.maxSocketsPerHost,
      maxFreeSockets: this.config.maxFreeSocketsPerHost,
      maxTotalSockets: this.config.maxTotalSockets,
      timeout: this.config.keepAliveTimeout,
      scheduling: this.config.scheduling,
    });

    // Create HTTPS agent with connection pooling
    this.httpsAgent = new https.Agent({
      keepAlive: this.config.keepAlive,
      keepAliveMsecs: this.config.keepAliveInitialDelay,
      maxSockets: this.config.maxSocketsPerHost,
      maxFreeSockets: this.config.maxFreeSocketsPerHost,
      maxTotalSockets: this.config.maxTotalSockets,
      timeout: this.config.keepAliveTimeout,
      scheduling: this.config.scheduling,
    });

    // Track connection events
    this.setupEventListeners();
  }

  /**
   * Set up event listeners for connection tracking.
   */
  private setupEventListeners(): void {
    const trackAgent = (agent: http.Agent | https.Agent, protocol: string) => {
      agent.on('free', (socket, options) => {
        this.logger?.debug(
          { host: options.host, port: options.port, protocol },
          'Socket returned to pool'
        );
      });

      // Note: 'connect' events fire on the socket, not the agent
      // We track via request counting instead
    };

    trackAgent(this.httpAgent, 'http');
    trackAgent(this.httpsAgent, 'https');
  }

  /**
   * Get the HTTP agent for making requests.
   */
  getHttpAgent(): http.Agent {
    return this.httpAgent;
  }

  /**
   * Get the HTTPS agent for making requests.
   */
  getHttpsAgent(): https.Agent {
    return this.httpsAgent;
  }

  /**
   * Get the appropriate agent for a URL protocol.
   */
  getAgentForProtocol(protocol: string): http.Agent | https.Agent {
    return protocol === 'https:' ? this.httpsAgent : this.httpAgent;
  }

  /**
   * Record a request being made through the pool.
   *
   * @param reused - Whether an existing connection was reused
   * @param protocol - The protocol used ('http' or 'https')
   */
  recordRequest(reused: boolean, protocol: 'http' | 'https' = 'http'): void {
    this.totalRequests++;
    if (reused) {
      this.totalConnectionsReused++;
      if (protocol === 'https') {
        this.httpsConnectionsReused++;
      } else {
        this.httpConnectionsReused++;
      }
    } else {
      this.totalConnectionsCreated++;
      if (protocol === 'https') {
        this.httpsConnectionsCreated++;
      } else {
        this.httpConnectionsCreated++;
      }
    }
  }

  /**
   * Get current pool statistics.
   */
  getStats(): PoolStats {
    const httpSockets = this.getAgentSockets(this.httpAgent);
    const httpFreeSockets = this.getAgentFreeSockets(this.httpAgent);
    const httpsPockets = this.getAgentSockets(this.httpsAgent);
    const httpsFreeSockets = this.getAgentFreeSockets(this.httpsAgent);

    // Merge HTTP and HTTPS stats
    const socketsPerHost: Record<string, number> = {};
    const freeSocketsPerHost: Record<string, number> = {};

    for (const [host, count] of Object.entries(httpSockets)) {
      socketsPerHost[`http://${host}`] = count;
    }
    for (const [host, count] of Object.entries(httpsPockets)) {
      socketsPerHost[`https://${host}`] = count;
    }
    for (const [host, count] of Object.entries(httpFreeSockets)) {
      freeSocketsPerHost[`http://${host}`] = count;
    }
    for (const [host, count] of Object.entries(httpsFreeSockets)) {
      freeSocketsPerHost[`https://${host}`] = count;
    }

    const totalSockets = Object.values(socketsPerHost).reduce((a, b) => a + b, 0);
    const totalFreeSockets = Object.values(freeSocketsPerHost).reduce((a, b) => a + b, 0);

    // Calculate per-protocol stats
    const httpActiveSockets = Object.values(httpSockets).reduce((a, b) => a + b, 0);
    const httpFreeSocketCount = Object.values(httpFreeSockets).reduce((a, b) => a + b, 0);
    const httpsActiveSockets = Object.values(httpsPockets).reduce((a, b) => a + b, 0);
    const httpsFreeSocketCount = Object.values(httpsFreeSockets).reduce((a, b) => a + b, 0);

    const httpTotalRequests = this.httpConnectionsCreated + this.httpConnectionsReused;
    const httpsTotalRequests = this.httpsConnectionsCreated + this.httpsConnectionsReused;

    return {
      totalSockets,
      totalFreeSockets,
      pendingRequests: this.getPendingRequests(),
      socketsPerHost,
      freeSocketsPerHost,
      totalRequests: this.totalRequests,
      totalConnectionsCreated: this.totalConnectionsCreated,
      totalConnectionsReused: this.totalConnectionsReused,
      http: {
        activeSockets: httpActiveSockets,
        freeSockets: httpFreeSocketCount,
        pendingRequests: this.getAgentPendingRequests(this.httpAgent),
        socketsCreated: this.httpConnectionsCreated,
        socketsReused: this.httpConnectionsReused,
        reuseRate: httpTotalRequests > 0 ? this.httpConnectionsReused / httpTotalRequests : 0,
      },
      https: {
        activeSockets: httpsActiveSockets,
        freeSockets: httpsFreeSocketCount,
        pendingRequests: this.getAgentPendingRequests(this.httpsAgent),
        socketsCreated: this.httpsConnectionsCreated,
        socketsReused: this.httpsConnectionsReused,
        reuseRate: httpsTotalRequests > 0 ? this.httpsConnectionsReused / httpsTotalRequests : 0,
      },
    };
  }

  /**
   * Get the number of active sockets per host for an agent.
   */
  private getAgentSockets(agent: http.Agent): Record<string, number> {
    const sockets: Record<string, number> = {};
    const agentSockets = (agent as any).sockets as Record<string, any[]> | undefined;

    if (agentSockets) {
      for (const [key, socketArray] of Object.entries(agentSockets)) {
        sockets[key] = socketArray.length;
      }
    }

    return sockets;
  }

  /**
   * Get the number of free sockets per host for an agent.
   */
  private getAgentFreeSockets(agent: http.Agent): Record<string, number> {
    const freeSockets: Record<string, number> = {};
    const agentFreeSockets = (agent as any).freeSockets as Record<string, any[]> | undefined;

    if (agentFreeSockets) {
      for (const [key, socketArray] of Object.entries(agentFreeSockets)) {
        freeSockets[key] = socketArray.length;
      }
    }

    return freeSockets;
  }

  /**
   * Get the number of pending requests for a specific agent.
   */
  private getAgentPendingRequests(agent: http.Agent): number {
    const requests = (agent as any).requests as Record<string, any[]> | undefined;
    let count = 0;
    if (requests) {
      for (const reqs of Object.values(requests)) {
        count += reqs.length;
      }
    }
    return count;
  }

  /**
   * Get the number of pending requests across all agents.
   */
  private getPendingRequests(): number {
    return this.getAgentPendingRequests(this.httpAgent) + this.getAgentPendingRequests(this.httpsAgent);
  }

  /**
   * Destroy all connections and close the pool.
   */
  destroy(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
    this.logger?.info('Connection pool destroyed');
  }

  /**
   * Get connection reuse ratio.
   */
  getReuseRatio(): number {
    if (this.totalRequests === 0) return 0;
    return this.totalConnectionsReused / this.totalRequests;
  }

  /**
   * Get the pool configuration.
   */
  getConfig(): ConnectionPoolConfig {
    return { ...this.config };
  }
}

/**
 * Create a connection pool.
 */
export function createConnectionPool(
  config?: Partial<ConnectionPoolConfig>,
  logger?: Logger
): ConnectionPool {
  return new ConnectionPool(config, logger);
}
