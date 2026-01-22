/**
 * Proxy server configuration types.
 */

import type { AllowlistConfig } from './allowlist.js';

export type ProxyMode = 'tunnel' | 'mitm';

/**
 * Request/response size limits for DoS protection.
 */
export interface LimitsConfig {
  /** Maximum request body size in bytes (default: 10MB) */
  maxRequestBodySize: number;
  /** Maximum response body size in bytes (default: 50MB) */
  maxResponseBodySize: number;
  /** Maximum header size in bytes (default: 16KB) */
  maxHeaderSize: number;
  /** Maximum URL length in bytes (default: 8KB) */
  maxUrlLength: number;
  /** Maximum concurrent connections per client IP (default: 100) */
  maxConcurrentConnectionsPerIp: number;
  /** Maximum total concurrent connections (default: 10000) */
  maxTotalConnections: number;
}

/**
 * Upstream connection timeout configuration.
 */
export interface TimeoutsConfig {
  /** Timeout for establishing connection to upstream (ms, default: 10000) */
  connectTimeout: number;
  /** Timeout for receiving response from upstream (ms, default: 30000) */
  responseTimeout: number;
  /** Idle timeout for keep-alive connections (ms, default: 60000) */
  idleTimeout: number;
  /** Timeout for reading client request (ms, default: 30000) */
  requestTimeout: number;
}

/**
 * Admin API authentication method.
 */
export type AdminAuthMethod = 'none' | 'bearer' | 'api-key' | 'ip-allowlist';

/**
 * Admin API authentication configuration.
 */
export interface AdminAuthConfig {
  /** Authentication method */
  method: AdminAuthMethod;
  /** Bearer token (for 'bearer' method) */
  bearerToken?: string;
  /** API key header name (for 'api-key' method, default: 'X-API-Key') */
  apiKeyHeader?: string;
  /** API key value (for 'api-key' method) */
  apiKey?: string;
  /** Allowed IPs (for 'ip-allowlist' method, CIDR notation supported) */
  allowedIps?: string[];
  /** Endpoints that require authentication (default: ['/metrics', '/config']) */
  protectedEndpoints?: string[];
  /** Rate limit for admin endpoints (requests per minute, default: 60) */
  rateLimitPerMinute?: number;
}

export interface TlsConfig {
  /** Path to CA certificate file (for MITM mode) */
  caCertPath?: string;
  /** Path to CA private key file (for MITM mode) */
  caKeyPath?: string;
  /** Auto-generate CA if not provided */
  autoGenerateCa?: boolean;
  /** Directory to store generated certificates */
  certCacheDir?: string;
}

export interface LoggingConfig {
  /** Log level: trace, debug, info, warn, error, fatal */
  level: string;
  /** Path to audit log file */
  auditLogPath?: string;
  /** Whether to log to console */
  console?: boolean;
  /** Whether to use pretty printing for console output */
  pretty?: boolean;
  /** Log request headers (redact sensitive ones) */
  logHeaders?: boolean;
  /** Log request body (up to maxBodyLogSize bytes) */
  logBody?: boolean;
  /** Maximum body size to log in bytes */
  maxBodyLogSize?: number;
  /** Headers to redact from logs */
  redactHeaders?: string[];
}

export interface AdminConfig {
  /** Whether the admin server is enabled */
  enabled: boolean;
  /** Admin server port */
  port: number;
  /** Admin server host */
  host: string;
  /** Authentication configuration */
  auth?: AdminAuthConfig;
}

export interface ServerConfig {
  /** Proxy server host */
  host: string;
  /** Proxy server port */
  port: number;
  /** Proxy mode: tunnel (CONNECT) or mitm (full inspection) */
  mode: ProxyMode;
  /** TLS configuration (for MITM mode) */
  tls?: TlsConfig;
  /** Logging configuration */
  logging: LoggingConfig;
  /** Admin server configuration */
  admin?: AdminConfig;
  /** Request/response size limits */
  limits?: LimitsConfig;
  /** Upstream connection timeouts */
  timeouts?: TimeoutsConfig;
}

export interface ProxyConfig {
  /** Server configuration */
  server: ServerConfig;
  /** Allowlist configuration */
  allowlist: AllowlistConfig;
}

/**
 * Default limits configuration.
 */
export const DEFAULT_LIMITS: LimitsConfig = {
  maxRequestBodySize: 10 * 1024 * 1024, // 10MB
  maxResponseBodySize: 50 * 1024 * 1024, // 50MB
  maxHeaderSize: 16 * 1024, // 16KB
  maxUrlLength: 8 * 1024, // 8KB
  maxConcurrentConnectionsPerIp: 100,
  maxTotalConnections: 10000,
};

/**
 * Default timeouts configuration.
 */
export const DEFAULT_TIMEOUTS: TimeoutsConfig = {
  connectTimeout: 10000, // 10 seconds
  responseTimeout: 30000, // 30 seconds
  idleTimeout: 60000, // 60 seconds
  requestTimeout: 30000, // 30 seconds
};

export function createDefaultConfig(): ProxyConfig {
  return {
    server: {
      host: '127.0.0.1',
      port: 8080,
      mode: 'tunnel',
      logging: {
        level: 'info',
        console: true,
        pretty: true,
      },
      limits: { ...DEFAULT_LIMITS },
      timeouts: { ...DEFAULT_TIMEOUTS },
    },
    allowlist: {
      mode: 'strict',
      defaultAction: 'deny',
      rules: [],
    },
  };
}
