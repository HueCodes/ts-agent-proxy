/**
 * Log destination handlers for audit logging.
 *
 * Provides multiple output destinations for audit logs including
 * file, syslog, and webhook endpoints.
 *
 * @module logging/log-destinations
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

/**
 * Base log destination interface.
 */
export interface LogDestination {
  /** Destination name for identification */
  readonly name: string;
  /** Write a log entry */
  write(entry: string): void | Promise<void>;
  /** Flush pending writes */
  flush(): void | Promise<void>;
  /** Close the destination */
  close(): void | Promise<void>;
}

/**
 * File destination configuration.
 */
export interface FileDestinationConfig {
  /** File path */
  path: string;
  /** Enable log rotation (default: false) */
  rotate?: boolean;
  /** Maximum file size in bytes before rotation (default: 10MB) */
  maxSize?: number;
  /** Maximum number of rotated files to keep (default: 5) */
  maxFiles?: number;
  /** Compress rotated files (default: false) */
  compress?: boolean;
}

/**
 * Syslog destination configuration.
 */
export interface SyslogDestinationConfig {
  /** Syslog host */
  host: string;
  /** Syslog port (default: 514) */
  port?: number;
  /** Protocol: 'udp' or 'tcp' (default: 'udp') */
  protocol?: 'udp' | 'tcp';
  /** Syslog facility (default: 'local0') */
  facility?: string;
  /** Application name (default: 'ts-agent-proxy') */
  appName?: string;
}

/**
 * Webhook destination configuration.
 */
export interface WebhookDestinationConfig {
  /** Webhook URL */
  url: string;
  /** HTTP method (default: 'POST') */
  method?: 'POST' | 'PUT';
  /** Additional headers */
  headers?: Record<string, string>;
  /** Batch size before sending (default: 1) */
  batchSize?: number;
  /** Batch timeout in ms (default: 5000) */
  batchTimeout?: number;
  /** Retry count on failure (default: 3) */
  retryCount?: number;
  /** Retry delay in ms (default: 1000) */
  retryDelay?: number;
}

/**
 * File log destination with rotation support.
 */
export class FileDestination implements LogDestination {
  readonly name = 'file';
  private readonly config: Required<FileDestinationConfig>;
  private stream?: fs.WriteStream;
  private currentSize = 0;
  private rotationIndex = 0;

  constructor(config: FileDestinationConfig) {
    this.config = {
      path: config.path,
      rotate: config.rotate ?? false,
      maxSize: config.maxSize ?? 10 * 1024 * 1024, // 10MB
      maxFiles: config.maxFiles ?? 5,
      compress: config.compress ?? false,
    };
    this.initStream();
  }

  private initStream(): void {
    const dir = path.dirname(this.config.path);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Check existing file size
    if (fs.existsSync(this.config.path)) {
      const stats = fs.statSync(this.config.path);
      this.currentSize = stats.size;
    }

    this.stream = fs.createWriteStream(this.config.path, {
      flags: 'a',
      encoding: 'utf-8',
    });
  }

  write(entry: string): void {
    if (!this.stream) return;

    const line = entry + '\n';
    this.stream.write(line);
    this.currentSize += Buffer.byteLength(line);

    if (this.config.rotate && this.currentSize >= this.config.maxSize) {
      this.rotate();
    }
  }

  private rotate(): void {
    if (!this.stream) return;

    this.stream.end();

    // Rotate existing files
    for (let i = this.config.maxFiles - 1; i >= 1; i--) {
      const oldPath = `${this.config.path}.${i}`;
      const newPath = `${this.config.path}.${i + 1}`;
      if (fs.existsSync(oldPath)) {
        if (i === this.config.maxFiles - 1) {
          fs.unlinkSync(oldPath);
        } else {
          fs.renameSync(oldPath, newPath);
        }
      }
    }

    // Rename current file
    if (fs.existsSync(this.config.path)) {
      fs.renameSync(this.config.path, `${this.config.path}.1`);
    }

    this.currentSize = 0;
    this.initStream();
  }

  flush(): void {
    // WriteStream handles buffering internally
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.stream) {
        resolve();
        return;
      }
      this.stream.end((err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

/**
 * Console log destination.
 */
export class ConsoleDestination implements LogDestination {
  readonly name = 'console';
  private readonly pretty: boolean;

  constructor(pretty = false) {
    this.pretty = pretty;
  }

  write(entry: string): void {
    if (this.pretty) {
      try {
        const parsed = JSON.parse(entry);
        console.log(JSON.stringify(parsed, null, 2));
      } catch {
        console.log(entry);
      }
    } else {
      console.log(entry);
    }
  }

  flush(): void {}

  close(): void {}
}

/**
 * Webhook log destination with batching and retry.
 */
export class WebhookDestination implements LogDestination {
  readonly name = 'webhook';
  private readonly config: Required<WebhookDestinationConfig>;
  private readonly url: URL;
  private batch: string[] = [];
  private batchTimer?: NodeJS.Timeout;

  constructor(config: WebhookDestinationConfig) {
    this.config = {
      url: config.url,
      method: config.method ?? 'POST',
      headers: config.headers ?? {},
      batchSize: config.batchSize ?? 1,
      batchTimeout: config.batchTimeout ?? 5000,
      retryCount: config.retryCount ?? 3,
      retryDelay: config.retryDelay ?? 1000,
    };
    this.url = new URL(this.config.url);
  }

  write(entry: string): void {
    this.batch.push(entry);

    if (this.batch.length >= this.config.batchSize) {
      this.sendBatch();
    } else if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => {
        this.sendBatch();
      }, this.config.batchTimeout);
    }
  }

  private async sendBatch(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }

    if (this.batch.length === 0) return;

    const entries = this.batch;
    this.batch = [];

    const body = JSON.stringify({
      entries: entries.map((e) => {
        try {
          return JSON.parse(e);
        } catch {
          return { raw: e };
        }
      }),
      timestamp: new Date().toISOString(),
      count: entries.length,
    });

    await this.sendWithRetry(body, this.config.retryCount);
  }

  private async sendWithRetry(body: string, retriesLeft: number): Promise<void> {
    const client = this.url.protocol === 'https:' ? https : http;

    const options = {
      hostname: this.url.hostname,
      port: this.url.port || (this.url.protocol === 'https:' ? 443 : 80),
      path: this.url.pathname + this.url.search,
      method: this.config.method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...this.config.headers,
      },
    };

    return new Promise((resolve) => {
      const req = client.request(options, (res) => {
        res.resume(); // Consume response
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else if (retriesLeft > 0) {
          setTimeout(() => {
            this.sendWithRetry(body, retriesLeft - 1).then(resolve);
          }, this.config.retryDelay);
        } else {
          console.error(`Webhook failed: ${res.statusCode}`);
          resolve();
        }
      });

      req.on('error', (err) => {
        if (retriesLeft > 0) {
          setTimeout(() => {
            this.sendWithRetry(body, retriesLeft - 1).then(resolve);
          }, this.config.retryDelay);
        } else {
          console.error(`Webhook error: ${err.message}`);
          resolve();
        }
      });

      req.write(body);
      req.end();
    });
  }

  async flush(): Promise<void> {
    await this.sendBatch();
  }

  async close(): Promise<void> {
    await this.flush();
  }
}

/**
 * Multi-destination writer that writes to multiple destinations.
 */
export class MultiDestination implements LogDestination {
  readonly name = 'multi';
  private readonly destinations: LogDestination[];

  constructor(destinations: LogDestination[]) {
    this.destinations = destinations;
  }

  async write(entry: string): Promise<void> {
    await Promise.all(this.destinations.map((d) => d.write(entry)));
  }

  async flush(): Promise<void> {
    await Promise.all(this.destinations.map((d) => d.flush()));
  }

  async close(): Promise<void> {
    await Promise.all(this.destinations.map((d) => d.close()));
  }

  /**
   * Add a destination.
   */
  addDestination(destination: LogDestination): void {
    this.destinations.push(destination);
  }

  /**
   * Remove a destination by name.
   */
  removeDestination(name: string): void {
    const index = this.destinations.findIndex((d) => d.name === name);
    if (index !== -1) {
      this.destinations.splice(index, 1);
    }
  }

  /**
   * Get all destinations.
   */
  getDestinations(): LogDestination[] {
    return [...this.destinations];
  }
}

/**
 * Create a file destination.
 */
export function createFileDestination(config: FileDestinationConfig): FileDestination {
  return new FileDestination(config);
}

/**
 * Create a console destination.
 */
export function createConsoleDestination(pretty = false): ConsoleDestination {
  return new ConsoleDestination(pretty);
}

/**
 * Create a webhook destination.
 */
export function createWebhookDestination(config: WebhookDestinationConfig): WebhookDestination {
  return new WebhookDestination(config);
}

/**
 * Create a multi-destination writer.
 */
export function createMultiDestination(destinations: LogDestination[]): MultiDestination {
  return new MultiDestination(destinations);
}
