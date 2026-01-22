import { describe, it, expect } from 'vitest';
import {
  parseGrpcPath,
  buildGrpcPath,
  parseGrpcFrame,
  parseGrpcFrames,
  encodeGrpcFrame,
  parseGrpcTimeout,
  encodeGrpcTimeout,
  parseGrpcMetadata,
  encodeGrpcMetadata,
  parseGrpcTrailers,
  encodeGrpcTrailers,
  isGrpcContentType,
  isGrpcWebContentType,
  isGrpcWebTextContentType,
  validateFrameSize,
  createGrpcError,
  GrpcStatus,
  GrpcStatusName,
  GRPC_FRAME_HEADER_SIZE,
} from '../src/proxy/grpc-parser.js';

describe('gRPC Parser', () => {
  describe('parseGrpcPath', () => {
    it('should parse standard gRPC path', () => {
      const result = parseGrpcPath('/myapp.UserService/GetUser');

      expect(result).not.toBeNull();
      expect(result!.fullPath).toBe('/myapp.UserService/GetUser');
      expect(result!.package).toBe('myapp');
      expect(result!.service).toBe('UserService');
      expect(result!.method).toBe('GetUser');
      expect(result!.fullService).toBe('myapp.UserService');
    });

    it('should parse path without package', () => {
      const result = parseGrpcPath('/UserService/GetUser');

      expect(result).not.toBeNull();
      expect(result!.package).toBe('');
      expect(result!.service).toBe('UserService');
      expect(result!.method).toBe('GetUser');
      expect(result!.fullService).toBe('UserService');
    });

    it('should parse nested package path', () => {
      const result = parseGrpcPath('/com.example.api.v1.UserService/CreateUser');

      expect(result).not.toBeNull();
      expect(result!.package).toBe('com.example.api.v1');
      expect(result!.service).toBe('UserService');
      expect(result!.method).toBe('CreateUser');
    });

    it('should return null for invalid paths', () => {
      expect(parseGrpcPath('invalid')).toBeNull();
      expect(parseGrpcPath('/only-one-part')).toBeNull();
      expect(parseGrpcPath('/too/many/parts')).toBeNull();
      expect(parseGrpcPath('no-leading-slash/Method')).toBeNull();
      expect(parseGrpcPath('/')).toBeNull();
    });
  });

  describe('buildGrpcPath', () => {
    it('should build gRPC path from components', () => {
      const path = buildGrpcPath('myapp.UserService', 'GetUser');
      expect(path).toBe('/myapp.UserService/GetUser');
    });
  });

  describe('parseGrpcFrame', () => {
    it('should parse uncompressed frame', () => {
      const data = Buffer.from('test message');
      const header = Buffer.alloc(5);
      header[0] = 0; // Not compressed
      header.writeUInt32BE(data.length, 1);
      const frame = Buffer.concat([header, data]);

      const result = parseGrpcFrame(frame);

      expect(result).not.toBeNull();
      expect(result!.compressed).toBe(false);
      expect(result!.length).toBe(data.length);
      expect(result!.data.toString()).toBe('test message');
    });

    it('should parse compressed frame', () => {
      const data = Buffer.from('compressed data');
      const header = Buffer.alloc(5);
      header[0] = 1; // Compressed
      header.writeUInt32BE(data.length, 1);
      const frame = Buffer.concat([header, data]);

      const result = parseGrpcFrame(frame);

      expect(result).not.toBeNull();
      expect(result!.compressed).toBe(true);
    });

    it('should return null for incomplete frame', () => {
      // Only 3 bytes, need at least 5 for header
      expect(parseGrpcFrame(Buffer.alloc(3))).toBeNull();

      // Header complete but data incomplete
      const header = Buffer.alloc(5);
      header.writeUInt32BE(100, 1); // Says 100 bytes but none provided
      expect(parseGrpcFrame(header)).toBeNull();
    });
  });

  describe('parseGrpcFrames', () => {
    it('should parse multiple frames', () => {
      const frame1Data = Buffer.from('frame1');
      const frame2Data = Buffer.from('frame2');

      const frame1 = encodeGrpcFrame(frame1Data);
      const frame2 = encodeGrpcFrame(frame2Data);
      const combined = Buffer.concat([frame1, frame2]);

      const result = parseGrpcFrames(combined);

      expect(result.frames).toHaveLength(2);
      expect(result.frames[0].data.toString()).toBe('frame1');
      expect(result.frames[1].data.toString()).toBe('frame2');
      expect(result.remaining.length).toBe(0);
    });

    it('should handle partial frames', () => {
      const frame1 = encodeGrpcFrame(Buffer.from('complete'));
      const partialHeader = Buffer.alloc(3);

      const combined = Buffer.concat([frame1, partialHeader]);
      const result = parseGrpcFrames(combined);

      expect(result.frames).toHaveLength(1);
      expect(result.remaining.length).toBe(3);
    });
  });

  describe('encodeGrpcFrame', () => {
    it('should encode frame correctly', () => {
      const data = Buffer.from('hello');
      const frame = encodeGrpcFrame(data, false);

      expect(frame.length).toBe(GRPC_FRAME_HEADER_SIZE + data.length);
      expect(frame[0]).toBe(0); // Not compressed
      expect(frame.readUInt32BE(1)).toBe(data.length);
      expect(frame.slice(5).toString()).toBe('hello');
    });

    it('should encode compressed frame', () => {
      const data = Buffer.from('hello');
      const frame = encodeGrpcFrame(data, true);

      expect(frame[0]).toBe(1); // Compressed
    });
  });

  describe('parseGrpcTimeout', () => {
    it('should parse hours', () => {
      expect(parseGrpcTimeout('2H')).toBe(2 * 60 * 60 * 1000);
    });

    it('should parse minutes', () => {
      expect(parseGrpcTimeout('30M')).toBe(30 * 60 * 1000);
    });

    it('should parse seconds', () => {
      expect(parseGrpcTimeout('10S')).toBe(10 * 1000);
    });

    it('should parse milliseconds', () => {
      expect(parseGrpcTimeout('500m')).toBe(500);
    });

    it('should parse microseconds', () => {
      expect(parseGrpcTimeout('5000u')).toBe(5);
    });

    it('should parse nanoseconds', () => {
      expect(parseGrpcTimeout('5000000n')).toBe(5);
    });

    it('should return null for invalid formats', () => {
      expect(parseGrpcTimeout('invalid')).toBeNull();
      expect(parseGrpcTimeout('10X')).toBeNull();
      expect(parseGrpcTimeout('abc')).toBeNull();
    });
  });

  describe('encodeGrpcTimeout', () => {
    it('should encode as hours for large values', () => {
      expect(encodeGrpcTimeout(2 * 60 * 60 * 1000)).toBe('2H');
    });

    it('should encode as minutes', () => {
      expect(encodeGrpcTimeout(5 * 60 * 1000)).toBe('5M');
    });

    it('should encode as seconds', () => {
      expect(encodeGrpcTimeout(10 * 1000)).toBe('10S');
    });

    it('should encode as milliseconds for small values', () => {
      expect(encodeGrpcTimeout(500)).toBe('500m');
    });
  });

  describe('parseGrpcMetadata', () => {
    it('should parse standard metadata', () => {
      const headers = {
        'x-custom-header': 'value',
        'another-key': 'another-value',
      };

      const metadata = parseGrpcMetadata(headers);

      expect(metadata.get('x-custom-header')).toBe('value');
      expect(metadata.get('another-key')).toBe('another-value');
    });

    it('should decode binary metadata', () => {
      const value = Buffer.from('binary data').toString('base64');
      const headers = {
        'custom-bin': value,
      };

      const metadata = parseGrpcMetadata(headers);
      expect(metadata.get('custom-bin')).toBe('binary data');
    });

    it('should skip standard headers', () => {
      const headers = {
        'content-type': 'application/grpc',
        ':path': '/Service/Method',
        'x-custom': 'keep',
      };

      const metadata = parseGrpcMetadata(headers);

      expect(metadata.has('content-type')).toBe(false);
      expect(metadata.has(':path')).toBe(false);
      expect(metadata.get('x-custom')).toBe('keep');
    });
  });

  describe('encodeGrpcMetadata', () => {
    it('should encode metadata', () => {
      const metadata = new Map<string, string>();
      metadata.set('x-custom', 'value');

      const headers = encodeGrpcMetadata(metadata);
      expect(headers['x-custom']).toBe('value');
    });

    it('should base64 encode binary metadata', () => {
      const metadata = new Map<string, string>();
      metadata.set('custom-bin', 'binary data');

      const headers = encodeGrpcMetadata(metadata);
      expect(headers['custom-bin']).toBe(Buffer.from('binary data').toString('base64'));
    });
  });

  describe('parseGrpcTrailers', () => {
    it('should parse trailers with status', () => {
      const headers = {
        'grpc-status': '0',
        'grpc-message': 'OK',
      };

      const trailers = parseGrpcTrailers(headers);

      expect(trailers.status).toBe(GrpcStatus.OK);
      expect(trailers.message).toBe('OK');
    });

    it('should decode URL-encoded message', () => {
      const headers = {
        'grpc-status': '3',
        'grpc-message': 'Invalid%20argument',
      };

      const trailers = parseGrpcTrailers(headers);
      expect(trailers.message).toBe('Invalid argument');
    });

    it('should default to OK status', () => {
      const trailers = parseGrpcTrailers({});
      expect(trailers.status).toBe(GrpcStatus.OK);
    });
  });

  describe('encodeGrpcTrailers', () => {
    it('should encode trailers', () => {
      const trailers = encodeGrpcTrailers(GrpcStatus.OK);

      expect(trailers['grpc-status']).toBe('0');
    });

    it('should URL-encode message', () => {
      const trailers = encodeGrpcTrailers(GrpcStatus.INVALID_ARGUMENT, 'Invalid argument');

      expect(trailers['grpc-status']).toBe('3');
      expect(trailers['grpc-message']).toBe('Invalid%20argument');
    });
  });

  describe('content type checks', () => {
    it('should identify gRPC content types', () => {
      expect(isGrpcContentType('application/grpc')).toBe(true);
      expect(isGrpcContentType('application/grpc+proto')).toBe(true);
      expect(isGrpcContentType('application/json')).toBe(false);
      expect(isGrpcContentType(undefined)).toBe(false);
    });

    it('should identify gRPC-Web content types', () => {
      expect(isGrpcWebContentType('application/grpc-web')).toBe(true);
      expect(isGrpcWebContentType('application/grpc-web+proto')).toBe(true);
      expect(isGrpcWebContentType('application/grpc-web-text')).toBe(true);
      expect(isGrpcWebContentType('application/grpc')).toBe(false);
    });

    it('should identify gRPC-Web text content types', () => {
      expect(isGrpcWebTextContentType('application/grpc-web-text')).toBe(true);
      expect(isGrpcWebTextContentType('application/grpc-web-text+proto')).toBe(true);
      expect(isGrpcWebTextContentType('application/grpc-web')).toBe(false);
    });
  });

  describe('validateFrameSize', () => {
    it('should validate frame size', () => {
      expect(validateFrameSize(100)).toBe(true);
      expect(validateFrameSize(4 * 1024 * 1024)).toBe(true); // Default max
      expect(validateFrameSize(5 * 1024 * 1024)).toBe(false); // Over default
      expect(validateFrameSize(-1)).toBe(false);
    });

    it('should use custom max size', () => {
      expect(validateFrameSize(100, 50)).toBe(false);
      expect(validateFrameSize(100, 200)).toBe(true);
    });
  });

  describe('createGrpcError', () => {
    it('should create error trailer object', () => {
      const error = createGrpcError(GrpcStatus.NOT_FOUND, 'Resource not found');

      expect(error.status).toBe(GrpcStatus.NOT_FOUND);
      expect(error.message).toBe('Resource not found');
      expect(error.metadata).toBeInstanceOf(Map);
    });
  });

  describe('GrpcStatus', () => {
    it('should have all status codes', () => {
      expect(GrpcStatus.OK).toBe(0);
      expect(GrpcStatus.CANCELLED).toBe(1);
      expect(GrpcStatus.UNKNOWN).toBe(2);
      expect(GrpcStatus.INVALID_ARGUMENT).toBe(3);
      expect(GrpcStatus.DEADLINE_EXCEEDED).toBe(4);
      expect(GrpcStatus.NOT_FOUND).toBe(5);
      expect(GrpcStatus.PERMISSION_DENIED).toBe(7);
      expect(GrpcStatus.RESOURCE_EXHAUSTED).toBe(8);
      expect(GrpcStatus.UNIMPLEMENTED).toBe(12);
      expect(GrpcStatus.INTERNAL).toBe(13);
      expect(GrpcStatus.UNAVAILABLE).toBe(14);
      expect(GrpcStatus.UNAUTHENTICATED).toBe(16);
    });

    it('should have status names', () => {
      expect(GrpcStatusName[GrpcStatus.OK]).toBe('OK');
      expect(GrpcStatusName[GrpcStatus.NOT_FOUND]).toBe('NOT_FOUND');
      expect(GrpcStatusName[GrpcStatus.INTERNAL]).toBe('INTERNAL');
    });
  });
});
