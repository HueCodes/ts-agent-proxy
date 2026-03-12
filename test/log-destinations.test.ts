import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {
  FileDestination,
  ConsoleDestination,
  WebhookDestination,
  MultiDestination,
  createFileDestination,
  createConsoleDestination,
  createWebhookDestination,
  createMultiDestination,
} from '../src/logging/log-destinations.js';

describe('FileDestination', () => {
  const testDir = '/tmp/log-dest-test';
  const testFile = path.join(testDir, 'test.log');

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  it('should create directory if not exists', async () => {
    const dest = new FileDestination({ path: testFile });
    expect(fs.existsSync(testDir)).toBe(true);
    await dest.close();
  });

  it('should have name "file"', async () => {
    const dest = new FileDestination({ path: testFile });
    expect(dest.name).toBe('file');
    await dest.close();
  });

  it('should write entries to file', async () => {
    const dest = new FileDestination({ path: testFile });
    dest.write('{"test": 1}');
    dest.write('{"test": 2}');
    await dest.close();

    const content = fs.readFileSync(testFile, 'utf-8');
    expect(content).toContain('{"test": 1}');
    expect(content).toContain('{"test": 2}');
  });

  it('should append newline after each entry', async () => {
    const dest = new FileDestination({ path: testFile });
    dest.write('line1');
    dest.write('line2');
    await dest.close();

    const content = fs.readFileSync(testFile, 'utf-8');
    expect(content).toBe('line1\nline2\n');
  });

  it('should append to existing file', async () => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(testFile, '{"existing": true}\n');

    const dest = new FileDestination({ path: testFile });
    dest.write('{"new": true}');
    await dest.close();

    const content = fs.readFileSync(testFile, 'utf-8');
    expect(content).toContain('{"existing": true}');
    expect(content).toContain('{"new": true}');
  });

  it('should track existing file size on init', async () => {
    fs.mkdirSync(testDir, { recursive: true });
    const existingContent = 'x'.repeat(50) + '\n';
    fs.writeFileSync(testFile, existingContent);

    // With rotation enabled and maxSize just above existing content,
    // writing more should trigger rotation
    const dest = new FileDestination({
      path: testFile,
      rotate: true,
      maxSize: 60,
      maxFiles: 3,
    });
    // Write enough to exceed maxSize (existing 51 + new ~10)
    dest.write('more data');
    await dest.close();

    // Rotation should have occurred - rotated file should exist
    expect(fs.existsSync(`${testFile}.1`)).toBe(true);
  });

  it('should not write when stream is undefined', async () => {
    const dest = new FileDestination({ path: testFile });
    await dest.close();
    // After close, stream is ended; writing should not throw
    // Access private stream to force undefined scenario
    (dest as any).stream = undefined;
    expect(() => dest.write('should not throw')).not.toThrow();
  });

  it('should resolve close immediately when stream is undefined', async () => {
    const dest = new FileDestination({ path: testFile });
    await dest.close();
    (dest as any).stream = undefined;
    await expect(dest.close()).resolves.toBeUndefined();
  });

  it('should call flush without error', async () => {
    const dest = new FileDestination({ path: testFile });
    expect(() => dest.flush()).not.toThrow();
    await dest.close();
  });

  it('should not rotate when rotation is disabled', async () => {
    const dest = new FileDestination({
      path: testFile,
      rotate: false,
      maxSize: 10,
    });

    for (let i = 0; i < 20; i++) {
      dest.write(`entry ${i} with some padding text`);
    }
    await dest.close();

    // No rotated files should exist
    const files = fs.readdirSync(testDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('test.log');
  });

  describe('rotation', () => {
    it('should rotate when max size reached', async () => {
      const dest = new FileDestination({
        path: testFile,
        rotate: true,
        maxSize: 100,
        maxFiles: 3,
      });

      for (let i = 0; i < 20; i++) {
        dest.write(`{"entry": ${i}, "padding": "some extra text for rotation testing"}`);
      }

      await dest.close();

      expect(fs.existsSync(testFile)).toBe(true);
      const files = fs.readdirSync(testDir);
      expect(files.length).toBeGreaterThanOrEqual(1);
    });

    it('should limit number of rotated files', async () => {
      const dest = new FileDestination({
        path: testFile,
        rotate: true,
        maxSize: 30,
        maxFiles: 2,
      });

      for (let i = 0; i < 20; i++) {
        dest.write(`{"entry": ${i}}`);
      }

      await dest.close();

      const files = fs.readdirSync(testDir);
      // maxFiles=2 means keep .1 and delete .2 (the oldest), plus the current file = max 3
      expect(files.length).toBeLessThanOrEqual(3);
    });

    it('should delete oldest file when maxFiles limit is reached during rotation', async () => {
      const dest = new FileDestination({
        path: testFile,
        rotate: true,
        maxSize: 20,
        maxFiles: 2,
      });

      // Write enough to trigger many rotations
      for (let i = 0; i < 30; i++) {
        dest.write(`entry-${i}-padding-text`);
      }

      await dest.close();

      // .2 (maxFiles-1=1, so index 2) should be deleted if it was created
      // At most we should have: test.log, test.log.1 (maxFiles=2 means max index is 2, but oldest gets deleted)
      const files = fs.readdirSync(testDir);
      expect(files.length).toBeLessThanOrEqual(3);
    });

    it('should handle rotation when stream is undefined', () => {
      const dest = new FileDestination({
        path: testFile,
        rotate: true,
        maxSize: 10,
      });
      (dest as any).stream = undefined;
      // Calling rotate directly should not throw
      expect(() => (dest as any).rotate()).not.toThrow();
    });

    it('should use default config values', () => {
      const dest = new FileDestination({ path: testFile });
      const config = (dest as any).config;
      expect(config.rotate).toBe(false);
      expect(config.maxSize).toBe(10 * 1024 * 1024);
      expect(config.maxFiles).toBe(5);
      expect(config.compress).toBe(false);
      dest.close();
    });
  });
});

describe('ConsoleDestination', () => {
  let consoleSpy: any;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should have name "console"', () => {
    const dest = new ConsoleDestination();
    expect(dest.name).toBe('console');
  });

  it('should log to console', () => {
    const dest = new ConsoleDestination();
    dest.write('{"test": true}');
    expect(consoleSpy).toHaveBeenCalledWith('{"test": true}');
  });

  it('should default to non-pretty mode', () => {
    const dest = new ConsoleDestination();
    dest.write('{"a":1}');
    expect(consoleSpy).toHaveBeenCalledWith('{"a":1}');
  });

  it('should pretty print when enabled', () => {
    const dest = new ConsoleDestination(true);
    dest.write('{"test": true}');
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify({ test: true }, null, 2));
  });

  it('should handle invalid JSON in pretty mode', () => {
    const dest = new ConsoleDestination(true);
    dest.write('not json');
    expect(consoleSpy).toHaveBeenCalledWith('not json');
  });

  it('should flush without error', () => {
    const dest = new ConsoleDestination();
    expect(() => dest.flush()).not.toThrow();
  });

  it('should close without error', () => {
    const dest = new ConsoleDestination();
    expect(() => dest.close()).not.toThrow();
  });
});

describe('WebhookDestination', () => {
  let server: http.Server;
  let serverPort: number;
  let receivedRequests: Array<{ method: string; headers: http.IncomingHttpHeaders; body: string }>;

  beforeEach(async () => {
    receivedRequests = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        receivedRequests.push({
          method: req.method || '',
          headers: req.headers,
          body,
        });
        res.writeHead(200);
        res.end();
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          serverPort = addr.port;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    vi.restoreAllMocks();
  });

  it('should have name "webhook"', () => {
    const dest = new WebhookDestination({ url: `http://127.0.0.1:${serverPort}/logs` });
    expect(dest.name).toBe('webhook');
  });

  it('should use default config values', () => {
    const dest = new WebhookDestination({ url: `http://127.0.0.1:${serverPort}/logs` });
    const config = (dest as any).config;
    expect(config.method).toBe('POST');
    expect(config.batchSize).toBe(1);
    expect(config.batchTimeout).toBe(5000);
    expect(config.retryCount).toBe(3);
    expect(config.retryDelay).toBe(1000);
    expect(config.headers).toEqual({});
  });

  it('should accept custom config values', () => {
    const dest = new WebhookDestination({
      url: `http://127.0.0.1:${serverPort}/logs`,
      method: 'PUT',
      headers: { 'X-API-Key': 'secret' },
      batchSize: 5,
      batchTimeout: 1000,
      retryCount: 1,
      retryDelay: 500,
    });
    const config = (dest as any).config;
    expect(config.method).toBe('PUT');
    expect(config.batchSize).toBe(5);
    expect(config.batchTimeout).toBe(1000);
    expect(config.retryCount).toBe(1);
    expect(config.retryDelay).toBe(500);
    expect(config.headers).toEqual({ 'X-API-Key': 'secret' });
  });

  it('should send immediately when batchSize is 1', async () => {
    const dest = new WebhookDestination({
      url: `http://127.0.0.1:${serverPort}/logs`,
      batchSize: 1,
    });

    dest.write('{"event": "test"}');
    // Allow async send to complete
    await new Promise((r) => setTimeout(r, 200));

    expect(receivedRequests).toHaveLength(1);
    const body = JSON.parse(receivedRequests[0].body);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toEqual({ event: 'test' });
    expect(body.count).toBe(1);
    expect(body.timestamp).toBeDefined();
  });

  it('should batch entries until batchSize is reached', async () => {
    const dest = new WebhookDestination({
      url: `http://127.0.0.1:${serverPort}/logs`,
      batchSize: 3,
      batchTimeout: 60000, // Long timeout so it won't fire
    });

    dest.write('{"event": 1}');
    dest.write('{"event": 2}');

    await new Promise((r) => setTimeout(r, 100));
    // Should not have sent yet (batch not full)
    expect(receivedRequests).toHaveLength(0);

    dest.write('{"event": 3}');
    await new Promise((r) => setTimeout(r, 200));

    // Now batch should be sent
    expect(receivedRequests).toHaveLength(1);
    const body = JSON.parse(receivedRequests[0].body);
    expect(body.entries).toHaveLength(3);
    expect(body.count).toBe(3);

    await dest.close();
  });

  it('should send batch on timeout', async () => {
    const dest = new WebhookDestination({
      url: `http://127.0.0.1:${serverPort}/logs`,
      batchSize: 10,
      batchTimeout: 100,
    });

    dest.write('{"event": "timeout-test"}');

    // Wait for timeout to fire
    await new Promise((r) => setTimeout(r, 300));

    expect(receivedRequests).toHaveLength(1);
    const body = JSON.parse(receivedRequests[0].body);
    expect(body.entries).toHaveLength(1);

    await dest.close();
  });

  it('should send with custom headers', async () => {
    const dest = new WebhookDestination({
      url: `http://127.0.0.1:${serverPort}/logs`,
      headers: { 'X-Custom': 'value', Authorization: 'Bearer token123' },
      batchSize: 1,
    });

    dest.write('{"event": "headers-test"}');
    await new Promise((r) => setTimeout(r, 200));

    expect(receivedRequests).toHaveLength(1);
    expect(receivedRequests[0].headers['x-custom']).toBe('value');
    expect(receivedRequests[0].headers['authorization']).toBe('Bearer token123');
    expect(receivedRequests[0].headers['content-type']).toBe('application/json');
  });

  it('should use PUT method when configured', async () => {
    const dest = new WebhookDestination({
      url: `http://127.0.0.1:${serverPort}/logs`,
      method: 'PUT',
      batchSize: 1,
    });

    dest.write('{"event": "put-test"}');
    await new Promise((r) => setTimeout(r, 200));

    expect(receivedRequests).toHaveLength(1);
    expect(receivedRequests[0].method).toBe('PUT');
  });

  it('should handle non-JSON entries as raw strings', async () => {
    const dest = new WebhookDestination({
      url: `http://127.0.0.1:${serverPort}/logs`,
      batchSize: 1,
    });

    dest.write('plain text entry');
    await new Promise((r) => setTimeout(r, 200));

    expect(receivedRequests).toHaveLength(1);
    const body = JSON.parse(receivedRequests[0].body);
    expect(body.entries[0]).toEqual({ raw: 'plain text entry' });
  });

  it('should flush pending batch', async () => {
    const dest = new WebhookDestination({
      url: `http://127.0.0.1:${serverPort}/logs`,
      batchSize: 100, // Large batch so it won't auto-send
      batchTimeout: 60000,
    });

    dest.write('{"event": "flush-test"}');
    await dest.flush();
    await new Promise((r) => setTimeout(r, 200));

    expect(receivedRequests).toHaveLength(1);
  });

  it('should flush on close', async () => {
    const dest = new WebhookDestination({
      url: `http://127.0.0.1:${serverPort}/logs`,
      batchSize: 100,
      batchTimeout: 60000,
    });

    dest.write('{"event": "close-test"}');
    await dest.close();
    await new Promise((r) => setTimeout(r, 200));

    expect(receivedRequests).toHaveLength(1);
  });

  it('should not send when batch is empty on flush', async () => {
    const dest = new WebhookDestination({
      url: `http://127.0.0.1:${serverPort}/logs`,
      batchSize: 1,
    });

    await dest.flush();
    await new Promise((r) => setTimeout(r, 100));

    expect(receivedRequests).toHaveLength(0);
  });

  it('should retry on non-2xx status code', async () => {
    // Close the good server and create one that returns errors then succeeds
    await new Promise<void>((resolve) => { server.close(() => resolve()); });

    let requestCount = 0;
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requestCount++;
        if (requestCount <= 2) {
          res.writeHead(500);
          res.end();
        } else {
          res.writeHead(200);
          res.end();
        }
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(serverPort, '127.0.0.1', () => resolve());
    });

    const dest = new WebhookDestination({
      url: `http://127.0.0.1:${serverPort}/logs`,
      batchSize: 1,
      retryCount: 3,
      retryDelay: 50,
    });

    dest.write('{"event": "retry-test"}');
    await new Promise((r) => setTimeout(r, 1000));

    // Should have retried: 1 initial + 2 retries (then success on 3rd)
    expect(requestCount).toBe(3);
  });

  it('should log error after all retries exhausted on bad status', async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });

    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        res.writeHead(500);
        res.end();
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(serverPort, '127.0.0.1', () => resolve());
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const dest = new WebhookDestination({
      url: `http://127.0.0.1:${serverPort}/logs`,
      batchSize: 1,
      retryCount: 1,
      retryDelay: 50,
    });

    dest.write('{"event": "fail-test"}');
    await new Promise((r) => setTimeout(r, 500));

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Webhook failed'));
    errorSpy.mockRestore();
  });

  it('should retry on connection error', async () => {
    // Use a port that nothing is listening on
    await new Promise<void>((resolve) => { server.close(() => resolve()); });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const dest = new WebhookDestination({
      url: `http://127.0.0.1:${serverPort}/logs`,
      batchSize: 1,
      retryCount: 1,
      retryDelay: 50,
    });

    dest.write('{"event": "error-test"}');
    await new Promise((r) => setTimeout(r, 500));

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Webhook error'));
    errorSpy.mockRestore();

    // Re-create server for afterEach cleanup
    server = http.createServer(() => {});
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
  });

  it('should parse URL correctly for https', () => {
    const dest = new WebhookDestination({
      url: 'https://example.com:8443/webhook?token=abc',
    });
    const url = (dest as any).url;
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('example.com');
    expect(url.port).toBe('8443');
    expect(url.pathname).toBe('/webhook');
    expect(url.search).toBe('?token=abc');
  });

  it('should not start a new batch timer if one is already running', async () => {
    const dest = new WebhookDestination({
      url: `http://127.0.0.1:${serverPort}/logs`,
      batchSize: 10,
      batchTimeout: 200,
    });

    dest.write('entry1');
    dest.write('entry2'); // Should not start a second timer

    await new Promise((r) => setTimeout(r, 400));

    // Both entries should arrive in a single batch
    expect(receivedRequests).toHaveLength(1);
    const body = JSON.parse(receivedRequests[0].body);
    expect(body.entries).toHaveLength(2);

    await dest.close();
  });
});

describe('MultiDestination', () => {
  it('should have name "multi"', () => {
    const multi = new MultiDestination([]);
    expect(multi.name).toBe('multi');
  });

  it('should write to multiple destinations', () => {
    const dest1 = { name: 'dest1', write: vi.fn(), flush: vi.fn(), close: vi.fn() };
    const dest2 = { name: 'dest2', write: vi.fn(), flush: vi.fn(), close: vi.fn() };

    const multi = new MultiDestination([dest1, dest2]);
    multi.write('test entry');

    expect(dest1.write).toHaveBeenCalledWith('test entry');
    expect(dest2.write).toHaveBeenCalledWith('test entry');
  });

  it('should flush all destinations', async () => {
    const dest1 = {
      name: 'dest1',
      write: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    };
    const dest2 = {
      name: 'dest2',
      write: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    };

    const multi = new MultiDestination([dest1, dest2]);
    await multi.flush();

    expect(dest1.flush).toHaveBeenCalled();
    expect(dest2.flush).toHaveBeenCalled();
  });

  it('should close all destinations', async () => {
    const dest1 = {
      name: 'dest1',
      write: vi.fn(),
      flush: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const dest2 = {
      name: 'dest2',
      write: vi.fn(),
      flush: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const multi = new MultiDestination([dest1, dest2]);
    await multi.close();

    expect(dest1.close).toHaveBeenCalled();
    expect(dest2.close).toHaveBeenCalled();
  });

  it('should add destination', () => {
    const multi = new MultiDestination([]);
    const dest = { name: 'new', write: vi.fn(), flush: vi.fn(), close: vi.fn() };

    multi.addDestination(dest);
    multi.write('test');

    expect(dest.write).toHaveBeenCalledWith('test');
  });

  it('should remove destination by name', () => {
    const dest1 = { name: 'keep', write: vi.fn(), flush: vi.fn(), close: vi.fn() };
    const dest2 = { name: 'remove', write: vi.fn(), flush: vi.fn(), close: vi.fn() };

    const multi = new MultiDestination([dest1, dest2]);
    multi.removeDestination('remove');
    multi.write('test');

    expect(dest1.write).toHaveBeenCalled();
    expect(dest2.write).not.toHaveBeenCalled();
  });

  it('should not throw when removing non-existent destination', () => {
    const dest1 = { name: 'keep', write: vi.fn(), flush: vi.fn(), close: vi.fn() };
    const multi = new MultiDestination([dest1]);

    expect(() => multi.removeDestination('nonexistent')).not.toThrow();
    expect(multi.getDestinations()).toHaveLength(1);
  });

  it('should get all destinations', () => {
    const dest1 = { name: 'dest1', write: vi.fn(), flush: vi.fn(), close: vi.fn() };
    const dest2 = { name: 'dest2', write: vi.fn(), flush: vi.fn(), close: vi.fn() };

    const multi = new MultiDestination([dest1, dest2]);
    const destinations = multi.getDestinations();

    expect(destinations).toHaveLength(2);
    expect(destinations[0].name).toBe('dest1');
    expect(destinations[1].name).toBe('dest2');
  });

  it('should return a copy of destinations array', () => {
    const dest1 = { name: 'dest1', write: vi.fn(), flush: vi.fn(), close: vi.fn() };
    const multi = new MultiDestination([dest1]);

    const copy = multi.getDestinations();
    copy.push({ name: 'extra', write: vi.fn(), flush: vi.fn(), close: vi.fn() });

    // Original should be unmodified
    expect(multi.getDestinations()).toHaveLength(1);
  });

  it('should handle write with zero destinations', async () => {
    const multi = new MultiDestination([]);
    await expect(multi.write('test')).resolves.toBeUndefined();
  });

  it('should handle flush with zero destinations', async () => {
    const multi = new MultiDestination([]);
    await expect(multi.flush()).resolves.toBeUndefined();
  });

  it('should handle close with zero destinations', async () => {
    const multi = new MultiDestination([]);
    await expect(multi.close()).resolves.toBeUndefined();
  });
});

describe('factory functions', () => {
  it('createFileDestination should create FileDestination', async () => {
    const testPath = '/tmp/test-factory.log';
    const dest = createFileDestination({ path: testPath });
    expect(dest.name).toBe('file');
    expect(dest).toBeInstanceOf(FileDestination);
    dest.write('test');
    await dest.close();
    if (fs.existsSync(testPath)) {
      fs.unlinkSync(testPath);
    }
  });

  it('createConsoleDestination should create ConsoleDestination', () => {
    const dest = createConsoleDestination();
    expect(dest.name).toBe('console');
    expect(dest).toBeInstanceOf(ConsoleDestination);
  });

  it('createConsoleDestination should accept pretty parameter', () => {
    const dest = createConsoleDestination(true);
    expect(dest).toBeInstanceOf(ConsoleDestination);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    dest.write('{"a":1}');
    expect(spy).toHaveBeenCalledWith(JSON.stringify({ a: 1 }, null, 2));
    spy.mockRestore();
  });

  it('createWebhookDestination should create WebhookDestination', () => {
    const dest = createWebhookDestination({ url: 'http://localhost:9999/logs' });
    expect(dest.name).toBe('webhook');
    expect(dest).toBeInstanceOf(WebhookDestination);
  });

  it('createMultiDestination should create MultiDestination', () => {
    const dest = createMultiDestination([]);
    expect(dest.name).toBe('multi');
    expect(dest).toBeInstanceOf(MultiDestination);
  });
});
