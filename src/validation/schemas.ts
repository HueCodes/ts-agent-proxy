/**
 * Zod validation schemas for proxy configuration.
 * Provides runtime type checking and helpful error messages.
 */

import { z } from 'zod';

/**
 * HTTP methods supported by the proxy.
 */
export const HttpMethodSchema = z.enum([
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
  'CONNECT',
  'TRACE',
]);

/**
 * Schema for rate limit configuration.
 */
export const RateLimitConfigSchema = z.object({
  /** Maximum requests allowed per minute (1-10000) */
  requestsPerMinute: z
    .number()
    .int()
    .positive()
    .max(10000, 'Rate limit cannot exceed 10000 requests per minute'),
});

/**
 * Schema for header transformation rules.
 */
export const HeaderTransformSchema = z.object({
  /** Headers to add or overwrite */
  set: z.record(z.string(), z.string()).optional(),
  /** Headers to remove */
  remove: z.array(z.string()).optional(),
  /** Headers to rename (oldName -> newName) */
  rename: z.record(z.string(), z.string()).optional(),
});

/**
 * Schema for a single allowlist rule.
 */
export const AllowlistRuleSchema = z.object({
  /** Unique identifier for the rule */
  id: z
    .string()
    .min(1, 'Rule ID cannot be empty')
    .max(64, 'Rule ID cannot exceed 64 characters')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Rule ID can only contain letters, numbers, underscores, and hyphens'),

  /** Domain pattern to match (exact or wildcard like *.example.com) */
  domain: z
    .string()
    .min(1, 'Domain cannot be empty')
    .max(253, 'Domain cannot exceed 253 characters'),

  /** Path patterns to allow (glob patterns supported) */
  paths: z.array(z.string().min(1)).optional(),

  /** HTTP methods to allow (case-insensitive, will be uppercased) */
  methods: z
    .array(
      z.string().transform((m) => m.toUpperCase()).pipe(HttpMethodSchema)
    )
    .optional(),

  /** Rate limiting configuration */
  rateLimit: RateLimitConfigSchema.optional(),

  /** Optional description of the rule */
  description: z.string().max(500).optional(),

  /** Whether the rule is enabled (default: true) */
  enabled: z.boolean().optional().default(true),

  /** Client IPs this rule applies to (CIDR notation supported) */
  clientIps: z.array(z.string()).optional(),

  /** Client IPs to exclude from this rule */
  excludeClientIps: z.array(z.string()).optional(),

  /** Request header transformations */
  requestHeaders: HeaderTransformSchema.optional(),

  /** Response header transformations */
  responseHeaders: HeaderTransformSchema.optional(),
});

/**
 * Schema for allowlist mode.
 */
export const AllowlistModeSchema = z.enum(['strict', 'permissive']);

/**
 * Schema for default action.
 */
export const DefaultActionSchema = z.enum(['allow', 'deny']);

/**
 * Schema for the complete allowlist configuration.
 */
export const AllowlistConfigSchema = z.object({
  /** Operating mode: strict (deny by default) or permissive (allow by default) */
  mode: AllowlistModeSchema,

  /** Default action when no rule matches */
  defaultAction: DefaultActionSchema,

  /** List of allowlist rules */
  rules: z.array(AllowlistRuleSchema),
}).refine(
  (config) => {
    // Check for duplicate rule IDs
    const ids = config.rules.map((r) => r.id);
    return new Set(ids).size === ids.length;
  },
  { message: 'Duplicate rule IDs found. Each rule must have a unique ID.' }
);

/**
 * Schema for proxy mode.
 */
export const ProxyModeSchema = z.enum(['tunnel', 'mitm']);

/**
 * Schema for log level.
 */
export const LogLevelSchema = z.enum([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
  'silent',
]);

/**
 * Schema for TLS configuration.
 */
export const TlsConfigSchema = z.object({
  /** Path to CA certificate file (for MITM mode) */
  caCertPath: z.string().optional(),

  /** Path to CA private key file (for MITM mode) */
  caKeyPath: z.string().optional(),

  /** Auto-generate CA if not provided */
  autoGenerateCa: z.boolean().optional().default(true),

  /** Directory to store generated certificates */
  certCacheDir: z.string().optional(),
});

/**
 * Schema for logging configuration.
 */
export const LoggingConfigSchema = z.object({
  /** Log level */
  level: LogLevelSchema.default('info'),

  /** Path to audit log file */
  auditLogPath: z.string().optional(),

  /** Whether to log to console */
  console: z.boolean().optional().default(true),

  /** Whether to use pretty printing for console output */
  pretty: z.boolean().optional().default(true),

  /** Log request headers (redact sensitive ones) */
  logHeaders: z.boolean().optional().default(false),

  /** Log request body (up to maxBodyLogSize bytes) */
  logBody: z.boolean().optional().default(false),

  /** Maximum body size to log in bytes */
  maxBodyLogSize: z.number().int().positive().optional().default(1024),

  /** Headers to redact from logs */
  redactHeaders: z
    .array(z.string())
    .optional()
    .default(['authorization', 'cookie', 'x-api-key', 'x-auth-token']),
});

/**
 * Schema for limits configuration.
 */
export const LimitsConfigSchema = z.object({
  /** Maximum request body size in bytes (default: 10MB) */
  maxRequestBodySize: z.number().int().positive().max(1024 * 1024 * 1024).default(10 * 1024 * 1024),

  /** Maximum response body size in bytes (default: 50MB) */
  maxResponseBodySize: z.number().int().positive().max(1024 * 1024 * 1024).default(50 * 1024 * 1024),

  /** Maximum header size in bytes (default: 16KB) */
  maxHeaderSize: z.number().int().positive().max(1024 * 1024).default(16 * 1024),

  /** Maximum URL length in bytes (default: 8KB) */
  maxUrlLength: z.number().int().positive().max(1024 * 1024).default(8 * 1024),

  /** Maximum concurrent connections per client IP (default: 100) */
  maxConcurrentConnectionsPerIp: z.number().int().positive().max(100000).default(100),

  /** Maximum total concurrent connections (default: 10000) */
  maxTotalConnections: z.number().int().positive().max(1000000).default(10000),
});

/**
 * Schema for timeouts configuration.
 */
export const TimeoutsConfigSchema = z.object({
  /** Timeout for establishing connection to upstream (ms, default: 10000) */
  connectTimeout: z.number().int().positive().max(300000).default(10000),

  /** Timeout for receiving response from upstream (ms, default: 30000) */
  responseTimeout: z.number().int().positive().max(600000).default(30000),

  /** Idle timeout for keep-alive connections (ms, default: 60000) */
  idleTimeout: z.number().int().positive().max(3600000).default(60000),

  /** Timeout for reading client request (ms, default: 30000) */
  requestTimeout: z.number().int().positive().max(600000).default(30000),
});

/**
 * Schema for admin authentication method.
 */
export const AdminAuthMethodSchema = z.enum(['none', 'bearer', 'api-key', 'ip-allowlist']);

/**
 * Schema for admin authentication configuration.
 */
export const AdminAuthConfigSchema = z.object({
  /** Authentication method */
  method: AdminAuthMethodSchema.default('none'),

  /** Bearer token (for 'bearer' method) */
  bearerToken: z.string().min(16).max(256).optional(),

  /** API key header name (for 'api-key' method) */
  apiKeyHeader: z.string().min(1).max(64).default('X-API-Key'),

  /** API key value (for 'api-key' method) */
  apiKey: z.string().min(16).max(256).optional(),

  /** Allowed IPs (for 'ip-allowlist' method, CIDR notation supported) */
  allowedIps: z.array(z.string()).optional(),

  /** Endpoints that require authentication */
  protectedEndpoints: z.array(z.string()).default(['/metrics', '/config']),

  /** Rate limit for admin endpoints (requests per minute) */
  rateLimitPerMinute: z.number().int().positive().max(1000).default(60),
}).refine(
  (config) => {
    if (config.method === 'bearer' && !config.bearerToken) {
      return false;
    }
    if (config.method === 'api-key' && !config.apiKey) {
      return false;
    }
    if (config.method === 'ip-allowlist' && (!config.allowedIps || config.allowedIps.length === 0)) {
      return false;
    }
    return true;
  },
  { message: 'Authentication method requires corresponding credentials to be configured' }
);

/**
 * Schema for admin server configuration.
 */
export const AdminConfigSchema = z.object({
  /** Whether the admin server is enabled */
  enabled: z.boolean().default(false),

  /** Admin server port */
  port: z.number().int().min(1).max(65535).default(9090),

  /** Admin server host */
  host: z.string().default('127.0.0.1'),

  /** Authentication configuration */
  auth: AdminAuthConfigSchema.optional(),
});

/**
 * Schema for server configuration.
 */
export const ServerConfigSchema = z.object({
  /** Proxy server host */
  host: z.string().default('127.0.0.1'),

  /** Proxy server port */
  port: z.number().int().min(1).max(65535).default(8080),

  /** Proxy mode: tunnel (CONNECT) or mitm (full inspection) */
  mode: ProxyModeSchema.default('tunnel'),

  /** TLS configuration (for MITM mode) */
  tls: TlsConfigSchema.optional(),

  /** Logging configuration */
  logging: LoggingConfigSchema.optional().default({
    level: 'info',
    console: true,
    pretty: true,
    logHeaders: false,
    logBody: false,
    maxBodyLogSize: 1024,
    redactHeaders: ['authorization', 'cookie', 'x-api-key', 'x-auth-token'],
  }),

  /** Admin server configuration */
  admin: AdminConfigSchema.optional(),

  /** Request/response size limits */
  limits: LimitsConfigSchema.optional().default({
    maxRequestBodySize: 10 * 1024 * 1024,
    maxResponseBodySize: 50 * 1024 * 1024,
    maxHeaderSize: 16 * 1024,
    maxUrlLength: 8 * 1024,
    maxConcurrentConnectionsPerIp: 100,
    maxTotalConnections: 10000,
  }),

  /** Upstream connection timeouts */
  timeouts: TimeoutsConfigSchema.optional().default({
    connectTimeout: 10000,
    responseTimeout: 30000,
    idleTimeout: 60000,
    requestTimeout: 30000,
  }),
});

/**
 * Schema for the complete proxy configuration.
 */
export const ProxyConfigSchema = z.object({
  /** Server configuration */
  server: ServerConfigSchema,

  /** Allowlist configuration */
  allowlist: AllowlistConfigSchema,
});

// Export inferred types
export type HttpMethod = z.infer<typeof HttpMethodSchema>;
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;
export type HeaderTransform = z.infer<typeof HeaderTransformSchema>;
export type AllowlistRule = z.infer<typeof AllowlistRuleSchema>;
export type AllowlistMode = z.infer<typeof AllowlistModeSchema>;
export type DefaultAction = z.infer<typeof DefaultActionSchema>;
export type AllowlistConfig = z.infer<typeof AllowlistConfigSchema>;
export type ProxyMode = z.infer<typeof ProxyModeSchema>;
export type LogLevel = z.infer<typeof LogLevelSchema>;
export type TlsConfig = z.infer<typeof TlsConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type LimitsConfig = z.infer<typeof LimitsConfigSchema>;
export type TimeoutsConfig = z.infer<typeof TimeoutsConfigSchema>;
export type AdminAuthMethod = z.infer<typeof AdminAuthMethodSchema>;
export type AdminAuthConfig = z.infer<typeof AdminAuthConfigSchema>;
export type AdminConfig = z.infer<typeof AdminConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
