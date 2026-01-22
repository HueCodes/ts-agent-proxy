/**
 * Tests for the connection limiter module.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { ConnectionLimiter, createConnectionLimiter } from '../src/filter/connection-limiter.js';
import type { LimitsConfig } from '../src/types/config.js';
import { DEFAULT_LIMITS } from '../src/types/config.js';

// Mock socket
function createMockSocket(): Socket {
  const socket = new EventEmitter() as Socket;
  (socket as any).destroy = vi.fn();
  return socket;
}

// Mock logger
const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
  level: 'info',
} as any;

describe('ConnectionLimiter', () => {
  let limiter: ConnectionLimiter;
  const testLimits: LimitsConfig = {
    ...DEFAULT_LIMITS,
    maxConcurrentConnectionsPerIp: 3,
    maxTotalConnections: 10,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    limiter = createConnectionLimiter({
      limits: testLimits,
      logger: mockLogger,
    });
  });

  describe('canAccept', () => {
    it('should allow connections when under limits', () => {
      const result = limiter.canAccept('192.168.1.1');

      expect(result.allowed).toBe(true);
      expect(result.currentIpConnections).toBe(0);
      expect(result.currentTotalConnections).toBe(0);
    });

    it('should deny when per-IP limit is reached', () => {
      // Track 3 connections from same IP
      for (let i = 0; i < 3; i++) {
        limiter.track('192.168.1.1', createMockSocket());
      }

      const result = limiter.canAccept('192.168.1.1');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Too many connections');
      expect(result.currentIpConnections).toBe(3);
    });

    it('should allow connections from different IPs', () => {
      // Track 3 connections from one IP
      for (let i = 0; i < 3; i++) {
        limiter.track('192.168.1.1', createMockSocket());
      }

      // Should still allow from different IP
      const result = limiter.canAccept('192.168.1.2');
      expect(result.allowed).toBe(true);
    });

    it('should deny when total limit is reached', () => {
      // Track 10 connections from different IPs
      for (let i = 0; i < 10; i++) {
        limiter.track(`192.168.1.${i}`, createMockSocket());
      }

      const result = limiter.canAccept('192.168.2.1');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Server connection limit');
      expect(result.currentTotalConnections).toBe(10);
    });
  });

  describe('track', () => {
    it('should track connections correctly', () => {
      const socket = createMockSocket();
      limiter.track('192.168.1.1', socket);

      expect(limiter.getConnectionCount('192.168.1.1')).toBe(1);
      expect(limiter.getTotalConnections()).toBe(1);
    });

    it('should track multiple connections per IP', () => {
      for (let i = 0; i < 3; i++) {
        limiter.track('192.168.1.1', createMockSocket());
      }

      expect(limiter.getConnectionCount('192.168.1.1')).toBe(3);
      expect(limiter.getTotalConnections()).toBe(3);
    });

    it('should cleanup on socket close', () => {
      const socket = createMockSocket();
      limiter.track('192.168.1.1', socket);

      expect(limiter.getConnectionCount('192.168.1.1')).toBe(1);

      socket.emit('close');

      expect(limiter.getConnectionCount('192.168.1.1')).toBe(0);
      expect(limiter.getTotalConnections()).toBe(0);
    });

    it('should cleanup on socket error', () => {
      const socket = createMockSocket();
      limiter.track('192.168.1.1', socket);

      expect(limiter.getConnectionCount('192.168.1.1')).toBe(1);

      socket.emit('error', new Error('Connection reset'));

      expect(limiter.getConnectionCount('192.168.1.1')).toBe(0);
    });

    it('should return cleanup function', () => {
      const socket = createMockSocket();
      const cleanup = limiter.track('192.168.1.1', socket);

      expect(limiter.getConnectionCount('192.168.1.1')).toBe(1);

      cleanup();

      expect(limiter.getConnectionCount('192.168.1.1')).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', () => {
      limiter.track('192.168.1.1', createMockSocket());
      limiter.track('192.168.1.1', createMockSocket());
      limiter.track('192.168.1.2', createMockSocket());

      const stats = limiter.getStats();

      expect(stats.totalConnections).toBe(3);
      expect(stats.uniqueIps).toBe(2);
      expect(stats.connectionsByIp['192.168.1.1']).toBe(2);
      expect(stats.connectionsByIp['192.168.1.2']).toBe(1);
    });
  });

  describe('reset', () => {
    it('should reset all tracking', () => {
      limiter.track('192.168.1.1', createMockSocket());
      limiter.track('192.168.1.2', createMockSocket());

      limiter.reset();

      expect(limiter.getTotalConnections()).toBe(0);
      expect(limiter.getConnectionCount('192.168.1.1')).toBe(0);
    });
  });
});
