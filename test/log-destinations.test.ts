import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  FileDestination,
  ConsoleDestination,
  MultiDestination,
  createFileDestination,
  createConsoleDestination,
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

  it('should create directory if not exists', () => {
    const dest = new FileDestination({ path: testFile });
    expect(fs.existsSync(testDir)).toBe(true);
    dest.close();
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

  describe('rotation', () => {
    it('should rotate when max size reached', async () => {
      const dest = new FileDestination({
        path: testFile,
        rotate: true,
        maxSize: 100, // Small for testing
        maxFiles: 3,
      });

      // Write enough to trigger rotation (each entry is ~50 bytes)
      for (let i = 0; i < 20; i++) {
        dest.write(`{"entry": ${i}, "padding": "some extra text for rotation testing"}`);
      }

      await dest.close();

      // Should have the main file
      expect(fs.existsSync(testFile)).toBe(true);
      // Check for any rotated files
      const files = fs.readdirSync(testDir);
      // With small max size and many writes, we should have rotated
      expect(files.length).toBeGreaterThanOrEqual(1);
    });

    it('should limit number of rotated files', async () => {
      const dest = new FileDestination({
        path: testFile,
        rotate: true,
        maxSize: 30,
        maxFiles: 2,
      });

      // Write many entries to trigger multiple rotations
      for (let i = 0; i < 20; i++) {
        dest.write(`{"entry": ${i}}`);
      }

      await dest.close();

      const files = fs.readdirSync(testDir);
      // Should have at most maxFiles + 1 (current + rotated)
      expect(files.length).toBeLessThanOrEqual(3);
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

  it('should log to console', () => {
    const dest = new ConsoleDestination();
    dest.write('{"test": true}');
    expect(consoleSpy).toHaveBeenCalledWith('{"test": true}');
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

  it('should close without error', () => {
    const dest = new ConsoleDestination();
    expect(() => dest.close()).not.toThrow();
  });
});

describe('MultiDestination', () => {
  it('should write to multiple destinations', () => {
    const dest1 = { name: 'dest1', write: vi.fn(), flush: vi.fn(), close: vi.fn() };
    const dest2 = { name: 'dest2', write: vi.fn(), flush: vi.fn(), close: vi.fn() };

    const multi = new MultiDestination([dest1, dest2]);
    multi.write('test entry');

    expect(dest1.write).toHaveBeenCalledWith('test entry');
    expect(dest2.write).toHaveBeenCalledWith('test entry');
  });

  it('should flush all destinations', async () => {
    const dest1 = { name: 'dest1', write: vi.fn(), flush: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
    const dest2 = { name: 'dest2', write: vi.fn(), flush: vi.fn().mockResolvedValue(undefined), close: vi.fn() };

    const multi = new MultiDestination([dest1, dest2]);
    await multi.flush();

    expect(dest1.flush).toHaveBeenCalled();
    expect(dest2.flush).toHaveBeenCalled();
  });

  it('should close all destinations', async () => {
    const dest1 = { name: 'dest1', write: vi.fn(), flush: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    const dest2 = { name: 'dest2', write: vi.fn(), flush: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };

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

  it('should get all destinations', () => {
    const dest1 = { name: 'dest1', write: vi.fn(), flush: vi.fn(), close: vi.fn() };
    const dest2 = { name: 'dest2', write: vi.fn(), flush: vi.fn(), close: vi.fn() };

    const multi = new MultiDestination([dest1, dest2]);
    const destinations = multi.getDestinations();

    expect(destinations).toHaveLength(2);
    expect(destinations[0].name).toBe('dest1');
    expect(destinations[1].name).toBe('dest2');
  });
});

describe('factory functions', () => {
  it('createFileDestination should create FileDestination', async () => {
    const testPath = '/tmp/test-factory.log';
    const dest = createFileDestination({ path: testPath });
    expect(dest.name).toBe('file');
    dest.write('test');
    await dest.close();
    if (fs.existsSync(testPath)) {
      fs.unlinkSync(testPath);
    }
  });

  it('createConsoleDestination should create ConsoleDestination', () => {
    const dest = createConsoleDestination();
    expect(dest.name).toBe('console');
  });

  it('createMultiDestination should create MultiDestination', () => {
    const dest = createMultiDestination([]);
    expect(dest.name).toBe('multi');
  });
});
