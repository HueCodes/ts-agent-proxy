/**
 * Robust HTTP request parser for MITM mode.
 *
 * Handles HTTP/1.0 and HTTP/1.1 requests including:
 * - Chunked transfer encoding
 * - Content-Length based bodies
 * - Streaming bodies with size limits
 * - Malformed request detection
 */

import { EventEmitter } from 'node:events';

/**
 * Parsed HTTP request.
 */
export interface ParsedHttpRequest {
  method: string;
  path: string;
  httpVersion: string;
  headers: Record<string, string>;
  body: Buffer;
  rawHeaders: Buffer;
  complete: boolean;
}

/**
 * Parser state.
 */
type ParserState =
  | 'request-line'
  | 'headers'
  | 'body-content-length'
  | 'body-chunked'
  | 'body-chunk-size'
  | 'body-chunk-data'
  | 'body-chunk-trailer'
  | 'complete'
  | 'error';

/**
 * HTTP parsing error.
 */
export class HttpParseError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'HttpParseError';
    this.code = code;
  }
}

/**
 * HTTP request parser with streaming support.
 */
export class HttpRequestParser extends EventEmitter {
  private state: ParserState = 'request-line';
  private buffer: Buffer = Buffer.alloc(0);
  private readonly maxHeaderSize: number;
  private readonly maxBodySize: number;

  // Parsed components
  private method = '';
  private path = '';
  private httpVersion = '';
  private headers: Record<string, string> = {};
  private rawHeaders: Buffer = Buffer.alloc(0);
  private body: Buffer = Buffer.alloc(0);
  private contentLength = -1;
  private isChunked = false;
  private currentChunkSize = 0;
  private bodyBytesReceived = 0;

  constructor(options: { maxHeaderSize?: number; maxBodySize?: number } = {}) {
    super();
    this.maxHeaderSize = options.maxHeaderSize ?? 16 * 1024;
    this.maxBodySize = options.maxBodySize ?? 10 * 1024 * 1024;
  }

  /**
   * Feed data into the parser.
   */
  write(data: Buffer): void {
    if (this.state === 'complete' || this.state === 'error') {
      return;
    }

    this.buffer = Buffer.concat([this.buffer, data]);

    try {
      this.parse();
    } catch (error) {
      this.state = 'error';
      this.emit('error', error);
    }
  }

  /**
   * Check if parsing is complete.
   */
  isComplete(): boolean {
    return this.state === 'complete';
  }

  /**
   * Check if an error occurred.
   */
  hasError(): boolean {
    return this.state === 'error';
  }

  /**
   * Get the parsed request (only valid when complete).
   */
  getRequest(): ParsedHttpRequest | null {
    if (this.state !== 'complete') {
      return null;
    }

    return {
      method: this.method,
      path: this.path,
      httpVersion: this.httpVersion,
      headers: this.headers,
      body: this.body,
      rawHeaders: this.rawHeaders,
      complete: true,
    };
  }

  /**
   * Get partial request data (for progress tracking).
   */
  getPartialRequest(): Partial<ParsedHttpRequest> {
    return {
      method: this.method || undefined,
      path: this.path || undefined,
      httpVersion: this.httpVersion || undefined,
      headers: Object.keys(this.headers).length > 0 ? this.headers : undefined,
      body: this.body.length > 0 ? this.body : undefined,
      complete: this.state === 'complete',
    };
  }

  /**
   * Reset the parser for a new request.
   */
  reset(): void {
    this.state = 'request-line';
    this.buffer = Buffer.alloc(0);
    this.method = '';
    this.path = '';
    this.httpVersion = '';
    this.headers = {};
    this.rawHeaders = Buffer.alloc(0);
    this.body = Buffer.alloc(0);
    this.contentLength = -1;
    this.isChunked = false;
    this.currentChunkSize = 0;
    this.bodyBytesReceived = 0;
  }

  /**
   * Main parsing loop.
   */
  private parse(): void {
    while (this.buffer.length > 0) {
      // Exit if parsing is complete or errored
      if (this.state === 'complete' || this.state === 'error') {
        return;
      }

      const prevBufferLength = this.buffer.length;

      switch (this.state) {
        case 'request-line':
          this.parseRequestLine();
          break;
        case 'headers':
          this.parseHeaders();
          break;
        case 'body-content-length':
          this.parseBodyContentLength();
          break;
        case 'body-chunked':
        case 'body-chunk-size':
          this.parseChunkSize();
          break;
        case 'body-chunk-data':
          this.parseChunkData();
          break;
        case 'body-chunk-trailer':
          this.parseChunkTrailer();
          break;
      }

      // If no progress was made, wait for more data
      if (this.buffer.length === prevBufferLength) {
        break;
      }
    }
  }

  /**
   * Parse the request line (METHOD PATH HTTP/VERSION).
   */
  private parseRequestLine(): void {
    const lineEnd = this.findLineEnd();
    if (lineEnd === -1) {
      if (this.buffer.length > this.maxHeaderSize) {
        throw new HttpParseError('Request line too long', 'REQUEST_LINE_TOO_LONG');
      }
      return;
    }

    const line = this.buffer.subarray(0, lineEnd).toString('utf8');
    this.buffer = this.buffer.subarray(lineEnd + 2); // Skip \r\n

    // Parse: METHOD PATH HTTP/VERSION
    const parts = line.split(' ');
    if (parts.length < 3) {
      throw new HttpParseError('Invalid request line', 'INVALID_REQUEST_LINE');
    }

    this.method = parts[0].toUpperCase();
    this.path = parts[1];
    this.httpVersion = parts.slice(2).join(' ');

    // Validate method
    const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE'];
    if (!validMethods.includes(this.method)) {
      throw new HttpParseError(`Invalid HTTP method: ${this.method}`, 'INVALID_METHOD');
    }

    // Validate HTTP version
    if (!this.httpVersion.startsWith('HTTP/')) {
      throw new HttpParseError(`Invalid HTTP version: ${this.httpVersion}`, 'INVALID_VERSION');
    }

    this.state = 'headers';
  }

  /**
   * Parse headers.
   */
  private parseHeaders(): void {
    while (true) {
      const lineEnd = this.findLineEnd();
      if (lineEnd === -1) {
        if (this.buffer.length > this.maxHeaderSize) {
          throw new HttpParseError('Headers too large', 'HEADERS_TOO_LARGE');
        }
        return;
      }

      const line = this.buffer.subarray(0, lineEnd).toString('utf8');
      const headerLine = this.buffer.subarray(0, lineEnd + 2);
      this.rawHeaders = Buffer.concat([this.rawHeaders, headerLine]);
      this.buffer = this.buffer.subarray(lineEnd + 2);

      // Empty line indicates end of headers
      if (line === '') {
        this.transitionToBody();
        return;
      }

      // Parse header: Name: Value
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) {
        throw new HttpParseError(`Invalid header line: ${line}`, 'INVALID_HEADER');
      }

      const name = line.substring(0, colonIndex).trim().toLowerCase();
      const value = line.substring(colonIndex + 1).trim();

      // Handle duplicate headers
      if (this.headers[name]) {
        this.headers[name] += ', ' + value;
      } else {
        this.headers[name] = value;
      }

      // Check total header size
      if (this.rawHeaders.length > this.maxHeaderSize) {
        throw new HttpParseError('Headers too large', 'HEADERS_TOO_LARGE');
      }
    }
  }

  /**
   * Determine body parsing mode and transition.
   */
  private transitionToBody(): void {
    // Check for chunked transfer encoding
    const transferEncoding = this.headers['transfer-encoding'];
    if (transferEncoding?.toLowerCase().includes('chunked')) {
      this.isChunked = true;
      this.state = 'body-chunk-size';
      return;
    }

    // Check for Content-Length
    const contentLengthHeader = this.headers['content-length'];
    if (contentLengthHeader) {
      this.contentLength = parseInt(contentLengthHeader, 10);
      if (isNaN(this.contentLength) || this.contentLength < 0) {
        throw new HttpParseError('Invalid Content-Length', 'INVALID_CONTENT_LENGTH');
      }
      if (this.contentLength > this.maxBodySize) {
        throw new HttpParseError('Request body too large', 'BODY_TOO_LARGE');
      }
      if (this.contentLength === 0) {
        this.state = 'complete';
        this.emit('complete', this.getRequest());
      } else {
        this.state = 'body-content-length';
      }
      return;
    }

    // No body (e.g., GET, HEAD, DELETE, etc.)
    const methodsWithoutBody = ['GET', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT'];
    if (methodsWithoutBody.includes(this.method)) {
      this.state = 'complete';
      this.emit('complete', this.getRequest());
      return;
    }

    // For POST/PUT/PATCH without Content-Length or chunked, assume no body
    this.state = 'complete';
    this.emit('complete', this.getRequest());
  }

  /**
   * Parse body with Content-Length.
   */
  private parseBodyContentLength(): void {
    const remaining = this.contentLength - this.bodyBytesReceived;
    const available = Math.min(remaining, this.buffer.length);

    if (available > 0) {
      const chunk = this.buffer.subarray(0, available);
      this.body = Buffer.concat([this.body, chunk]);
      this.bodyBytesReceived += available;
      this.buffer = this.buffer.subarray(available);

      this.emit('body', chunk);
    }

    if (this.bodyBytesReceived >= this.contentLength) {
      this.state = 'complete';
      this.emit('complete', this.getRequest());
    }
  }

  /**
   * Parse chunk size line.
   */
  private parseChunkSize(): void {
    const lineEnd = this.findLineEnd();
    if (lineEnd === -1) {
      return;
    }

    const line = this.buffer.subarray(0, lineEnd).toString('utf8');
    this.buffer = this.buffer.subarray(lineEnd + 2);

    // Chunk size may have extensions: size[;extension]
    const sizeStr = line.split(';')[0].trim();
    this.currentChunkSize = parseInt(sizeStr, 16);

    if (isNaN(this.currentChunkSize) || this.currentChunkSize < 0) {
      throw new HttpParseError('Invalid chunk size', 'INVALID_CHUNK_SIZE');
    }

    // Check body size limit
    if (this.bodyBytesReceived + this.currentChunkSize > this.maxBodySize) {
      throw new HttpParseError('Request body too large', 'BODY_TOO_LARGE');
    }

    if (this.currentChunkSize === 0) {
      // Last chunk, look for trailer headers
      this.state = 'body-chunk-trailer';
    } else {
      this.state = 'body-chunk-data';
    }
  }

  /**
   * Parse chunk data.
   */
  private parseChunkData(): void {
    const remaining = this.currentChunkSize;
    const available = Math.min(remaining, this.buffer.length);

    if (available > 0) {
      const chunk = this.buffer.subarray(0, available);
      this.body = Buffer.concat([this.body, chunk]);
      this.bodyBytesReceived += available;
      this.currentChunkSize -= available;
      this.buffer = this.buffer.subarray(available);

      this.emit('body', chunk);
    }

    if (this.currentChunkSize === 0) {
      // Expect \r\n after chunk data
      if (this.buffer.length >= 2) {
        if (this.buffer[0] !== 0x0d || this.buffer[1] !== 0x0a) {
          throw new HttpParseError('Missing CRLF after chunk data', 'INVALID_CHUNK_FORMAT');
        }
        this.buffer = this.buffer.subarray(2);
        this.state = 'body-chunk-size';
      }
    }
  }

  /**
   * Parse trailer headers after last chunk.
   */
  private parseChunkTrailer(): void {
    // Simplified: just look for empty line
    const lineEnd = this.findLineEnd();
    if (lineEnd === -1) {
      return;
    }

    const line = this.buffer.subarray(0, lineEnd).toString('utf8');
    this.buffer = this.buffer.subarray(lineEnd + 2);

    if (line === '') {
      // End of trailers
      this.state = 'complete';
      this.emit('complete', this.getRequest());
    }
    // Else: trailer header, continue parsing
  }

  /**
   * Find line ending (\r\n).
   */
  private findLineEnd(): number {
    for (let i = 0; i < this.buffer.length - 1; i++) {
      if (this.buffer[i] === 0x0d && this.buffer[i + 1] === 0x0a) {
        return i;
      }
    }
    return -1;
  }
}

/**
 * Parse a complete HTTP request from a buffer.
 * Returns null if the request is incomplete.
 */
export function parseHttpRequest(
  data: Buffer,
  options?: { maxHeaderSize?: number; maxBodySize?: number }
): ParsedHttpRequest | null {
  const parser = new HttpRequestParser(options);
  parser.write(data);

  if (parser.isComplete()) {
    return parser.getRequest();
  }

  return null;
}

/**
 * Create an HTTP request parser.
 */
export function createHttpRequestParser(
  options?: { maxHeaderSize?: number; maxBodySize?: number }
): HttpRequestParser {
  return new HttpRequestParser(options);
}

/**
 * Serialize a parsed request back to HTTP format.
 */
export function serializeHttpRequest(request: ParsedHttpRequest): Buffer {
  const lines: string[] = [];

  // Request line
  lines.push(`${request.method} ${request.path} ${request.httpVersion}`);

  // Headers
  for (const [name, value] of Object.entries(request.headers)) {
    // Capitalize header names
    const capitalizedName = name.replace(/(^|-)([a-z])/g, (_, prefix, char) => prefix + char.toUpperCase());
    lines.push(`${capitalizedName}: ${value}`);
  }

  lines.push(''); // End of headers

  const headerBuffer = Buffer.from(lines.join('\r\n') + '\r\n', 'utf8');
  return Buffer.concat([headerBuffer, request.body]);
}
