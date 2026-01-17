/**
 * Core allowlist matching logic.
 */

import picomatch from 'picomatch';
import type {
  AllowlistConfig,
  AllowlistRule,
  MatchResult,
  RequestInfo,
} from '../types/allowlist.js';
import { DomainMatcher } from './domain-matcher.js';

export class AllowlistMatcher {
  private config: AllowlistConfig;
  private readonly domainMatchers: Map<string, DomainMatcher>;
  private readonly pathMatchers: Map<string, picomatch.Matcher>;

  constructor(config: AllowlistConfig) {
    this.config = config;
    this.domainMatchers = new Map();
    this.pathMatchers = new Map();
    this.initializeMatchers();
  }

  /**
   * Pre-compile all patterns for better performance.
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
    }
  }

  /**
   * Check if a request matches the allowlist.
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
   */
  private matchesRule(request: RequestInfo, rule: AllowlistRule): boolean {
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
   * Get all rules for a specific domain.
   */
  getRulesForDomain(domain: string): AllowlistRule[] {
    return this.config.rules.filter((rule) => {
      if (rule.enabled === false) return false;
      const matcher = this.domainMatchers.get(rule.id);
      return matcher && matcher.matches(domain);
    });
  }

  /**
   * Check if a domain is allowed (for CONNECT tunneling mode).
   * Only checks domain, not path or method.
   */
  isDomainAllowed(host: string): MatchResult {
    return this.match({ host, port: 443 });
  }

  /**
   * Get the current configuration.
   */
  getConfig(): AllowlistConfig {
    return this.config;
  }

  /**
   * Reload configuration.
   */
  reload(config: AllowlistConfig): void {
    this.config = config;
    this.domainMatchers.clear();
    this.pathMatchers.clear();
    this.initializeMatchers();
  }
}

/**
 * Create an allowlist matcher from configuration.
 */
export function createAllowlistMatcher(config: AllowlistConfig): AllowlistMatcher {
  return new AllowlistMatcher(config);
}
