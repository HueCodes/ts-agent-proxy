/**
 * LRU (Least Recently Used) cache with TTL support.
 *
 * Provides an efficient cache with configurable max size and
 * time-to-live for cached entries.
 */

/**
 * Cache entry with metadata.
 */
interface CacheEntry<V> {
  value: V;
  createdAt: number;
  accessedAt: number;
}

/**
 * LRU cache configuration.
 */
export interface LruCacheConfig {
  /** Maximum number of entries (default: 1000) */
  maxSize: number;
  /** Time-to-live in milliseconds (default: 24 hours, 0 = no TTL) */
  ttlMs: number;
}

/**
 * LRU cache statistics.
 */
export interface LruCacheStats {
  /** Number of entries currently in cache */
  size: number;
  /** Maximum size of the cache */
  maxSize: number;
  /** Number of cache hits */
  hits: number;
  /** Number of cache misses */
  misses: number;
  /** Hit rate (0-1) */
  hitRate: number;
  /** Number of entries evicted due to size limit */
  evictions: number;
  /** Number of entries expired due to TTL */
  expirations: number;
}

/**
 * Default cache configuration.
 */
export const DEFAULT_LRU_CACHE_CONFIG: LruCacheConfig = {
  maxSize: 1000,
  ttlMs: 24 * 60 * 60 * 1000, // 24 hours
};

/**
 * LRU cache with TTL support.
 *
 * Uses a Map for O(1) access and maintains LRU order
 * by re-inserting entries on access.
 */
export class LruCache<K, V> {
  private readonly cache: Map<K, CacheEntry<V>> = new Map();
  private readonly config: LruCacheConfig;

  // Statistics
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expirations = 0;

  constructor(config: Partial<LruCacheConfig> = {}) {
    this.config = { ...DEFAULT_LRU_CACHE_CONFIG, ...config };
  }

  /**
   * Get a value from the cache.
   * Returns undefined if not found or expired.
   */
  get(key: K): V | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return undefined;
    }

    // Check TTL
    if (this.isExpired(entry)) {
      this.cache.delete(key);
      this.expirations++;
      this.misses++;
      return undefined;
    }

    // Update access time and move to end (most recently used)
    entry.accessedAt = Date.now();
    this.cache.delete(key);
    this.cache.set(key, entry);

    this.hits++;
    return entry.value;
  }

  /**
   * Set a value in the cache.
   */
  set(key: K, value: V): void {
    // If key exists, delete to update position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict if at capacity
    while (this.cache.size >= this.config.maxSize) {
      this.evictLru();
    }

    const now = Date.now();
    this.cache.set(key, {
      value,
      createdAt: now,
      accessedAt: now,
    });
  }

  /**
   * Check if a key exists and is not expired.
   */
  has(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      this.expirations++;
      return false;
    }

    return true;
  }

  /**
   * Delete a key from the cache.
   */
  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all entries from the cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the current size of the cache.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get cache statistics.
   */
  getStats(): LruCacheStats {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      maxSize: this.config.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      evictions: this.evictions,
      expirations: this.expirations,
    };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.expirations = 0;
  }

  /**
   * Get all keys in the cache (for debugging/iteration).
   */
  keys(): IterableIterator<K> {
    return this.cache.keys();
  }

  /**
   * Prune expired entries.
   * Call periodically to clean up memory.
   */
  prune(): number {
    let pruned = 0;
    for (const [key, entry] of this.cache) {
      if (this.isExpired(entry)) {
        this.cache.delete(key);
        this.expirations++;
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Pre-warm the cache with entries.
   */
  warmup(entries: Array<{ key: K; value: V }>): void {
    for (const { key, value } of entries) {
      this.set(key, value);
    }
  }

  /**
   * Check if an entry is expired.
   */
  private isExpired(entry: CacheEntry<V>): boolean {
    if (this.config.ttlMs === 0) return false;
    return Date.now() - entry.createdAt > this.config.ttlMs;
  }

  /**
   * Evict the least recently used entry.
   */
  private evictLru(): void {
    // Map iterator returns entries in insertion order
    // First entry is the oldest (least recently used)
    const firstKey = this.cache.keys().next().value;
    if (firstKey !== undefined) {
      this.cache.delete(firstKey);
      this.evictions++;
    }
  }
}

/**
 * Create an LRU cache.
 */
export function createLruCache<K, V>(config?: Partial<LruCacheConfig>): LruCache<K, V> {
  return new LruCache<K, V>(config);
}
