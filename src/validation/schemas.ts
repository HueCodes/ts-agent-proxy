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
 * Schema for admin server configuration.
 */
export const AdminConfigSchema = z.object({
  /** Whether the admin server is enabled */
  enabled: z.boolean().default(false),

  /** Admin server port */
  port: z.number().int().min(1).max(65535).default(9090),

  /** Admin server host */
  host: z.string().default('127.0.0.1'),
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
export type AdminConfig = z.infer<typeof AdminConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
