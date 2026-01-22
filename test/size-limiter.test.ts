/**
 * Tests for the size limiter module.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  LimitingStream,
  SizeLimitExceededError,
  TimeoutError,
  checkContentLength,
  checkHeadersSize,
  checkUrlLength,
  withTimeout,
  createTimeout,
} from '../src/proxy/size-limiter.js';
import type { IncomingMessage } from 'node:http';

// Mock request
function createMockRequest(options: {
  url?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  rawHeaders?: string[];
}): IncomingMessage {
  return {
    url: options.url ?? '/path',
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
    rawHeaders: options.rawHeaders ?? ['Host', 'example.com'],
  } as any;
}

describe('LimitingStream', () => {
  describe('basic functionality', () => {
    it('should pass data through when under limit', async () => {
      const stream = new LimitingStream(1024);
      const chunks: Buffer[] = [];

      const promise = new Promise<void>((resolve) => {
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => {
          expect(Buffer.concat(chunks).toString()).toBe('Hello World');
          resolve();
        });
      });

      stream.write(Buffer.from('Hello '));
      stream.write(Buffer.from('World'));
      stream.end();

      await promise;
    });

    it('should emit error when limit exceeded', async () => {
      const stream = new LimitingStream(10);

      const promise = new Promise<void>((resolve) => {
        stream.on('error', (error) => {
          expect(error).toBeInstanceOf(SizeLimitExceededError);
          expect((error as SizeLimitExceededError).limit).toBe(10);
          expect((error as SizeLimitExceededError).type).toBe('request');
          resolve();
        });
      });

      stream.write(Buffer.from('This is more than 10 bytes'));
      await promise;
    });

    it('should track bytes received', () => {
      const stream = new LimitingStream(1024);
      stream.write(Buffer.from('Hello'));
      expect(stream.getBytesReceived()).toBe(5);
    });

    it('should handle response type', async () => {
      const stream = new LimitingStream(10, 'response');

      const promise = new Promise<void>((resolve) => {
        stream.on('error', (error) => {
          expect((error as SizeLimitExceededError).type).toBe('response');
          resolve();
        });
      });

      stream.write(Buffer.from('This exceeds the limit'));
      await promise;
    });
  });
});

describe('SizeLimitExceededError', () => {
  it('should contain limit details', () => {
    const error = new SizeLimitExceededError('request', 1024, 2048);

    expect(error.name).toBe('SizeLimitExceededError');
    expect(error.code).toBe('SIZE_LIMIT_EXCEEDED');
    expect(error.limit).toBe(1024);
    expect(error.received).toBe(2048);
    expect(error.type).toBe('request');
    expect(error.message).toContain('1024');
    expect(error.message).toContain('2048');
  });
});

describe('TimeoutError', () => {
  it('should contain timeout details', () => {
    const error = new TimeoutError('Operation timed out', 5000);

    expect(error.name).toBe('TimeoutError');
    expect(error.code).toBe('TIMEOUT');
    expect(error.timeout).toBe(5000);
  });
});

describe('checkContentLength', () => {
  it('should pass when Content-Length is under limit', () => {
    const req = createMockRequest({
      headers: { 'content-length': '500' },
    });
    const result = checkContentLength(req, 1024);

    expect(result.valid).toBe(true);
  });

  it('should fail when Content-Length exceeds limit', () => {
    const req = createMockRequest({
      headers: { 'content-length': '2048' },
    });
    const result = checkContentLength(req, 1024);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.size).toBe(2048);
    }
  });

  it('should pass when no Content-Length header', () => {
    const req = createMockRequest({ headers: {} });
    const result = checkContentLength(req, 1024);

    expect(result.valid).toBe(true);
  });

  it('should handle exact limit', () => {
    const req = createMockRequest({
      headers: { 'content-length': '1024' },
    });
    const result = checkContentLength(req, 1024);

    expect(result.valid).toBe(true);
  });
});

describe('checkHeadersSize', () => {
  it('should pass when headers are under limit', () => {
    const req = createMockRequest({
      method: 'GET',
      url: '/path',
      rawHeaders: ['Host', 'example.com'],
    });
    const result = checkHeadersSize(req, 16 * 1024);

    expect(result.valid).toBe(true);
  });

  it('should fail when headers exceed limit', () => {
    const longValue = 'x'.repeat(1000);
    const req = createMockRequest({
      rawHeaders: ['X-Long-Header', longValue],
    });
    const result = checkHeadersSize(req, 100);

    expect(result.valid).toBe(false);
  });

  it('should include size in result', () => {
    const req = createMockRequest({
      rawHeaders: ['Host', 'example.com'],
    });
    const result = checkHeadersSize(req, 16 * 1024);

    expect(result.size).toBeGreaterThan(0);
  });
});

describe('checkUrlLength', () => {
  it('should pass when URL is under limit', () => {
    const result = checkUrlLength('/path', 8192);
    expect(result.valid).toBe(true);
  });

  it('should fail when URL exceeds limit', () => {
    const longUrl = '/path?' + 'a'.repeat(10000);
    const result = checkUrlLength(longUrl, 8192);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.length).toBeGreaterThan(8192);
    }
  });

  it('should handle undefined URL', () => {
    const result = checkUrlLength(undefined, 8192);
    expect(result.valid).toBe(true);
  });
});

describe('withTimeout', () => {
  it('should resolve when promise completes before timeout', async () => {
    const promise = Promise.resolve('success');
    const result = await withTimeout(promise, 1000);

    expect(result).toBe('success');
  });

  it('should reject when timeout expires', async () => {
    const promise = new Promise((resolve) => setTimeout(resolve, 1000));

    await expect(withTimeout(promise, 10, 'Custom timeout')).rejects.toThrow(
      TimeoutError
    );
  });

  it('should reject with correct timeout value', async () => {
    const promise = new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      await withTimeout(promise, 50);
    } catch (error) {
      expect((error as TimeoutError).timeout).toBe(50);
    }
  });
});

describe('createTimeout', () => {
  it('should create a timeout that can be cleared', async () => {
    const { promise, clear } = createTimeout<string>(1000);

    clear();

    // Promise should not reject after being cleared
    // We need to race against a resolved promise to verify
    const result = await Promise.race([
      promise.catch(() => 'timeout'),
      new Promise<string>((resolve) => setTimeout(() => resolve('not-timeout'), 50)),
    ]);

    expect(result).toBe('not-timeout');
  });

  it('should reject after timeout', async () => {
    const { promise } = createTimeout(10, 'Test timeout');

    await expect(promise).rejects.toThrow('Test timeout');
  });
});
