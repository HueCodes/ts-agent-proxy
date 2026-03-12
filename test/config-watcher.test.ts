import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { ConfigWatcher, createConfigWatcher, watchConfig } from '../src/config/watcher.js';
import { parseAllowlistConfigJson } from '../src/validation/validator.js';

// Mock fs module
vi.mock('node:fs', () => {
  const actual = vi.importActual('node:fs');
  return {
    ...actual,
    default: {
      existsSync: vi.fn(),
      statSync: vi.fn(),
      readFileSync: vi.fn(),
      watch: vi.fn(),
    },
    existsSync: vi.fn(),
    statSync: vi.fn(),
    readFileSync: vi.fn(),
    watch: vi.fn(),
  };
});

// Mock the validator to avoid coupling
vi.mock('../src/validation/validator.js', () => ({
  parseAllowlistConfigJson: vi.fn((content: string) => {
    const parsed = JSON.parse(content);
    return parsed;
  }),
}));

describe('ConfigWatcher', () => {
  let onReload: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;
  let mockLogger: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let mockWatcher: { on: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    onReload = vi.fn();
    onError = vi.fn();
    mockLogger = { info: vi.fn(), error: vi.fn() };
    mockWatcher = { on: vi.fn(), close: vi.fn() };

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);
    vi.mocked(fs.watch).mockReturnValue(mockWatcher as unknown as fs.FSWatcher);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('start', () => {
    it('should start watching when file exists', () => {
      const watcher = new ConfigWatcher({
        filePath: '/tmp/config.json',
        onReload,
        onError,
      });

      const result = watcher.start();
      expect(result).toBe(true);
      expect(watcher.isWatching()).toBe(true);
      expect(fs.watch).toHaveBeenCalledWith('/tmp/config.json', expect.any(Function));
    });

    it('should return false and call onError when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const watcher = new ConfigWatcher({
        filePath: '/tmp/missing.json',
        onReload,
        onError,
      });

      const result = watcher.start();
      expect(result).toBe(false);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('not found') }),
      );
    });

    it('should return false when fs.watch throws', () => {
      vi.mocked(fs.watch).mockImplementation(() => {
        throw new Error('permission denied');
      });

      const watcher = new ConfigWatcher({
        filePath: '/tmp/config.json',
        onReload,
        onError,
      });

      const result = watcher.start();
      expect(result).toBe(false);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'permission denied' }),
      );
    });

    it('should register error handler on the watcher', () => {
      const watcher = new ConfigWatcher({
        filePath: '/tmp/config.json',
        onReload,
        onError,
        logger: mockLogger as any,
      });

      watcher.start();
      expect(mockWatcher.on).toHaveBeenCalledWith('error', expect.any(Function));

      // Simulate watcher error
      const errorHandler = mockWatcher.on.mock.calls.find((c: any[]) => c[0] === 'error')![1];
      const fsError = new Error('watch error');
      errorHandler(fsError);
      expect(onError).toHaveBeenCalledWith(fsError);
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should log when watching starts', () => {
      const watcher = new ConfigWatcher({
        filePath: '/tmp/config.json',
        onReload,
        onError,
        logger: mockLogger as any,
      });

      watcher.start();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/tmp/config.json' }),
        'Started watching configuration file',
      );
    });
  });

  describe('stop', () => {
    it('should close the watcher and clear debounce timer', () => {
      const watcher = new ConfigWatcher({
        filePath: '/tmp/config.json',
        onReload,
        onError,
      });

      watcher.start();
      expect(watcher.isWatching()).toBe(true);

      watcher.stop();
      expect(watcher.isWatching()).toBe(false);
      expect(mockWatcher.close).toHaveBeenCalled();
    });

    it('should be safe to call stop when not watching', () => {
      const watcher = new ConfigWatcher({
        filePath: '/tmp/config.json',
        onReload,
        onError,
      });

      expect(() => watcher.stop()).not.toThrow();
    });

    it('should log when stopping', () => {
      const watcher = new ConfigWatcher({
        filePath: '/tmp/config.json',
        onReload,
        onError,
        logger: mockLogger as any,
      });

      watcher.start();
      watcher.stop();
      expect(mockLogger.info).toHaveBeenCalledWith('Stopped watching configuration file');
    });
  });

  describe('debouncing', () => {
    it('should debounce rapid file changes', () => {
      const watcher = new ConfigWatcher({
        filePath: '/tmp/config.json',
        onReload,
        onError,
        debounceMs: 300,
      });

      watcher.start();

      // Get the change callback from fs.watch
      const watchCallback = vi.mocked(fs.watch).mock.calls[0][1] as Function;

      // Prepare for reload
      const config = { mode: 'strict', defaultAction: 'deny', rules: [] };
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 2000 } as fs.Stats);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

      // Simulate rapid changes
      watchCallback('change');
      watchCallback('change');
      watchCallback('change');

      // Not yet reloaded
      expect(onReload).not.toHaveBeenCalled();

      // After debounce period, should reload once
      vi.advanceTimersByTime(300);
      expect(onReload).toHaveBeenCalledTimes(1);

      watcher.stop();
    });

    it('should use default debounce of 300ms', () => {
      const watcher = new ConfigWatcher({
        filePath: '/tmp/config.json',
        onReload,
        onError,
      });

      watcher.start();
      const watchCallback = vi.mocked(fs.watch).mock.calls[0][1] as Function;

      const config = { mode: 'strict', defaultAction: 'deny', rules: [] };
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 2000 } as fs.Stats);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

      watchCallback('change');

      vi.advanceTimersByTime(299);
      expect(onReload).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onReload).toHaveBeenCalledTimes(1);

      watcher.stop();
    });
  });

  describe('reload', () => {
    it('should skip reload when mtime has not changed', () => {
      const watcher = new ConfigWatcher({
        filePath: '/tmp/config.json',
        onReload,
        onError,
        debounceMs: 0,
      });

      watcher.start();
      const watchCallback = vi.mocked(fs.watch).mock.calls[0][1] as Function;

      // mtime unchanged (1000 from initial start)
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);

      watchCallback('change');
      vi.advanceTimersByTime(0);

      expect(onReload).not.toHaveBeenCalled();
      watcher.stop();
    });

    it('should call onError when reload fails with invalid JSON', () => {
      vi.mocked(parseAllowlistConfigJson).mockImplementation(() => {
        throw new Error('Invalid JSON');
      });

      const watcher = new ConfigWatcher({
        filePath: '/tmp/config.json',
        onReload,
        onError,
        debounceMs: 0,
      });

      watcher.start();
      const watchCallback = vi.mocked(fs.watch).mock.calls[0][1] as Function;

      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 2000 } as fs.Stats);
      vi.mocked(fs.readFileSync).mockReturnValue('not valid json');

      watchCallback('change');
      vi.advanceTimersByTime(0);

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid JSON' }));
      expect(onReload).not.toHaveBeenCalled();

      watcher.stop();
    });

    it('should ignore non-change events', () => {
      const watcher = new ConfigWatcher({
        filePath: '/tmp/config.json',
        onReload,
        onError,
        debounceMs: 0,
      });

      watcher.start();
      const watchCallback = vi.mocked(fs.watch).mock.calls[0][1] as Function;

      watchCallback('rename');
      vi.advanceTimersByTime(300);

      expect(onReload).not.toHaveBeenCalled();
      watcher.stop();
    });
  });

  describe('forceReload', () => {
    it('should reload immediately bypassing debounce', () => {
      const watcher = new ConfigWatcher({
        filePath: '/tmp/config.json',
        onReload,
        onError,
        debounceMs: 5000,
      });

      watcher.start();

      const config = {
        mode: 'strict',
        defaultAction: 'deny',
        rules: [{ id: 'r1', domain: 'x.com' }],
      };
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 2000 } as fs.Stats);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

      watcher.forceReload();

      expect(onReload).toHaveBeenCalledTimes(1);
      expect(onReload).toHaveBeenCalledWith(config);

      watcher.stop();
    });
  });

  describe('isWatching', () => {
    it('should return false before start', () => {
      const watcher = new ConfigWatcher({
        filePath: '/tmp/config.json',
        onReload,
        onError,
      });

      expect(watcher.isWatching()).toBe(false);
    });

    it('should return true after start', () => {
      const watcher = new ConfigWatcher({
        filePath: '/tmp/config.json',
        onReload,
        onError,
      });

      watcher.start();
      expect(watcher.isWatching()).toBe(true);
      watcher.stop();
    });

    it('should return false after stop', () => {
      const watcher = new ConfigWatcher({
        filePath: '/tmp/config.json',
        onReload,
        onError,
      });

      watcher.start();
      watcher.stop();
      expect(watcher.isWatching()).toBe(false);
    });
  });
});

describe('createConfigWatcher', () => {
  it('should return a ConfigWatcher instance', () => {
    const watcher = createConfigWatcher({
      filePath: '/tmp/config.json',
      onReload: vi.fn(),
      onError: vi.fn(),
    });

    expect(watcher).toBeInstanceOf(ConfigWatcher);
  });
});

describe('watchConfig', () => {
  it('should return a cleanup function that stops watching', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);
    const mockWatcher = { on: vi.fn(), close: vi.fn() };
    vi.mocked(fs.watch).mockReturnValue(mockWatcher as unknown as fs.FSWatcher);

    const stop = watchConfig({
      filePath: '/tmp/config.json',
      onReload: vi.fn(),
      onError: vi.fn(),
    });

    expect(typeof stop).toBe('function');

    stop();
    expect(mockWatcher.close).toHaveBeenCalled();
  });
});
