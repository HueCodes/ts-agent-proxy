/**
 * Security audit logging for proxy decisions.
 *
 * Provides detailed logging of all proxy decisions with support for
 * header logging, body logging, and sensitive data redaction.
 *
 * @module logging/audit-logger
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from './logger.js';
import type { MatchResult, RequestInfo, AllowlistRule } from '../types/allowlist.js';
import type { RateLimitResult } from '../filter/rate-limiter.js';

/** Default headers to redact */
const DEFAULT_REDACT_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
  'api-key',
  'apikey',
  'token',
  'password',
  'secret',
];

/**
 * Audit log entry structure.
 */
export interface AuditLogEntry {
  /** Unique request ID for correlation */
  requestId: string;
  /** Timestamp of the event */
  timestamp: string;
  /** Type of event */
  eventType: 'request' | 'rate_limit' | 'error';
  /** Decision made */
  decision: 'allowed' | 'denied' | 'rate_limited';
  /** Request information */
  request: RequestInfo;
  /** Headers (if logging enabled, redacted) */
  headers?: Record<string, string>;
  /** Request body (if logging enabled, truncated) */
  body?: string;
  /** Match result */
  matchResult?: MatchResult;
  /** Rate limit result */
  rateLimitResult?: RateLimitResult;
  /** Error message if applicable */
  errorMessage?: string;
  /** Request duration in milliseconds */
  durationMs?: number;
}

/**
 * Options for the audit logger.
 */
export interface AuditLoggerOptions {
  /** Path to the audit log file */
  filePath?: string;
  /** Whether to also log to the main logger */
  logToMain?: boolean;
  /** Main logger instance */
  logger?: Logger;
  /** Whether to log request headers */
  logHeaders?: boolean;
  /** Whether to log request body */
  logBody?: boolean;
  /** Maximum body size to log in bytes */
  maxBodyLogSize?: number;
  /** Headers to redact (case-insensitive) */
  redactHeaders?: string[];
}

/**
 * Audit logger for security decisions.
 *
 * Logs all proxy decisions to file and/or console with support for:
 * - Request header logging with automatic redaction
 * - Request body logging with size limits
 * - Correlation IDs for request tracing
 *
 * @example
 * ```typescript
 * const auditLogger = new AuditLogger({
 *   filePath: './logs/audit.log',
 *   logHeaders: true,
 *   redactHeaders: ['authorization', 'x-api-key'],
 *   logBody: true,
 *   maxBodyLogSize: 1024
 * });
 *
 * auditLogger.logRequest(request, matchResult, 150);
 * ```
 */
export class AuditLogger {
  private readonly options: Required<Omit<AuditLoggerOptions, 'filePath' | 'logger'>> & {
    filePath?: string;
    logger?: Logger;
  };
  private readonly redactHeadersLower: Set<string>;
  private writeStream?: fs.WriteStream;

  /**
   * Creates a new AuditLogger.
   *
   * @param options - Logger configuration
   */
  constructor(options: AuditLoggerOptions = {}) {
    const redactHeaders = options.redactHeaders ?? DEFAULT_REDACT_HEADERS;

    this.options = {
      filePath: options.filePath,
      logToMain: options.logToMain ?? true,
      logger: options.logger,
      logHeaders: options.logHeaders ?? false,
      logBody: options.logBody ?? false,
      maxBodyLogSize: options.maxBodyLogSize ?? 1024,
      redactHeaders,
    };

    // Pre-compute lowercase header names for fast lookup
    this.redactHeadersLower = new Set(redactHeaders.map((h) => h.toLowerCase()));

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
   *
   * @param request - The request information
   * @param matchResult - The match result
   * @param optionsOrDurationMs - Additional logging options or duration in ms (backward compat)
   */
  logRequest(
    request: RequestInfo,
    matchResult: MatchResult,
    optionsOrDurationMs?: number | {
      durationMs?: number;
      headers?: Record<string, string | string[] | undefined>;
      body?: string | Buffer;
      requestId?: string;
    }
  ): void {
    // Handle backward compatibility
    const options = typeof optionsOrDurationMs === 'number'
      ? { durationMs: optionsOrDurationMs }
      : optionsOrDurationMs;

    const entry: AuditLogEntry = {
      requestId: options?.requestId ?? randomUUID(),
      timestamp: new Date().toISOString(),
      eventType: 'request',
      decision: matchResult.allowed ? 'allowed' : 'denied',
      request,
      matchResult,
      durationMs: options?.durationMs,
    };

    // Add redacted headers if enabled
    if (this.options.logHeaders && options?.headers) {
      entry.headers = this.redactHeaders(options.headers);
    }

    // Add truncated body if enabled
    if (this.options.logBody && options?.body) {
      entry.body = this.truncateBody(options.body);
    }

    this.writeEntry(entry);
  }

  /**
   * Redact sensitive headers.
   *
   * @param headers - The headers to redact
   * @returns Headers with sensitive values replaced with [REDACTED]
   */
  private redactHeaders(
    headers: Record<string, string | string[] | undefined>
  ): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) continue;

      const lowerKey = key.toLowerCase();
      const stringValue = Array.isArray(value) ? value.join(', ') : value;

      if (this.shouldRedactHeader(lowerKey)) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = stringValue;
      }
    }

    return result;
  }

  /**
   * Check if a header should be redacted.
   *
   * @param headerName - Lowercase header name
   * @returns True if the header should be redacted
   */
  private shouldRedactHeader(headerName: string): boolean {
    // Direct match
    if (this.redactHeadersLower.has(headerName)) {
      return true;
    }

    // Partial match for headers containing sensitive keywords
    const sensitiveKeywords = ['auth', 'token', 'key', 'secret', 'password', 'credential'];
    return sensitiveKeywords.some((keyword) => headerName.includes(keyword));
  }

  /**
   * Truncate body to max size.
   *
   * @param body - The body to truncate
   * @returns Truncated body string
   */
  private truncateBody(body: string | Buffer): string {
    const str = Buffer.isBuffer(body) ? body.toString('utf-8') : body;
    const maxSize = this.options.maxBodyLogSize;

    if (str.length <= maxSize) {
      return str;
    }

    return str.substring(0, maxSize) + '...[truncated]';
  }

  /**
   * Log a rate limit event.
   *
   * @param request - The request information
   * @param rateLimitResult - The rate limit check result
   * @param rule - Optional rule that was rate limited
   * @param requestId - Optional request ID for correlation
   */
  logRateLimit(
    request: RequestInfo,
    rateLimitResult: RateLimitResult,
    rule?: AllowlistRule,
    requestId?: string
  ): void {
    const entry: AuditLogEntry = {
      requestId: requestId ?? randomUUID(),
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
   *
   * @param request - The request information
   * @param error - The error that occurred
   * @param requestId - Optional request ID for correlation
   */
  logError(request: RequestInfo, error: Error | string, requestId?: string): void {
    const entry: AuditLogEntry = {
      requestId: requestId ?? randomUUID(),
      timestamp: new Date().toISOString(),
      eventType: 'error',
      decision: 'denied',
      request,
      errorMessage: typeof error === 'string' ? error : error.message,
    };

    this.writeEntry(entry);
  }

  /**
   * Generate a new request ID.
   *
   * @returns A unique request ID
   */
  generateRequestId(): string {
    return randomUUID();
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
          requestId: entry.requestId,
          event: entry.eventType,
          decision: entry.decision,
          host: entry.request.host,
          path: entry.request.path,
          rule: entry.matchResult?.matchedRule?.id,
          durationMs: entry.durationMs,
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
 *
 * @param options - Audit logger configuration
 * @returns New AuditLogger instance
 *
 * @example
 * ```typescript
 * const auditLogger = createAuditLogger({
 *   filePath: './logs/audit.jsonl',
 *   logHeaders: true,
 *   logBody: true,
 *   maxBodyLogSize: 2048,
 *   redactHeaders: ['authorization', 'cookie']
 * });
 * ```
 */
export function createAuditLogger(options: AuditLoggerOptions = {}): AuditLogger {
  return new AuditLogger(options);
}
