/**
 * Connection limiter for DoS protection.
 *
 * Tracks concurrent connections per client IP and globally,
 * enforcing limits to prevent resource exhaustion.
 */

import type { Socket } from 'node:net';
import type { Logger } from '../logging/logger.js';
import type { LimitsConfig } from '../types/config.js';

export interface ConnectionLimiterOptions {
  limits: LimitsConfig;
  logger: Logger;
}

export interface ConnectionInfo {
  ip: string;
  socket: Socket;
  connectedAt: number;
}

export interface ConnectionLimitResult {
  allowed: boolean;
  reason?: string;
  currentIpConnections?: number;
  currentTotalConnections?: number;
}

/**
 * Connection limiter for managing concurrent connections.
 *
 * Tracks connections by client IP and enforces both per-IP
 * and global connection limits.
 */
export class ConnectionLimiter {
  private readonly options: ConnectionLimiterOptions;
  private readonly connectionsByIp: Map<string, Set<Socket>> = new Map();
  private totalConnections = 0;

  constructor(options: ConnectionLimiterOptions) {
    this.options = options;
  }

  /**
   * Check if a new connection from the given IP is allowed.
   */
  canAccept(ip: string): ConnectionLimitResult {
    const { maxConcurrentConnectionsPerIp, maxTotalConnections } = this.options.limits;

    // Check total connections limit
    if (this.totalConnections >= maxTotalConnections) {
      this.options.logger.warn(
        { totalConnections: this.totalConnections, limit: maxTotalConnections },
        'Total connection limit reached'
      );
      return {
        allowed: false,
        reason: 'Server connection limit reached',
        currentTotalConnections: this.totalConnections,
      };
    }

    // Check per-IP connections limit
    const ipConnections = this.connectionsByIp.get(ip);
    const currentIpCount = ipConnections?.size ?? 0;

    if (currentIpCount >= maxConcurrentConnectionsPerIp) {
      this.options.logger.warn(
        { ip, connections: currentIpCount, limit: maxConcurrentConnectionsPerIp },
        'Per-IP connection limit reached'
      );
      return {
        allowed: false,
        reason: 'Too many connections from your IP',
        currentIpConnections: currentIpCount,
        currentTotalConnections: this.totalConnections,
      };
    }

    return {
      allowed: true,
      currentIpConnections: currentIpCount,
      currentTotalConnections: this.totalConnections,
    };
  }

  /**
   * Track a new connection.
   * Returns a cleanup function to call when the connection closes.
   */
  track(ip: string, socket: Socket): () => void {
    // Add to IP-specific set
    let ipConnections = this.connectionsByIp.get(ip);
    if (!ipConnections) {
      ipConnections = new Set();
      this.connectionsByIp.set(ip, ipConnections);
    }
    ipConnections.add(socket);
    this.totalConnections++;

    this.options.logger.debug(
      { ip, ipConnections: ipConnections.size, totalConnections: this.totalConnections },
      'Connection tracked'
    );

    // Return cleanup function
    const cleanup = () => {
      this.untrack(ip, socket);
    };

    // Auto-cleanup on socket close
    socket.once('close', cleanup);
    socket.once('error', cleanup);

    return cleanup;
  }

  /**
   * Remove a tracked connection.
   */
  private untrack(ip: string, socket: Socket): void {
    const ipConnections = this.connectionsByIp.get(ip);
    if (ipConnections) {
      const wasTracked = ipConnections.delete(socket);
      if (wasTracked) {
        this.totalConnections = Math.max(0, this.totalConnections - 1);

        if (ipConnections.size === 0) {
          this.connectionsByIp.delete(ip);
        }

        this.options.logger.debug(
          { ip, ipConnections: ipConnections.size, totalConnections: this.totalConnections },
          'Connection untracked'
        );
      }
    }
  }

  /**
   * Get the current number of connections for an IP.
   */
  getConnectionCount(ip: string): number {
    return this.connectionsByIp.get(ip)?.size ?? 0;
  }

  /**
   * Get the total number of active connections.
   */
  getTotalConnections(): number {
    return this.totalConnections;
  }

  /**
   * Get statistics about current connections.
   */
  getStats(): {
    totalConnections: number;
    uniqueIps: number;
    connectionsByIp: Record<string, number>;
  } {
    const connectionsByIp: Record<string, number> = {};
    for (const [ip, sockets] of this.connectionsByIp) {
      connectionsByIp[ip] = sockets.size;
    }

    return {
      totalConnections: this.totalConnections,
      uniqueIps: this.connectionsByIp.size,
      connectionsByIp,
    };
  }

  /**
   * Reset all connection tracking.
   */
  reset(): void {
    this.connectionsByIp.clear();
    this.totalConnections = 0;
  }
}

/**
 * Create a connection limiter.
 */
export function createConnectionLimiter(options: ConnectionLimiterOptions): ConnectionLimiter {
  return new ConnectionLimiter(options);
}
