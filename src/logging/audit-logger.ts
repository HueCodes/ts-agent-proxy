/**
 * Security audit logging for proxy decisions.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from './logger.js';
import type { MatchResult, RequestInfo, AllowlistRule } from '../types/allowlist.js';
import type { RateLimitResult } from '../filter/rate-limiter.js';

export interface AuditLogEntry {
  timestamp: string;
  eventType: 'request' | 'rate_limit' | 'error';
  decision: 'allowed' | 'denied' | 'rate_limited';
  request: RequestInfo;
  matchResult?: MatchResult;
  rateLimitResult?: RateLimitResult;
  errorMessage?: string;
  durationMs?: number;
}

export interface AuditLoggerOptions {
  /** Path to the audit log file */
  filePath?: string;
  /** Whether to also log to the main logger */
  logToMain?: boolean;
  /** Main logger instance */
  logger?: Logger;
}

export class AuditLogger {
  private readonly options: Required<Omit<AuditLoggerOptions, 'filePath'>> & { filePath?: string };
  private writeStream?: fs.WriteStream;

  constructor(options: AuditLoggerOptions = {}) {
    this.options = {
      filePath: options.filePath,
      logToMain: options.logToMain ?? true,
      logger: options.logger as Logger,
    };

    if (this.options.filePath) {
      this.initFileStream();
    }
  }

  /**
   * Initialize the file write stream.
   */
  private initFileStream(): void {
    if (!this.options.filePath) return;

    const dir = path.dirname(this.options.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.writeStream = fs.createWriteStream(this.options.filePath, {
      flags: 'a',
      encoding: 'utf-8',
    });
  }

  /**
   * Log a request decision.
   */
  logRequest(
    request: RequestInfo,
    matchResult: MatchResult,
    durationMs?: number
  ): void {
    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      eventType: 'request',
      decision: matchResult.allowed ? 'allowed' : 'denied',
      request,
      matchResult,
      durationMs,
    };

    this.writeEntry(entry);
  }

  /**
   * Log a rate limit event.
   */
  logRateLimit(
    request: RequestInfo,
    rateLimitResult: RateLimitResult,
    rule?: AllowlistRule
  ): void {
    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      eventType: 'rate_limit',
      decision: rateLimitResult.allowed ? 'allowed' : 'rate_limited',
      request,
      rateLimitResult,
      matchResult: rule
        ? { allowed: true, matchedRule: rule, reason: `Rate limited by rule: ${rule.id}` }
        : undefined,
    };

    this.writeEntry(entry);
  }

  /**
   * Log an error event.
   */
  logError(request: RequestInfo, error: Error | string): void {
    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      eventType: 'error',
      decision: 'denied',
      request,
      errorMessage: typeof error === 'string' ? error : error.message,
    };

    this.writeEntry(entry);
  }

  /**
   * Write an entry to the audit log.
   */
  private writeEntry(entry: AuditLogEntry): void {
    const line = JSON.stringify(entry);

    // Write to file if configured
    if (this.writeStream) {
      this.writeStream.write(line + '\n');
    }

    // Log to main logger if configured
    if (this.options.logToMain && this.options.logger) {
      const logMethod = entry.decision === 'denied' || entry.decision === 'rate_limited'
        ? 'warn'
        : 'info';

      this.options.logger[logMethod](
        {
          event: entry.eventType,
          decision: entry.decision,
          host: entry.request.host,
          path: entry.request.path,
          rule: entry.matchResult?.matchedRule?.id,
        },
        `${entry.decision.toUpperCase()}: ${entry.request.host}${entry.request.path ?? ''}`
      );
    }
  }

  /**
   * Flush and close the audit log.
   */
  async close(): Promise<void> {
    if (this.writeStream) {
      return new Promise((resolve, reject) => {
        this.writeStream!.end((err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }
}

/**
 * Create an audit logger.
 */
export function createAuditLogger(options: AuditLoggerOptions = {}): AuditLogger {
  return new AuditLogger(options);
}
