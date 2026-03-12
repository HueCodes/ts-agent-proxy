/**
 * Stream utilities for enforcing size limits.
 *
 * Provides transform streams and utilities for limiting
 * request and response body sizes.
 */

import { Transform, type TransformCallback } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

/**
 * Error thrown when a size limit is exceeded.
 */
export class SizeLimitExceededError extends Error {
  readonly code = 'SIZE_LIMIT_EXCEEDED';
  readonly limit: number;
  readonly received: number;
  readonly type: 'request' | 'response' | 'header' | 'url';

  constructor(type: 'request' | 'response' | 'header' | 'url', limit: number, received: number) {
    super(`${type} size limit exceeded: ${received} bytes exceeds ${limit} byte limit`);
    this.name = 'SizeLimitExceededError';
    this.limit = limit;
    this.received = received;
    this.type = type;
  }
}

/**
 * Transform stream that limits the amount of data passing through.
 */
export class LimitingStream extends Transform {
  private bytesReceived = 0;
  private readonly limit: number;
  private readonly type: 'request' | 'response';

  constructor(limit: number, type: 'request' | 'response' = 'request') {
    super();
    this.limit = limit;
    this.type = type;
  }

  _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    this.bytesReceived += chunk.length;

    if (this.bytesReceived > this.limit) {
      callback(new SizeLimitExceededError(this.type, this.limit, this.bytesReceived));
      return;
    }

    callback(null, chunk);
  }

  getBytesReceived(): number {
    return this.bytesReceived;
  }
}

/**
 * Check if a request's Content-Length exceeds the limit.
 * Returns null if within limit, or the size if it exceeds.
 */
export function checkContentLength(
  req: IncomingMessage,
  limit: number,
): { valid: true } | { valid: false; size: number } {
  const contentLength = req.headers['content-length'];
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (!isNaN(size) && size > limit) {
      return { valid: false, size };
    }
  }
  return { valid: true };
}

/**
 * Check if request headers size exceeds limit.
 */
export function checkHeadersSize(
  req: IncomingMessage,
  limit: number,
): { valid: true; size: number } | { valid: false; size: number } {
  // Estimate header size
  let size = 0;

  // Request line
  size += (req.method?.length ?? 0) + (req.url?.length ?? 0) + 12; // "GET /path HTTP/1.1\r\n"

  // Headers
  const rawHeaders = req.rawHeaders;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    size += (rawHeaders[i]?.length ?? 0) + (rawHeaders[i + 1]?.length ?? 0) + 4; // "key: value\r\n"
  }

  size += 2; // Final \r\n

  if (size > limit) {
    return { valid: false, size };
  }

  return { valid: true, size };
}

/**
 * Check if URL length exceeds limit.
 */
export function checkUrlLength(
  url: string | undefined,
  limit: number,
): { valid: true } | { valid: false; length: number } {
  const length = url?.length ?? 0;
  if (length > limit) {
    return { valid: false, length };
  }
  return { valid: true };
}

/**
 * Generate a unique request ID.
 */
let requestCounter = 0;
export function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${(requestCounter++).toString(36)}`;
}

/**
 * Build a structured JSON error response body.
 */
export function buildErrorBody(
  errorCode: string,
  message: string,
  requestId: string,
  extra?: Record<string, unknown>,
): string {
  return JSON.stringify({
    error: errorCode,
    message,
    requestId,
    ...extra,
  });
}

/**
 * Send a structured JSON error response.
 */
export function sendJsonError(
  res: ServerResponse,
  statusCode: number,
  errorCode: string,
  message: string,
  requestId?: string,
  extraHeaders?: Record<string, string>,
): void {
  const reqId = requestId ?? generateRequestId();
  if (!res.headersSent) {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      Connection: 'close',
      'X-Request-Id': reqId,
      ...extraHeaders,
    });
  }
  res.end(buildErrorBody(errorCode, message, reqId));
}

/**
 * Send a 413 Payload Too Large response.
 */
export function sendPayloadTooLarge(
  res: ServerResponse,
  message: string = 'Request body too large',
  requestId?: string,
): void {
  sendJsonError(res, 413, 'PAYLOAD_TOO_LARGE', message, requestId);
}

/**
 * Send a 431 Request Header Fields Too Large response.
 */
export function sendHeadersTooLarge(
  res: ServerResponse,
  message: string = 'Request headers too large',
  requestId?: string,
): void {
  sendJsonError(res, 431, 'HEADERS_TOO_LARGE', message, requestId);
}

/**
 * Send a 414 URI Too Long response.
 */
export function sendUriTooLong(
  res: ServerResponse,
  message: string = 'Request URI too long',
  requestId?: string,
): void {
  sendJsonError(res, 414, 'URI_TOO_LONG', message, requestId);
}

/**
 * Send a 504 Gateway Timeout response.
 */
export function sendGatewayTimeout(
  res: ServerResponse,
  message: string = 'Gateway timeout',
  requestId?: string,
): void {
  sendJsonError(res, 504, 'GATEWAY_TIMEOUT', message, requestId);
}

/**
 * Send a 503 Service Unavailable response (for connection limits).
 */
export function sendServiceUnavailable(
  res: ServerResponse,
  message: string = 'Service temporarily unavailable',
  requestId?: string,
): void {
  sendJsonError(res, 503, 'SERVICE_UNAVAILABLE', message, requestId, {
    'Retry-After': '5',
  });
}

/**
 * Send error response over raw socket (for CONNECT requests).
 */
export function sendSocketError(
  socket: Socket,
  statusCode: number,
  statusText: string,
  message: string,
  headers: Record<string, string> = {},
): void {
  const requestId = generateRequestId();
  const body = buildErrorBody(statusText.toUpperCase().replace(/\s+/g, '_'), message, requestId);

  const allHeaders = {
    'Content-Type': 'application/json',
    Connection: 'close',
    'X-Request-Id': requestId,
    ...headers,
  };

  let response = `HTTP/1.1 ${statusCode} ${statusText}\r\n`;
  for (const [key, value] of Object.entries(allHeaders)) {
    response += `${key}: ${value}\r\n`;
  }
  response += `\r\n${body}`;

  socket.write(response);
  socket.end();
}

/**
 * Create a timeout promise that rejects after the specified duration.
 */
export function createTimeout<T>(
  ms: number,
  message: string = 'Operation timed out',
): { promise: Promise<T>; clear: () => void } {
  let timeoutId: NodeJS.Timeout;

  const promise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new TimeoutError(message, ms));
    }, ms);
  });

  const clear = () => {
    clearTimeout(timeoutId);
  };

  return { promise, clear };
}

/**
 * Error thrown when an operation times out.
 */
export class TimeoutError extends Error {
  readonly code = 'TIMEOUT';
  readonly timeout: number;

  constructor(message: string, timeout: number) {
    super(message);
    this.name = 'TimeoutError';
    this.timeout = timeout;
  }
}

/**
 * Race a promise against a timeout.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string = 'Operation timed out',
): Promise<T> {
  const { promise: timeoutPromise, clear } = createTimeout<T>(ms, message);

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clear();
  }
}
