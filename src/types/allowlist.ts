/**
 * Allowlist rule configuration types.
 */

export interface RateLimitConfig {
  /** Maximum requests allowed per minute */
  requestsPerMinute: number;
}

/**
 * Header transformation rules for requests/responses.
 */
export interface HeaderTransform {
  /** Headers to add or overwrite */
  set?: Record<string, string> | undefined;
  /** Headers to remove */
  remove?: string[] | undefined;
  /** Headers to rename (oldName -> newName) */
  rename?: Record<string, string> | undefined;
}

/**
 * Logging level for a rule.
 */
export type RuleLoggingLevel = 'none' | 'minimal' | 'headers' | 'full';

/**
 * Per-rule logging configuration.
 */
export interface RuleLoggingConfig {
  /** Logging level for this rule */
  level: RuleLoggingLevel;
  /** Sampling rate (0.0 to 1.0, default: 1.0) */
  samplingRate?: number | undefined;
  /** Log only these status codes */
  statusCodes?: number[] | undefined;
  /** Log request body for specific content types */
  bodyContentTypes?: string[] | undefined;
  /** Include response headers */
  includeResponseHeaders?: boolean | undefined;
}

/**
 * gRPC-specific rule configuration.
 */
export interface GrpcRuleConfig {
  /**
   * Allowed gRPC services (e.g., ["myapp.UserService", "myapp.OrderService"]).
   * Supports wildcards (e.g., "myapp.*" matches all services in myapp package).
   */
  services?: string[] | undefined;
  /**
   * Allowed gRPC methods in full format (e.g., ["myapp.UserService/GetUser"]).
   * More specific than services - use for fine-grained control.
   */
  methods?: string[] | undefined;
  /**
   * Allow gRPC server reflection API (grpc.reflection.v1alpha.ServerReflection).
   * Default: false for security.
   */
  allowReflection?: boolean | undefined;
  /**
   * Allow gRPC health check service (grpc.health.v1.Health).
   * Default: true.
   */
  allowHealthCheck?: boolean | undefined;
  /**
   * Maximum message size in bytes for this rule.
   * Overrides global setting.
   */
  maxMessageSize?: number | undefined;
  /**
   * Maximum concurrent streams per connection for this rule.
   */
  maxConcurrentStreams?: number | undefined;
  /**
   * Separate rate limit for streaming RPCs (requests per minute).
   */
  streamingRateLimit?: number | undefined;
}

export interface AllowlistRule {
  /** Unique identifier for the rule */
  id: string;
  /** Domain to match (exact match or wildcard like *.example.com) */
  domain: string;
  /** Path patterns to allow (glob patterns supported) */
  paths?: string[] | undefined;
  /** HTTP methods to allow */
  methods?: string[] | undefined;
  /** Rate limiting configuration */
  rateLimit?: RateLimitConfig | undefined;
  /** Optional description */
  description?: string | undefined;
  /** Whether the rule is enabled (default: true) */
  enabled?: boolean | undefined;
  /** Client IPs this rule applies to (CIDR notation supported) */
  clientIps?: string[] | undefined;
  /** Client IPs to exclude from this rule */
  excludeClientIps?: string[] | undefined;
  /** Request header transformations */
  requestHeaders?: HeaderTransform | undefined;
  /** Response header transformations */
  responseHeaders?: HeaderTransform | undefined;
  /** Per-rule logging configuration */
  logging?: RuleLoggingConfig | undefined;
  /** gRPC-specific configuration */
  grpc?: GrpcRuleConfig | undefined;
}

export type AllowlistMode = 'strict' | 'permissive';
export type DefaultAction = 'allow' | 'deny';

/**
 * User-explicit blocklist. Always wins, even over allow rules.
 */
export interface BlockConfig {
  /** Hostnames to block (exact or *.domain.com / **.domain.com wildcards) */
  domains?: string[] | undefined;
  /** Destination IP ranges to block (CIDR) */
  ipRanges?: string[] | undefined;
}

/**
 * Safe-defaults policy attached to a config by applySafeDefaults().
 * Internal field — not loaded from user JSON/YAML directly.
 */
export interface SafeDefaultsConfig {
  enabled: boolean;
  ipRanges: readonly string[];
  domains: readonly string[];
  httpsOnly: boolean;
}

export interface AllowlistConfig {
  /** Operating mode: strict (deny by default) or permissive (allow by default) */
  mode: AllowlistMode;
  /** Default action when no rule matches */
  defaultAction: DefaultAction;
  /** List of allowlist rules */
  rules: AllowlistRule[];
  /** User-explicit blocks (always apply, override allow rules) */
  block?: BlockConfig | undefined;
  /** Safe-default blocks (overridden by user allow rules; on by default) */
  safeDefaults?: SafeDefaultsConfig | undefined;
}

export interface MatchResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** The rule that matched (if any) */
  matchedRule?: AllowlistRule | undefined;
  /** Reason for the decision */
  reason: string;
}

export interface RequestInfo {
  /** Target host/domain */
  host: string;
  /** Target port */
  port: number;
  /**
   * URL scheme of the upstream connection, when known: 'http' for plaintext
   * forward-proxy traffic, 'https' for MITM-decrypted traffic. CONNECT-mode
   * tunnels leave it undefined (the proxy never sees the scheme).
   */
  scheme?: 'http' | 'https' | undefined;
  /** Request path (for MITM mode) */
  path?: string | undefined;
  /** HTTP method (for MITM mode) */
  method?: string | undefined;
  /** Request headers (for MITM mode) */
  headers?: Record<string, string> | undefined;
  /** Source IP address */
  sourceIp?: string | undefined;
  /** gRPC service name (for gRPC requests) */
  grpcService?: string | undefined;
  /** gRPC method name (for gRPC requests) */
  grpcMethod?: string | undefined;
  /** Whether this is a gRPC request */
  isGrpc?: boolean | undefined;
  /** Whether this is a gRPC streaming request */
  isGrpcStreaming?: boolean | undefined;
}
