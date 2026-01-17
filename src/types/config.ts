/**
 * Proxy server configuration types.
 */

import type { AllowlistConfig } from './allowlist.js';

export type ProxyMode = 'tunnel' | 'mitm';

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
}

export interface ProxyConfig {
  /** Server configuration */
  server: ServerConfig;
  /** Allowlist configuration */
  allowlist: AllowlistConfig;
}

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
    },
    allowlist: {
      mode: 'strict',
      defaultAction: 'deny',
      rules: [],
    },
  };
}
