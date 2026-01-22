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
  set?: Record<string, string>;
  /** Headers to remove */
  remove?: string[];
  /** Headers to rename (oldName -> newName) */
  rename?: Record<string, string>;
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
  samplingRate?: number;
  /** Log only these status codes */
  statusCodes?: number[];
  /** Log request body for specific content types */
  bodyContentTypes?: string[];
  /** Include response headers */
  includeResponseHeaders?: boolean;
}

/**
 * gRPC-specific rule configuration.
 */
export interface GrpcRuleConfig {
  /**
   * Allowed gRPC services (e.g., ["myapp.UserService", "myapp.OrderService"]).
   * Supports wildcards (e.g., "myapp.*" matches all services in myapp package).
   */
  services?: string[];
  /**
   * Allowed gRPC methods in full format (e.g., ["myapp.UserService/GetUser"]).
   * More specific than services - use for fine-grained control.
   */
  methods?: string[];
  /**
   * Allow gRPC server reflection API (grpc.reflection.v1alpha.ServerReflection).
   * Default: false for security.
   */
  allowReflection?: boolean;
  /**
   * Allow gRPC health check service (grpc.health.v1.Health).
   * Default: true.
   */
  allowHealthCheck?: boolean;
  /**
   * Maximum message size in bytes for this rule.
   * Overrides global setting.
   */
  maxMessageSize?: number;
  /**
   * Maximum concurrent streams per connection for this rule.
   */
  maxConcurrentStreams?: number;
  /**
   * Separate rate limit for streaming RPCs (requests per minute).
   */
  streamingRateLimit?: number;
}

export interface AllowlistRule {
  /** Unique identifier for the rule */
  id: string;
  /** Domain to match (exact match or wildcard like *.example.com) */
  domain: string;
  /** Path patterns to allow (glob patterns supported) */
  paths?: string[];
  /** HTTP methods to allow */
  methods?: string[];
  /** Rate limiting configuration */
  rateLimit?: RateLimitConfig;
  /** Optional description */
  description?: string;
  /** Whether the rule is enabled (default: true) */
  enabled?: boolean;
  /** Client IPs this rule applies to (CIDR notation supported) */
  clientIps?: string[];
  /** Client IPs to exclude from this rule */
  excludeClientIps?: string[];
  /** Request header transformations */
  requestHeaders?: HeaderTransform;
  /** Response header transformations */
  responseHeaders?: HeaderTransform;
  /** Per-rule logging configuration */
  logging?: RuleLoggingConfig;
  /** gRPC-specific configuration */
  grpc?: GrpcRuleConfig;
}

export type AllowlistMode = 'strict' | 'permissive';
export type DefaultAction = 'allow' | 'deny';

export interface AllowlistConfig {
  /** Operating mode: strict (deny by default) or permissive (allow by default) */
  mode: AllowlistMode;
  /** Default action when no rule matches */
  defaultAction: DefaultAction;
  /** List of allowlist rules */
  rules: AllowlistRule[];
}

export interface MatchResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** The rule that matched (if any) */
  matchedRule?: AllowlistRule;
  /** Reason for the decision */
  reason: string;
}

export interface RequestInfo {
  /** Target host/domain */
  host: string;
  /** Target port */
  port: number;
  /** Request path (for MITM mode) */
  path?: string;
  /** HTTP method (for MITM mode) */
  method?: string;
  /** Request headers (for MITM mode) */
  headers?: Record<string, string>;
  /** Source IP address */
  sourceIp?: string;
  /** gRPC service name (for gRPC requests) */
  grpcService?: string;
  /** gRPC method name (for gRPC requests) */
  grpcMethod?: string;
  /** Whether this is a gRPC request */
  isGrpc?: boolean;
  /** Whether this is a gRPC streaming request */
  isGrpcStreaming?: boolean;
}
