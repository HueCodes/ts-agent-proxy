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
import type { LogDestination } from './log-destinations.js';

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
 * Denial reason codes.
 */
export enum DenialReasonCode {
  NO_MATCHING_RULE = 'NO_MATCHING_RULE',
  DOMAIN_NOT_ALLOWED = 'DOMAIN_NOT_ALLOWED',
  PATH_NOT_ALLOWED = 'PATH_NOT_ALLOWED',
  METHOD_NOT_ALLOWED = 'METHOD_NOT_ALLOWED',
  IP_NOT_ALLOWED = 'IP_NOT_ALLOWED',
  IP_EXCLUDED = 'IP_EXCLUDED',
  RATE_LIMITED = 'RATE_LIMITED',
  REQUEST_TOO_LARGE = 'REQUEST_TOO_LARGE',
  TIMEOUT = 'TIMEOUT',
  UPSTREAM_ERROR = 'UPSTREAM_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

/**
 * Denial reason with code and message.
 */
export interface DenialReason {
  /** Machine-readable code */
  code: DenialReasonCode;
  /** Human-readable message */
  message: string;
  /** Additional details */
  details?: Record<string, any>;
}

/**
 * Response information for audit log.
 */
export interface ResponseInfo {
  /** HTTP status code */
  statusCode: number;
  /** Status message */
  statusMessage?: string;
  /** Response size in bytes */
  contentLength?: number;
  /** Content type */
  contentType?: string;
}

/**
 * Audit log entry structure.
 */
export interface AuditLogEntry {
  /** Unique request ID for correlation */
  requestId: string;
  /** Trace ID for distributed tracing correlation */
  traceId?: string;
  /** Span ID for distributed tracing correlation */
  spanId?: string;
  /** Timestamp of the event */
  timestamp: string;
  /** Type of event */
  eventType: 'request' | 'rate_limit' | 'error';
  /** Decision made */
  decision: 'allowed' | 'denied' | 'rate_limited';
  /** Request information */
  request: RequestInfo;
  /** Response information */
  response?: ResponseInfo;
  /** Headers (if logging enabled, redacted) */
  headers?: Record<string, string>;
  /** Response headers (if logging enabled, redacted) */
  responseHeaders?: Record<string, string>;
  /** Request body (if logging enabled, truncated) */
  body?: string;
  /** Match result */
  matchResult?: MatchResult;
  /** Rate limit result */
  rateLimitResult?: RateLimitResult;
  /** Structured denial reason */
  denialReason?: DenialReason;
  /** Error message if applicable */
  errorMessage?: string;
  /** Request duration in milliseconds */
  durationMs?: number;
  /** Bytes sent */
  bytesSent?: number;
  /** Bytes received */
  bytesReceived?: number;
}

/**
 * Logging level for requests.
 */
export type LoggingLevel = 'none' | 'minimal' | 'headers' | 'full';

/**
 * PII scrubbing configuration.
 */
export interface PiiScrubbingConfig {
  /** Enable PII scrubbing in body content */
  enabled: boolean;
  /** Patterns to scrub (regex strings) */
  patterns?: string[];
  /** Replacement text (default: '[REDACTED]') */
  replacement?: string;
}

/**
 * Default PII patterns.
 */
export const DEFAULT_PII_PATTERNS = [
  // Credit card numbers
  '\\b(?:\\d{4}[- ]?){3}\\d{4}\\b',
  // SSN
  '\\b\\d{3}-\\d{2}-\\d{4}\\b',
  // Email addresses
  '\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b',
  // Phone numbers
  '\\b(?:\\+?1[-.]?)?\\(?\\d{3}\\)?[-.]?\\d{3}[-.]?\\d{4}\\b',
  // API keys (common patterns)
  '\\b[A-Za-z0-9]{32,}\\b',
  // JWT tokens
  'eyJ[A-Za-z0-9_-]*\\.eyJ[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]*',
];

/**
 * Options for the audit logger.
 */
export interface AuditLoggerOptions {
  /** Path to the audit log file (legacy, use destinations instead) */
  filePath?: string;
  /** Log destinations (file, console, webhook, etc.) */
  destinations?: LogDestination[];
  /** Whether to also log to the main logger */
  logToMain?: boolean;
  /** Main logger instance */
  logger?: Logger;
  /** Default logging level */
  loggingLevel?: LoggingLevel;
  /** Whether to log request headers (deprecated, use loggingLevel) */
  logHeaders?: boolean;
  /** Whether to log request body (deprecated, use loggingLevel) */
  logBody?: boolean;
  /** Maximum body size to log in bytes */
  maxBodyLogSize?: number;
  /** Headers to redact (case-insensitive) */
  redactHeaders?: string[];
  /** PII scrubbing configuration */
  piiScrubbing?: PiiScrubbingConfig;
  /** Sampling rate (0.0 to 1.0, default: 1.0 = log all) */
  samplingRate?: number;
  /** Only log requests with these status codes */
  logStatusCodes?: number[];
  /** Log response headers */
  logResponseHeaders?: boolean;
}

/**
 * Audit logger for security decisions.
 *
 * Logs all proxy decisions to file and/or console with support for:
 * - Request header logging with automatic redaction
 * - Request body logging with size limits
 * - Correlation IDs for request tracing
 * - Multiple log destinations
 * - PII scrubbing
 * - Sampling
 *
 * @example
 * ```typescript
 * const auditLogger = new AuditLogger({
 *   filePath: './logs/audit.log',
 *   loggingLevel: 'headers',
 *   redactHeaders: ['authorization', 'x-api-key'],
 *   piiScrubbing: { enabled: true },
 *   samplingRate: 0.5
 * });
 *
 * auditLogger.logRequest(request, matchResult, { durationMs: 150 });
 * ```
 */
export class AuditLogger {
  private readonly options: Required<Omit<AuditLoggerOptions, 'filePath' | 'logger' | 'destinations' | 'piiScrubbing' | 'logStatusCodes'>> & {
    filePath?: string;
    logger?: Logger;
    destinations: LogDestination[];
    piiScrubbing?: PiiScrubbingConfig;
    logStatusCodes?: number[];
  };
  private readonly redactHeadersLower: Set<string>;
  private readonly piiPatterns: RegExp[];
  private writeStream?: fs.WriteStream;

  /**
   * Creates a new AuditLogger.
   *
   * @param options - Logger configuration
   */
  constructor(options: AuditLoggerOptions = {}) {
    const redactHeaders = options.redactHeaders ?? DEFAULT_REDACT_HEADERS;

    // Determine logging level from legacy options if not specified
    let loggingLevel = options.loggingLevel;
    if (!loggingLevel) {
      if (options.logBody) loggingLevel = 'full';
      else if (options.logHeaders) loggingLevel = 'headers';
      else loggingLevel = 'minimal';
    }

    this.options = {
      filePath: options.filePath,
      destinations: options.destinations ?? [],
      logToMain: options.logToMain ?? true,
      logger: options.logger,
      loggingLevel,
      logHeaders: options.logHeaders ?? (loggingLevel === 'headers' || loggingLevel === 'full'),
      logBody: options.logBody ?? (loggingLevel === 'full'),
      maxBodyLogSize: options.maxBodyLogSize ?? 1024,
      redactHeaders,
      piiScrubbing: options.piiScrubbing,
      samplingRate: options.samplingRate ?? 1.0,
      logStatusCodes: options.logStatusCodes,
      logResponseHeaders: options.logResponseHeaders ?? false,
    };

    // Pre-compute lowercase header names for fast lookup
    this.redactHeadersLower = new Set(redactHeaders.map((h) => h.toLowerCase()));

    // Compile PII patterns
    if (this.options.piiScrubbing?.enabled) {
      const patterns = this.options.piiScrubbing.patterns ?? DEFAULT_PII_PATTERNS;
      this.piiPatterns = patterns.map((p) => new RegExp(p, 'gi'));
    } else {
      this.piiPatterns = [];
    }

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
   * Check if this request should be logged based on sampling.
   */
  private shouldLog(statusCode?: number): boolean {
    // Check sampling rate
    if (this.options.samplingRate < 1.0 && Math.random() > this.options.samplingRate) {
      return false;
    }

    // Check status code filter
    if (this.options.logStatusCodes && statusCode !== undefined) {
      return this.options.logStatusCodes.includes(statusCode);
    }

    return true;
  }

  /**
   * Scrub PII from content.
   */
  private scrubPii(content: string): string {
    if (!this.options.piiScrubbing?.enabled || this.piiPatterns.length === 0) {
      return content;
    }

    const replacement = this.options.piiScrubbing.replacement ?? '[REDACTED]';
    let result = content;

    for (const pattern of this.piiPatterns) {
      result = result.replace(pattern, replacement);
    }

    return result;
  }

  /**
   * Create a denial reason from a match result or error.
   */
  createDenialReason(
    code: DenialReasonCode,
    message: string,
    details?: Record<string, any>
  ): DenialReason {
    return { code, message, details };
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
      responseHeaders?: Record<string, string | string[] | undefined>;
      body?: string | Buffer;
      requestId?: string;
      traceId?: string;
      spanId?: string;
      response?: ResponseInfo;
      denialReason?: DenialReason;
      bytesSent?: number;
      bytesReceived?: number;
    }
  ): void {
    // Handle backward compatibility
    const options = typeof optionsOrDurationMs === 'number'
      ? { durationMs: optionsOrDurationMs }
      : optionsOrDurationMs;

    // Check if we should log this request
    if (!this.shouldLog(options?.response?.statusCode)) {
      return;
    }

    const entry: AuditLogEntry = {
      requestId: options?.requestId ?? randomUUID(),
      traceId: options?.traceId,
      spanId: options?.spanId,
      timestamp: new Date().toISOString(),
      eventType: 'request',
      decision: matchResult.allowed ? 'allowed' : 'denied',
      request,
      response: options?.response,
      matchResult,
      durationMs: options?.durationMs,
      bytesSent: options?.bytesSent,
      bytesReceived: options?.bytesReceived,
    };

    // Add denial reason for denied requests
    if (!matchResult.allowed) {
      entry.denialReason = options?.denialReason ?? this.createDenialReason(
        DenialReasonCode.NO_MATCHING_RULE,
        matchResult.reason ?? 'Request denied by allowlist rules'
      );
    }

    // Add redacted headers based on logging level
    if (this.options.loggingLevel !== 'none' && this.options.loggingLevel !== 'minimal') {
      if (options?.headers) {
        entry.headers = this.redactHeaders(options.headers);
      }
      if (this.options.logResponseHeaders && options?.responseHeaders) {
        entry.responseHeaders = this.redactHeaders(options.responseHeaders);
      }
    }

    // Add truncated body if logging level is full
    if (this.options.loggingLevel === 'full' && options?.body) {
      let bodyStr = this.truncateBody(options.body);
      bodyStr = this.scrubPii(bodyStr);
      entry.body = bodyStr;
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

    // Write to file if configured (legacy support)
    if (this.writeStream) {
      this.writeStream.write(line + '\n');
    }

    // Write to all configured destinations
    for (const destination of this.options.destinations) {
      try {
        destination.write(line);
      } catch (err) {
        // Log destination errors but don't fail
        this.options.logger?.error(
          { error: err, destination: destination.name },
          'Failed to write to log destination'
        );
      }
    }

    // Log to main logger if configured
    if (this.options.logToMain && this.options.logger) {
      const logMethod = entry.decision === 'denied' || entry.decision === 'rate_limited'
        ? 'warn'
        : 'info';

      this.options.logger[logMethod](
        {
          requestId: entry.requestId,
          traceId: entry.traceId,
          event: entry.eventType,
          decision: entry.decision,
          host: entry.request.host,
          path: entry.request.path,
          method: entry.request.method,
          statusCode: entry.response?.statusCode,
          rule: entry.matchResult?.matchedRule?.id,
          durationMs: entry.durationMs,
          denialCode: entry.denialReason?.code,
        },
        `${entry.decision.toUpperCase()}: ${entry.request.method ?? 'CONNECT'} ${entry.request.host}${entry.request.path ?? ''} -> ${entry.response?.statusCode ?? 'N/A'}`
      );
    }
  }

  /**
   * Flush and close the audit log.
   */
  async close(): Promise<void> {
    // Close legacy file stream
    if (this.writeStream) {
      await new Promise<void>((resolve, reject) => {
        this.writeStream!.end((err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }

    // Close all destinations
    for (const destination of this.options.destinations) {
      try {
        await destination.close();
      } catch (err) {
        this.options.logger?.error(
          { error: err, destination: destination.name },
          'Failed to close log destination'
        );
      }
    }
  }

  /**
   * Add a log destination.
   */
  addDestination(destination: LogDestination): void {
    this.options.destinations.push(destination);
  }

  /**
   * Get the current logging level.
   */
  getLoggingLevel(): LoggingLevel {
    return this.options.loggingLevel;
  }

  /**
   * Set the logging level.
   */
  setLoggingLevel(level: LoggingLevel): void {
    this.options.loggingLevel = level;
    this.options.logHeaders = level === 'headers' || level === 'full';
    this.options.logBody = level === 'full';
  }

  /**
   * Set the sampling rate.
   */
  setSamplingRate(rate: number): void {
    this.options.samplingRate = Math.max(0, Math.min(1, rate));
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
