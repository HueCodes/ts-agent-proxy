/**
 * Core allowlist matching logic.
 *
 * This module provides the main filtering engine that determines whether
 * HTTP requests should be allowed or denied based on configured rules.
 *
 * @module filter/allowlist-matcher
 */

import picomatch from 'picomatch';
import type {
  AllowlistConfig,
  AllowlistRule,
  MatchResult,
  RequestInfo,
} from '../types/allowlist.js';
import { DomainMatcher } from './domain-matcher.js';
import { IpMatcher } from './ip-matcher.js';

/**
 * Allowlist matcher that determines whether requests are permitted.
 *
 * The matcher supports:
 * - Domain matching with wildcards (*.example.com, **.example.com)
 * - Path matching with glob patterns (/api/**, /users/*)
 * - HTTP method filtering (GET, POST, etc.)
 * - Client IP filtering with CIDR support (192.168.0.0/24)
 *
 * Rules are evaluated in order. The first matching rule determines the result.
 * If no rule matches, the default action from configuration is applied.
 *
 * @example
 * ```typescript
 * const matcher = new AllowlistMatcher({
 *   mode: 'strict',
 *   defaultAction: 'deny',
 *   rules: [
 *     { id: 'api', domain: 'api.example.com', paths: ['/v1/**'], methods: ['GET', 'POST'] }
 *   ]
 * });
 *
 * const result = matcher.match({ host: 'api.example.com', port: 443, path: '/v1/users', method: 'GET' });
 * console.log(result.allowed); // true
 * ```
 */
export class AllowlistMatcher {
  private config: AllowlistConfig;
  private readonly domainMatchers: Map<string, DomainMatcher>;
  private readonly pathMatchers: Map<string, picomatch.Matcher>;
  private readonly clientIpMatchers: Map<string, IpMatcher>;
  private readonly excludeIpMatchers: Map<string, IpMatcher>;

  /**
   * Creates a new AllowlistMatcher.
   *
   * @param config - The allowlist configuration containing rules and default action
   */
  constructor(config: AllowlistConfig) {
    this.config = config;
    this.domainMatchers = new Map();
    this.pathMatchers = new Map();
    this.clientIpMatchers = new Map();
    this.excludeIpMatchers = new Map();
    this.initializeMatchers();
  }

  /**
   * Pre-compile all domain and path patterns for better performance.
   * Called during construction and when configuration is reloaded.
   */
  private initializeMatchers(): void {
    for (const rule of this.config.rules) {
      if (rule.enabled === false) continue;

      // Create domain matcher
      this.domainMatchers.set(rule.id, new DomainMatcher(rule.domain));

      // Create path matchers if paths are specified
      if (rule.paths && rule.paths.length > 0) {
        const pathMatcher = picomatch(rule.paths, {
          dot: true,
          nocase: true,
        });
        this.pathMatchers.set(rule.id, pathMatcher);
      }

      // Create client IP matchers if specified
      if (rule.clientIps && rule.clientIps.length > 0) {
        this.clientIpMatchers.set(rule.id, new IpMatcher(rule.clientIps));
      }

      // Create exclude IP matchers if specified
      if (rule.excludeClientIps && rule.excludeClientIps.length > 0) {
        this.excludeIpMatchers.set(rule.id, new IpMatcher(rule.excludeClientIps));
      }
    }
  }

  /**
   * Check if a request matches the allowlist rules.
   *
   * Evaluates all enabled rules in order. Returns as soon as a matching rule is found.
   * If no rule matches, returns the default action from configuration.
   *
   * @param request - The request information to match against rules
   * @returns Match result indicating whether the request is allowed and which rule matched
   *
   * @example
   * ```typescript
   * const result = matcher.match({
   *   host: 'api.github.com',
   *   port: 443,
   *   path: '/repos/owner/repo',
   *   method: 'GET'
   * });
   *
   * if (result.allowed) {
   *   console.log(`Allowed by rule: ${result.matchedRule?.id}`);
   * } else {
   *   console.log(`Denied: ${result.reason}`);
   * }
   * ```
   */
  match(request: RequestInfo): MatchResult {
    const enabledRules = this.config.rules.filter((r) => r.enabled !== false);

    for (const rule of enabledRules) {
      if (this.matchesRule(request, rule)) {
        return {
          allowed: true,
          matchedRule: rule,
          reason: `Matched rule: ${rule.id}`,
        };
      }
    }

    // No rule matched - apply default action
    const allowed = this.config.defaultAction === 'allow';
    return {
      allowed,
      reason: allowed
        ? 'No rule matched, default action is allow'
        : 'No rule matched, default action is deny',
    };
  }

  /**
   * Check if a request matches a specific rule.
   *
   * A request matches a rule if:
   * 1. The client IP matches the rule's clientIps (if specified) and is not excluded
   * 2. The domain matches the rule's domain pattern
   * 3. The path matches one of the rule's path patterns (if specified)
   * 4. The HTTP method is in the rule's allowed methods (if specified)
   *
   * @param request - The request to check
   * @param rule - The rule to match against
   * @returns True if the request matches all criteria of the rule
   */
  private matchesRule(request: RequestInfo, rule: AllowlistRule): boolean {
    // Check client IP (if specified)
    if (request.sourceIp) {
      // Check if IP is excluded
      const excludeMatcher = this.excludeIpMatchers.get(rule.id);
      if (excludeMatcher && excludeMatcher.matches(request.sourceIp)) {
        return false;
      }

      // Check if IP is in allowed list (if specified)
      const ipMatcher = this.clientIpMatchers.get(rule.id);
      if (ipMatcher && !ipMatcher.matches(request.sourceIp)) {
        return false;
      }
    }

    // Check domain
    const domainMatcher = this.domainMatchers.get(rule.id);
    if (!domainMatcher || !domainMatcher.matches(request.host)) {
      return false;
    }

    // Check path (if in MITM mode with path info)
    if (request.path && rule.paths && rule.paths.length > 0) {
      const pathMatcher = this.pathMatchers.get(rule.id);
      if (pathMatcher && !pathMatcher(request.path)) {
        return false;
      }
    }

    // Check method (if in MITM mode with method info)
    if (request.method && rule.methods && rule.methods.length > 0) {
      const normalizedMethod = request.method.toUpperCase();
      const allowedMethods = rule.methods.map((m) => m.toUpperCase());
      if (!allowedMethods.includes(normalizedMethod)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get all enabled rules that match a specific domain.
   *
   * Useful for debugging or displaying which rules apply to a domain.
   *
   * @param domain - The domain to find matching rules for
   * @returns Array of rules whose domain patterns match the given domain
   */
  getRulesForDomain(domain: string): AllowlistRule[] {
    return this.config.rules.filter((rule) => {
      if (rule.enabled === false) return false;
      const matcher = this.domainMatchers.get(rule.id);
      return matcher && matcher.matches(domain);
    });
  }

  /**
   * Check if a domain is allowed for CONNECT tunneling mode.
   *
   * This is a convenience method for tunnel mode where only domain-level
   * filtering is possible (no path or method inspection).
   *
   * @param host - The hostname to check
   * @returns Match result for domain-only matching
   *
   * @example
   * ```typescript
   * // In tunnel mode handler
   * const result = matcher.isDomainAllowed('api.github.com');
   * if (!result.allowed) {
   *   socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
   * }
   * ```
   */
  isDomainAllowed(host: string): MatchResult {
    return this.match({ host, port: 443 });
  }

  /**
   * Get the current configuration.
   *
   * @returns The current allowlist configuration
   */
  getConfig(): AllowlistConfig {
    return this.config;
  }

  /**
   * Reload the matcher with new configuration.
   *
   * This clears all cached matchers and recompiles patterns from the new config.
   * Use this for runtime configuration updates without restarting the proxy.
   *
   * @param config - The new allowlist configuration to use
   *
   * @example
   * ```typescript
   * // Watch for config changes
   * fs.watch('allowlist.json', async () => {
   *   const newConfig = await loadConfig('allowlist.json');
   *   matcher.reload(newConfig);
   *   console.log('Configuration reloaded');
   * });
   * ```
   */
  reload(config: AllowlistConfig): void {
    this.config = config;
    this.domainMatchers.clear();
    this.pathMatchers.clear();
    this.clientIpMatchers.clear();
    this.excludeIpMatchers.clear();
    this.initializeMatchers();
  }
}

/**
 * Create an allowlist matcher from configuration.
 *
 * Factory function for creating AllowlistMatcher instances.
 *
 * @param config - The allowlist configuration
 * @returns A new AllowlistMatcher instance
 *
 * @example
 * ```typescript
 * const matcher = createAllowlistMatcher({
 *   mode: 'strict',
 *   defaultAction: 'deny',
 *   rules: [
 *     { id: 'openai', domain: 'api.openai.com', methods: ['POST'] }
 *   ]
 * });
 * ```
 */
export function createAllowlistMatcher(config: AllowlistConfig): AllowlistMatcher {
  return new AllowlistMatcher(config);
}
