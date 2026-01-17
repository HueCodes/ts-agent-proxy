/**
 * Configuration file watcher for hot-reload support.
 *
 * Watches configuration files for changes and triggers reload callbacks.
 *
 * @module config/watcher
 */

import fs from 'node:fs';
import path from 'node:path';
import type { AllowlistConfig } from '../types/allowlist.js';
import { parseAllowlistConfigJson } from '../validation/validator.js';
import type { Logger } from '../logging/logger.js';

/**
 * Options for the config watcher.
 */
export interface ConfigWatcherOptions {
  /** Path to the configuration file */
  filePath: string;
  /** Callback when config is reloaded successfully */
  onReload: (config: AllowlistConfig) => void;
  /** Callback when an error occurs */
  onError: (error: Error) => void;
  /** Logger instance */
  logger?: Logger;
  /** Debounce delay in milliseconds (default: 300) */
  debounceMs?: number;
}

/**
 * Configuration file watcher with debouncing and validation.
 *
 * Watches a configuration file for changes and triggers a callback
 * when the file is modified. Changes are debounced to prevent multiple
 * reloads during rapid edits.
 *
 * The new configuration is validated before the callback is triggered.
 * Invalid configurations are reported via the error callback and do not
 * trigger the reload callback.
 *
 * @example
 * ```typescript
 * const watcher = new ConfigWatcher({
 *   filePath: './config/allowlist.json',
 *   onReload: (config) => {
 *     server.reloadAllowlist(config);
 *     console.log('Configuration reloaded');
 *   },
 *   onError: (error) => {
 *     console.error('Config reload failed:', error.message);
 *   },
 *   logger
 * });
 *
 * watcher.start();
 *
 * // Later...
 * watcher.stop();
 * ```
 */
export class ConfigWatcher {
  private readonly options: Required<Omit<ConfigWatcherOptions, 'logger'>> & { logger?: Logger };
  private watcher?: fs.FSWatcher;
  private debounceTimer?: NodeJS.Timeout;
  private lastMtime?: number;

  /**
   * Creates a new ConfigWatcher.
   *
   * @param options - Watcher configuration
   */
  constructor(options: ConfigWatcherOptions) {
    this.options = {
      ...options,
      debounceMs: options.debounceMs ?? 300,
    };
  }

  /**
   * Start watching the configuration file.
   *
   * @returns True if watching started successfully
   */
  start(): boolean {
    const { filePath, logger } = this.options;

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      this.options.onError(new Error(`Configuration file not found: ${filePath}`));
      return false;
    }

    try {
      // Get initial mtime
      const stat = fs.statSync(filePath);
      this.lastMtime = stat.mtimeMs;

      // Start watching
      this.watcher = fs.watch(filePath, (eventType) => {
        if (eventType === 'change') {
          this.handleChange();
        }
      });

      this.watcher.on('error', (error) => {
        logger?.error({ error, path: filePath }, 'Config watcher error');
        this.options.onError(error);
      });

      logger?.info({ path: filePath }, 'Started watching configuration file');
      return true;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.options.onError(err);
      return false;
    }
  }

  /**
   * Stop watching the configuration file.
   */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
      this.options.logger?.info('Stopped watching configuration file');
    }
  }

  /**
   * Handle a file change event.
   */
  private handleChange(): void {
    // Clear any pending debounce
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Debounce the reload
    this.debounceTimer = setTimeout(() => {
      this.reload();
    }, this.options.debounceMs);
  }

  /**
   * Reload the configuration file.
   */
  private reload(): void {
    const { filePath, onReload, onError, logger } = this.options;

    try {
      // Check if file actually changed (mtime comparison)
      const stat = fs.statSync(filePath);
      if (this.lastMtime && stat.mtimeMs === this.lastMtime) {
        // File hasn't actually changed
        return;
      }
      this.lastMtime = stat.mtimeMs;

      // Read and parse the file
      const content = fs.readFileSync(filePath, 'utf-8');
      const config = parseAllowlistConfigJson(content, filePath);

      logger?.info(
        { path: filePath, rulesCount: config.rules.length },
        'Configuration file reloaded'
      );

      onReload(config);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger?.error({ error: err, path: filePath }, 'Failed to reload configuration');
      onError(err);
    }
  }

  /**
   * Force a reload of the configuration file.
   *
   * Bypasses debouncing and immediately reloads the configuration.
   */
  forceReload(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.reload();
  }

  /**
   * Check if the watcher is currently active.
   *
   * @returns True if watching
   */
  isWatching(): boolean {
    return this.watcher !== undefined;
  }
}

/**
 * Create a configuration file watcher.
 *
 * @param options - Watcher configuration
 * @returns New ConfigWatcher instance
 *
 * @example
 * ```typescript
 * const watcher = createConfigWatcher({
 *   filePath: './config/allowlist.json',
 *   onReload: (config) => server.reloadAllowlist(config),
 *   onError: (error) => console.error(error)
 * });
 * watcher.start();
 * ```
 */
export function createConfigWatcher(options: ConfigWatcherOptions): ConfigWatcher {
  return new ConfigWatcher(options);
}

/**
 * Watch a configuration file and return a cleanup function.
 *
 * Convenience function that creates a watcher, starts it, and returns
 * a function to stop watching.
 *
 * @param options - Watcher configuration
 * @returns Cleanup function to stop watching
 *
 * @example
 * ```typescript
 * const stopWatching = watchConfig({
 *   filePath: './config/allowlist.json',
 *   onReload: (config) => server.reloadAllowlist(config),
 *   onError: (error) => console.error(error)
 * });
 *
 * // Later...
 * stopWatching();
 * ```
 */
export function watchConfig(options: ConfigWatcherOptions): () => void {
  const watcher = createConfigWatcher(options);
  watcher.start();
  return () => watcher.stop();
}
