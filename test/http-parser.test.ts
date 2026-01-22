/**
 * Tests for the HTTP request parser module.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  HttpRequestParser,
  HttpParseError,
  parseHttpRequest,
  serializeHttpRequest,
} from '../src/proxy/http-parser.js';

describe('HttpRequestParser', () => {
  let parser: HttpRequestParser;

  beforeEach(() => {
    parser = new HttpRequestParser({
      maxHeaderSize: 16 * 1024,
      maxBodySize: 1024 * 1024,
    });
  });

  describe('basic request parsing', () => {
    it('should parse a simple GET request', () => {
      const request = 'GET /path HTTP/1.1\r\nHost: example.com\r\n\r\n';
      parser.write(Buffer.from(request));

      expect(parser.isComplete()).toBe(true);

      const parsed = parser.getRequest();
      expect(parsed).not.toBeNull();
      expect(parsed!.method).toBe('GET');
      expect(parsed!.path).toBe('/path');
      expect(parsed!.httpVersion).toBe('HTTP/1.1');
      expect(parsed!.headers['host']).toBe('example.com');
    });

    it('should parse a POST request with body', () => {
      const body = '{"name": "test"}';
      const request = `POST /api HTTP/1.1\r\nHost: example.com\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
      parser.write(Buffer.from(request));

      expect(parser.isComplete()).toBe(true);

      const parsed = parser.getRequest();
      expect(parsed!.method).toBe('POST');
      expect(parsed!.body.toString()).toBe(body);
    });

    it('should parse request with multiple headers', () => {
      const request =
        'GET / HTTP/1.1\r\n' +
        'Host: example.com\r\n' +
        'Accept: application/json\r\n' +
        'Authorization: Bearer token123\r\n' +
        '\r\n';
      parser.write(Buffer.from(request));

      const parsed = parser.getRequest();
      expect(parsed!.headers['host']).toBe('example.com');
      expect(parsed!.headers['accept']).toBe('application/json');
      expect(parsed!.headers['authorization']).toBe('Bearer token123');
    });

    it('should handle all HTTP methods', () => {
      const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

      for (const method of methods) {
        const p = new HttpRequestParser();
        p.write(Buffer.from(`${method} / HTTP/1.1\r\nHost: test\r\n\r\n`));
        expect(p.isComplete()).toBe(true);
        expect(p.getRequest()!.method).toBe(method);
      }
    });
  });

  describe('chunked transfer encoding', () => {
    it('should parse chunked request body', () => {
      const request =
        'POST /upload HTTP/1.1\r\n' +
        'Host: example.com\r\n' +
        'Transfer-Encoding: chunked\r\n' +
        '\r\n' +
        '5\r\nHello\r\n' +
        '6\r\n World\r\n' +
        '0\r\n' +
        '\r\n';

      parser.write(Buffer.from(request));

      expect(parser.isComplete()).toBe(true);
      const parsed = parser.getRequest();
      expect(parsed!.body.toString()).toBe('Hello World');
    });

    it('should handle empty chunked body', () => {
      const request =
        'POST /upload HTTP/1.1\r\n' +
        'Host: example.com\r\n' +
        'Transfer-Encoding: chunked\r\n' +
        '\r\n' +
        '0\r\n' +
        '\r\n';

      parser.write(Buffer.from(request));

      expect(parser.isComplete()).toBe(true);
      expect(parser.getRequest()!.body.length).toBe(0);
    });

    it('should handle chunk extensions', () => {
      const request =
        'POST /upload HTTP/1.1\r\n' +
        'Host: example.com\r\n' +
        'Transfer-Encoding: chunked\r\n' +
        '\r\n' +
        '5;ext=value\r\nHello\r\n' +
        '0\r\n' +
        '\r\n';

      parser.write(Buffer.from(request));

      expect(parser.isComplete()).toBe(true);
      expect(parser.getRequest()!.body.toString()).toBe('Hello');
    });
  });

  describe('streaming/incremental parsing', () => {
    it('should handle data arriving in chunks', () => {
      const parts = [
        'GET /path',
        ' HTTP/1.1\r\n',
        'Host: example.com',
        '\r\n\r\n',
      ];

      for (const part of parts) {
        parser.write(Buffer.from(part));
      }

      expect(parser.isComplete()).toBe(true);
      expect(parser.getRequest()!.method).toBe('GET');
    });

    it('should handle body arriving in chunks', () => {
      const body = 'This is a test body';
      parser.write(
        Buffer.from(`POST / HTTP/1.1\r\nContent-Length: ${body.length}\r\n\r\n`)
      );
      expect(parser.isComplete()).toBe(false);

      parser.write(Buffer.from('This is '));
      expect(parser.isComplete()).toBe(false);

      parser.write(Buffer.from('a test body'));
      expect(parser.isComplete()).toBe(true);
      expect(parser.getRequest()!.body.toString()).toBe(body);
    });
  });

  describe('error handling', () => {
    it('should throw on invalid method', () => {
      const request = 'INVALID / HTTP/1.1\r\nHost: test\r\n\r\n';

      expect(() => parser.write(Buffer.from(request))).toThrow(HttpParseError);
      expect(parser.hasError()).toBe(true);
    });

    it('should throw on malformed request line', () => {
      const request = 'GET\r\nHost: test\r\n\r\n';

      expect(() => parser.write(Buffer.from(request))).toThrow(HttpParseError);
    });

    it('should throw on invalid HTTP version', () => {
      const request = 'GET / INVALID\r\nHost: test\r\n\r\n';

      expect(() => parser.write(Buffer.from(request))).toThrow(HttpParseError);
    });

    it('should throw on header too large', () => {
      const smallParser = new HttpRequestParser({ maxHeaderSize: 100 });
      const longHeader = 'X-Long-Header: ' + 'a'.repeat(200);
      const request = `GET / HTTP/1.1\r\n${longHeader}\r\n\r\n`;

      expect(() => smallParser.write(Buffer.from(request))).toThrow(HttpParseError);
    });

    it('should throw on body too large (Content-Length)', () => {
      const smallParser = new HttpRequestParser({ maxBodySize: 100 });
      const request = 'POST / HTTP/1.1\r\nContent-Length: 200\r\n\r\n';

      expect(() => smallParser.write(Buffer.from(request))).toThrow(HttpParseError);
    });

    it('should throw on body too large (chunked)', () => {
      const smallParser = new HttpRequestParser({ maxBodySize: 10 });
      const request =
        'POST / HTTP/1.1\r\n' +
        'Transfer-Encoding: chunked\r\n' +
        '\r\n' +
        '20\r\n' + // 32 bytes
        'a'.repeat(32) + '\r\n';

      expect(() => smallParser.write(Buffer.from(request))).toThrow(HttpParseError);
    });
  });

  describe('reset', () => {
    it('should allow parsing new request after reset', () => {
      parser.write(Buffer.from('GET /first HTTP/1.1\r\nHost: test\r\n\r\n'));
      expect(parser.getRequest()!.path).toBe('/first');

      parser.reset();

      parser.write(Buffer.from('GET /second HTTP/1.1\r\nHost: test\r\n\r\n'));
      expect(parser.getRequest()!.path).toBe('/second');
    });
  });
});

describe('parseHttpRequest', () => {
  it('should parse complete request', () => {
    const data = Buffer.from('GET /path HTTP/1.1\r\nHost: example.com\r\n\r\n');
    const result = parseHttpRequest(data);

    expect(result).not.toBeNull();
    expect(result!.method).toBe('GET');
    expect(result!.path).toBe('/path');
  });

  it('should return null for incomplete request', () => {
    const data = Buffer.from('GET /path HTTP/1.1\r\n');
    const result = parseHttpRequest(data);

    expect(result).toBeNull();
  });
});

describe('serializeHttpRequest', () => {
  it('should serialize request back to HTTP format', () => {
    const original = 'GET /path HTTP/1.1\r\nHost: example.com\r\n\r\n';
    const parsed = parseHttpRequest(Buffer.from(original))!;
    const serialized = serializeHttpRequest(parsed);

    expect(serialized.toString()).toContain('GET /path HTTP/1.1');
    expect(serialized.toString()).toContain('Host: example.com');
  });

  it('should include body in serialized output', () => {
    const body = 'test body';
    const original = `POST /api HTTP/1.1\r\nHost: example.com\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
    const parsed = parseHttpRequest(Buffer.from(original))!;
    const serialized = serializeHttpRequest(parsed);

    expect(serialized.toString()).toContain(body);
  });
});
