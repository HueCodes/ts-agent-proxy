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
}
