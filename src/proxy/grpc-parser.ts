/**
 * gRPC frame parser and utilities.
 *
 * Handles parsing of gRPC wire format including length-prefixed messages,
 * metadata extraction, and status code handling.
 *
 * @module proxy/grpc-parser
 */

/**
 * gRPC status codes.
 * @see https://grpc.github.io/grpc/core/md_doc_statuscodes.html
 */
export enum GrpcStatus {
  OK = 0,
  CANCELLED = 1,
  UNKNOWN = 2,
  INVALID_ARGUMENT = 3,
  DEADLINE_EXCEEDED = 4,
  NOT_FOUND = 5,
  ALREADY_EXISTS = 6,
  PERMISSION_DENIED = 7,
  RESOURCE_EXHAUSTED = 8,
  FAILED_PRECONDITION = 9,
  ABORTED = 10,
  OUT_OF_RANGE = 11,
  UNIMPLEMENTED = 12,
  INTERNAL = 13,
  UNAVAILABLE = 14,
  DATA_LOSS = 15,
  UNAUTHENTICATED = 16,
}

/**
 * gRPC status code names.
 */
export const GrpcStatusName: Record<GrpcStatus, string> = {
  [GrpcStatus.OK]: 'OK',
  [GrpcStatus.CANCELLED]: 'CANCELLED',
  [GrpcStatus.UNKNOWN]: 'UNKNOWN',
  [GrpcStatus.INVALID_ARGUMENT]: 'INVALID_ARGUMENT',
  [GrpcStatus.DEADLINE_EXCEEDED]: 'DEADLINE_EXCEEDED',
  [GrpcStatus.NOT_FOUND]: 'NOT_FOUND',
  [GrpcStatus.ALREADY_EXISTS]: 'ALREADY_EXISTS',
  [GrpcStatus.PERMISSION_DENIED]: 'PERMISSION_DENIED',
  [GrpcStatus.RESOURCE_EXHAUSTED]: 'RESOURCE_EXHAUSTED',
  [GrpcStatus.FAILED_PRECONDITION]: 'FAILED_PRECONDITION',
  [GrpcStatus.ABORTED]: 'ABORTED',
  [GrpcStatus.OUT_OF_RANGE]: 'OUT_OF_RANGE',
  [GrpcStatus.UNIMPLEMENTED]: 'UNIMPLEMENTED',
  [GrpcStatus.INTERNAL]: 'INTERNAL',
  [GrpcStatus.UNAVAILABLE]: 'UNAVAILABLE',
  [GrpcStatus.DATA_LOSS]: 'DATA_LOSS',
  [GrpcStatus.UNAUTHENTICATED]: 'UNAUTHENTICATED',
};

/**
 * gRPC frame header size (1 byte compressed flag + 4 bytes length).
 */
export const GRPC_FRAME_HEADER_SIZE = 5;

/**
 * Maximum gRPC message size (4MB default).
 */
export const DEFAULT_MAX_MESSAGE_SIZE = 4 * 1024 * 1024;

/**
 * Parsed gRPC frame.
 */
export interface GrpcFrame {
  /** Whether the message is compressed */
  compressed: boolean;
  /** Message length */
  length: number;
  /** Message data */
  data: Buffer;
}

/**
 * Parsed gRPC path (service and method).
 */
export interface GrpcPath {
  /** Full path (e.g., /package.Service/Method) */
  fullPath: string;
  /** Package name (may be empty) */
  package: string;
  /** Service name */
  service: string;
  /** Method name */
  method: string;
  /** Full service name (package.Service) */
  fullService: string;
}

/**
 * gRPC metadata (headers/trailers).
 */
export type GrpcMetadata = Map<string, string | string[]>;

/**
 * gRPC trailer information.
 */
export interface GrpcTrailers {
  status: GrpcStatus;
  message?: string;
  metadata: GrpcMetadata;
}

/**
 * Parse a gRPC path into components.
 *
 * gRPC paths follow the format: /package.Service/Method
 *
 * @param path - The request path
 * @returns Parsed path components or null if invalid
 */
export function parseGrpcPath(path: string): GrpcPath | null {
  // gRPC paths must start with /
  if (!path.startsWith('/')) {
    return null;
  }

  // Format: /package.Service/Method or /Service/Method
  const parts = path.slice(1).split('/');
  if (parts.length !== 2) {
    return null;
  }

  const [fullService, method] = parts;
  if (!fullService || !method) {
    return null;
  }

  // Split service into package and service name
  const lastDot = fullService.lastIndexOf('.');
  let packageName = '';
  let service = fullService;

  if (lastDot !== -1) {
    packageName = fullService.slice(0, lastDot);
    service = fullService.slice(lastDot + 1);
  }

  return {
    fullPath: path,
    package: packageName,
    service,
    method,
    fullService,
  };
}

/**
 * Build a gRPC path from components.
 */
export function buildGrpcPath(service: string, method: string): string {
  return `/${service}/${method}`;
}

/**
 * Parse a gRPC frame from a buffer.
 *
 * gRPC frame format:
 * - 1 byte: compressed flag (0 or 1)
 * - 4 bytes: message length (big-endian)
 * - N bytes: message data
 *
 * @param buffer - Buffer containing gRPC frame
 * @returns Parsed frame or null if incomplete
 */
export function parseGrpcFrame(buffer: Buffer): GrpcFrame | null {
  if (buffer.length < GRPC_FRAME_HEADER_SIZE) {
    return null;
  }

  const compressed = buffer[0] === 1;
  const length = buffer.readUInt32BE(1);

  if (buffer.length < GRPC_FRAME_HEADER_SIZE + length) {
    return null;
  }

  const data = buffer.slice(GRPC_FRAME_HEADER_SIZE, GRPC_FRAME_HEADER_SIZE + length);

  return { compressed, length, data };
}

/**
 * Parse multiple gRPC frames from a buffer.
 *
 * @param buffer - Buffer containing one or more gRPC frames
 * @returns Array of parsed frames and remaining buffer
 */
export function parseGrpcFrames(buffer: Buffer): { frames: GrpcFrame[]; remaining: Buffer } {
  const frames: GrpcFrame[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (buffer.length - offset < GRPC_FRAME_HEADER_SIZE) {
      break;
    }

    const length = buffer.readUInt32BE(offset + 1);
    const totalFrameSize = GRPC_FRAME_HEADER_SIZE + length;

    if (buffer.length - offset < totalFrameSize) {
      break;
    }

    const compressed = buffer[offset] === 1;
    const data = buffer.slice(offset + GRPC_FRAME_HEADER_SIZE, offset + totalFrameSize);

    frames.push({ compressed, length, data });
    offset += totalFrameSize;
  }

  return {
    frames,
    remaining: buffer.slice(offset),
  };
}

/**
 * Encode a gRPC frame.
 *
 * @param data - Message data
 * @param compressed - Whether the message is compressed
 * @returns Encoded frame buffer
 */
export function encodeGrpcFrame(data: Buffer, compressed: boolean = false): Buffer {
  const header = Buffer.alloc(GRPC_FRAME_HEADER_SIZE);
  header[0] = compressed ? 1 : 0;
  header.writeUInt32BE(data.length, 1);

  return Buffer.concat([header, data]);
}

/**
 * Parse gRPC timeout header value.
 *
 * Format: <value><unit> where unit is H (hours), M (minutes), S (seconds),
 * m (milliseconds), u (microseconds), n (nanoseconds)
 *
 * @param timeout - Timeout header value
 * @returns Timeout in milliseconds or null if invalid
 */
export function parseGrpcTimeout(timeout: string): number | null {
  const match = timeout.match(/^(\d+)([HMSmun])$/);
  if (!match) {
    return null;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 'H':
      return value * 60 * 60 * 1000;
    case 'M':
      return value * 60 * 1000;
    case 'S':
      return value * 1000;
    case 'm':
      return value;
    case 'u':
      return Math.ceil(value / 1000);
    case 'n':
      return Math.ceil(value / 1000000);
    default:
      return null;
  }
}

/**
 * Encode a timeout value for gRPC.
 *
 * @param ms - Timeout in milliseconds
 * @returns Encoded timeout string
 */
export function encodeGrpcTimeout(ms: number): string {
  if (ms >= 60 * 60 * 1000) {
    return `${Math.floor(ms / (60 * 60 * 1000))}H`;
  }
  if (ms >= 60 * 1000) {
    return `${Math.floor(ms / (60 * 1000))}M`;
  }
  if (ms >= 1000) {
    return `${Math.floor(ms / 1000)}S`;
  }
  return `${ms}m`;
}

/**
 * Parse gRPC metadata from HTTP/2 headers.
 *
 * @param headers - HTTP/2 headers object
 * @returns Parsed metadata map
 */
export function parseGrpcMetadata(headers: Record<string, string | string[] | undefined>): GrpcMetadata {
  const metadata: GrpcMetadata = new Map();

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;

    // Skip pseudo-headers and standard HTTP headers
    if (key.startsWith(':') || isStandardHeader(key)) {
      continue;
    }

    // Handle binary metadata (keys ending in -bin)
    if (key.endsWith('-bin')) {
      const decoded = Array.isArray(value)
        ? value.map((v) => Buffer.from(v, 'base64').toString('utf-8'))
        : Buffer.from(value, 'base64').toString('utf-8');
      metadata.set(key, decoded);
    } else {
      metadata.set(key, value);
    }
  }

  return metadata;
}

/**
 * Encode gRPC metadata to HTTP/2 headers format.
 *
 * @param metadata - Metadata map
 * @returns Headers object
 */
export function encodeGrpcMetadata(metadata: GrpcMetadata): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};

  for (const [key, value] of metadata) {
    // Binary metadata needs base64 encoding
    if (key.endsWith('-bin')) {
      if (Array.isArray(value)) {
        headers[key] = value.map((v) => Buffer.from(v).toString('base64'));
      } else {
        headers[key] = Buffer.from(value).toString('base64');
      }
    } else {
      headers[key] = value;
    }
  }

  return headers;
}

/**
 * Parse gRPC trailers from headers.
 *
 * @param headers - Trailer headers
 * @returns Parsed trailers
 */
export function parseGrpcTrailers(headers: Record<string, string | string[] | undefined>): GrpcTrailers {
  const statusStr = headers['grpc-status'];
  const status = statusStr !== undefined
    ? parseInt(Array.isArray(statusStr) ? statusStr[0] : statusStr, 10)
    : GrpcStatus.OK;

  const messageStr = headers['grpc-message'];
  const message = messageStr !== undefined
    ? decodeURIComponent(Array.isArray(messageStr) ? messageStr[0] : messageStr)
    : undefined;

  return {
    status: status as GrpcStatus,
    message,
    metadata: parseGrpcMetadata(headers),
  };
}

/**
 * Encode gRPC trailers to headers format.
 *
 * @param status - gRPC status code
 * @param message - Optional error message
 * @param metadata - Optional additional metadata
 * @returns Headers object
 */
export function encodeGrpcTrailers(
  status: GrpcStatus,
  message?: string,
  metadata?: GrpcMetadata
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {
    'grpc-status': String(status),
  };

  if (message) {
    headers['grpc-message'] = encodeURIComponent(message);
  }

  if (metadata) {
    Object.assign(headers, encodeGrpcMetadata(metadata));
  }

  return headers;
}

/**
 * Check if a content-type indicates gRPC.
 *
 * @param contentType - Content-Type header value
 * @returns True if gRPC content type
 */
export function isGrpcContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return contentType.startsWith('application/grpc');
}

/**
 * Check if a content-type indicates gRPC-Web.
 *
 * @param contentType - Content-Type header value
 * @returns True if gRPC-Web content type
 */
export function isGrpcWebContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return contentType.startsWith('application/grpc-web');
}

/**
 * Check if a content-type indicates gRPC-Web text (base64 encoded).
 *
 * @param contentType - Content-Type header value
 * @returns True if gRPC-Web text content type
 */
export function isGrpcWebTextContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return contentType.startsWith('application/grpc-web-text');
}

/**
 * Check if a header is a standard HTTP header (not gRPC metadata).
 */
function isStandardHeader(name: string): boolean {
  const standard = new Set([
    'content-type',
    'content-length',
    'content-encoding',
    'accept',
    'accept-encoding',
    'user-agent',
    'te',
    'host',
    'grpc-timeout',
    'grpc-encoding',
    'grpc-accept-encoding',
    'grpc-status',
    'grpc-message',
  ]);
  return standard.has(name.toLowerCase());
}

/**
 * Create an error response for gRPC.
 *
 * @param status - gRPC status code
 * @param message - Error message
 * @returns Trailers for error response
 */
export function createGrpcError(status: GrpcStatus, message: string): GrpcTrailers {
  return {
    status,
    message,
    metadata: new Map(),
  };
}

/**
 * Validate a gRPC frame size.
 *
 * @param length - Frame length
 * @param maxSize - Maximum allowed size
 * @returns True if valid
 */
export function validateFrameSize(length: number, maxSize: number = DEFAULT_MAX_MESSAGE_SIZE): boolean {
  return length >= 0 && length <= maxSize;
}
