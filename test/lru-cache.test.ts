import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { LruCache, createLruCache, DEFAULT_LRU_CACHE_CONFIG } from '../src/utils/lru-cache.js';

describe('LruCache', () => {
  describe('basic operations', () => {
    let cache: LruCache<string, string>;

    beforeEach(() => {
      cache = new LruCache<string, string>({ maxSize: 3, ttlMs: 0 });
    });

    it('should set and get values', () => {
      cache.set('key1', 'value1');
      expect(cache.get('key1')).toBe('value1');
    });

    it('should return undefined for missing keys', () => {
      expect(cache.get('missing')).toBeUndefined();
    });

    it('should check if key exists', () => {
      cache.set('key1', 'value1');
      expect(cache.has('key1')).toBe(true);
      expect(cache.has('missing')).toBe(false);
    });

    it('should delete keys', () => {
      cache.set('key1', 'value1');
      expect(cache.delete('key1')).toBe(true);
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should clear all entries', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should track size correctly', () => {
      expect(cache.size).toBe(0);
      cache.set('key1', 'value1');
      expect(cache.size).toBe(1);
      cache.set('key2', 'value2');
      expect(cache.size).toBe(2);
      cache.delete('key1');
      expect(cache.size).toBe(1);
    });
  });

  describe('LRU eviction', () => {
    let cache: LruCache<string, number>;

    beforeEach(() => {
      cache = new LruCache<string, number>({ maxSize: 3, ttlMs: 0 });
    });

    it('should evict least recently used when at capacity', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.set('d', 4); // Should evict 'a'

      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe(2);
      expect(cache.get('c')).toBe(3);
      expect(cache.get('d')).toBe(4);
      expect(cache.size).toBe(3);
    });

    it('should refresh access order on get', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      // Access 'a' to move it to most recent
      cache.get('a');

      cache.set('d', 4); // Should evict 'b' (now least recent)

      expect(cache.get('a')).toBe(1);
      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('c')).toBe(3);
      expect(cache.get('d')).toBe(4);
    });

    it('should update position on set of existing key', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      // Update 'a' to move it to most recent
      cache.set('a', 10);

      cache.set('d', 4); // Should evict 'b'

      expect(cache.get('a')).toBe(10);
      expect(cache.get('b')).toBeUndefined();
    });
  });

  describe('TTL expiration', () => {
    let cache: LruCache<string, string>;

    beforeEach(() => {
      vi.useFakeTimers();
      cache = new LruCache<string, string>({ maxSize: 10, ttlMs: 1000 });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return value before TTL expires', () => {
      cache.set('key', 'value');
      vi.advanceTimersByTime(500);
      expect(cache.get('key')).toBe('value');
    });

    it('should return undefined after TTL expires', () => {
      cache.set('key', 'value');
      vi.advanceTimersByTime(1001);
      expect(cache.get('key')).toBeUndefined();
    });

    it('should remove expired entries on has() check', () => {
      cache.set('key', 'value');
      vi.advanceTimersByTime(1001);
      expect(cache.has('key')).toBe(false);
    });

    it('should prune expired entries', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      vi.advanceTimersByTime(500);
      cache.set('key3', 'value3'); // Not expired yet
      vi.advanceTimersByTime(600);

      const pruned = cache.prune();
      expect(pruned).toBe(2); // key1 and key2 should be pruned
      expect(cache.has('key3')).toBe(true);
    });

    it('should not expire entries when ttlMs is 0', () => {
      const noTtlCache = new LruCache<string, string>({ maxSize: 10, ttlMs: 0 });
      noTtlCache.set('key', 'value');
      vi.advanceTimersByTime(100000);
      expect(noTtlCache.get('key')).toBe('value');
    });
  });

  describe('statistics', () => {
    let cache: LruCache<string, number>;

    beforeEach(() => {
      cache = new LruCache<string, number>({ maxSize: 3, ttlMs: 0 });
    });

    it('should track hits and misses', () => {
      cache.set('a', 1);

      cache.get('a'); // hit
      cache.get('a'); // hit
      cache.get('b'); // miss
      cache.get('c'); // miss

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(2);
      expect(stats.hitRate).toBe(0.5);
    });

    it('should track evictions', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.set('d', 4); // evicts 'a'
      cache.set('e', 5); // evicts 'b'

      const stats = cache.getStats();
      expect(stats.evictions).toBe(2);
    });

    it('should track expirations', () => {
      vi.useFakeTimers();
      const ttlCache = new LruCache<string, number>({ maxSize: 10, ttlMs: 1000 });

      ttlCache.set('a', 1);
      vi.advanceTimersByTime(1001);
      ttlCache.get('a'); // Should count as expiration

      const stats = ttlCache.getStats();
      expect(stats.expirations).toBe(1);

      vi.useRealTimers();
    });

    it('should reset statistics', () => {
      cache.set('a', 1);
      cache.get('a');
      cache.get('b');

      cache.resetStats();

      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.evictions).toBe(0);
    });

    it('should include size and maxSize in stats', () => {
      cache.set('a', 1);
      cache.set('b', 2);

      const stats = cache.getStats();
      expect(stats.size).toBe(2);
      expect(stats.maxSize).toBe(3);
    });
  });

  describe('warmup', () => {
    it('should pre-populate cache with entries', () => {
      const cache = new LruCache<string, number>({ maxSize: 10, ttlMs: 0 });
      cache.warmup([
        { key: 'a', value: 1 },
        { key: 'b', value: 2 },
        { key: 'c', value: 3 },
      ]);

      expect(cache.get('a')).toBe(1);
      expect(cache.get('b')).toBe(2);
      expect(cache.get('c')).toBe(3);
      expect(cache.size).toBe(3);
    });
  });

  describe('keys iterator', () => {
    it('should iterate over all keys', () => {
      const cache = new LruCache<string, number>({ maxSize: 10, ttlMs: 0 });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      const keys = [...cache.keys()];
      expect(keys).toContain('a');
      expect(keys).toContain('b');
      expect(keys).toContain('c');
      expect(keys.length).toBe(3);
    });
  });
});

describe('createLruCache', () => {
  it('should create a cache with default config', () => {
    const cache = createLruCache<string, string>();
    const stats = cache.getStats();
    expect(stats.maxSize).toBe(DEFAULT_LRU_CACHE_CONFIG.maxSize);
  });

  it('should create a cache with custom config', () => {
    const cache = createLruCache<string, string>({ maxSize: 500 });
    const stats = cache.getStats();
    expect(stats.maxSize).toBe(500);
  });
});
