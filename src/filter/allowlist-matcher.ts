/**
 * Core allowlist matching logic.
 *
 * This module provides the main filtering engine that determines whether
 * HTTP requests should be allowed or denied based on configured rules.
 *
 * @module filter/allowlist-matcher
 */

import picomatch from 'picomatch';
import { promises as dns } from 'node:dns';
import type {
  AllowlistConfig,
  AllowlistRule,
  MatchResult,
  RequestInfo,
} from '../types/allowlist.js';
import { DomainMatcher } from './domain-matcher.js';
import { IpMatcher } from './ip-matcher.js';
import { DomainTrie, createDomainTrie } from './domain-trie.js';

const DNS_CACHE_TTL_MS = 30_000;

/**
 * Normalize a hostname for matching. Strips IPv6 brackets, lowercases, removes
 * a single trailing dot, and rewrites IPv4-mapped IPv6 (`::ffff:169.254.169.254`
 * or `::ffff:a9fe:a9fe`) to its plain IPv4 form so the safe-default IPv4
 * blocklist matches both literal forms.
 *
 * Without the IPv4-mapped collapse, an attacker reaches IMDS via
 * `https://[::ffff:169.254.169.254]/` because the IPv6 host doesn't intersect
 * the IPv4 CIDR rules.
 */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  // Strip IPv6 brackets — matchers expect bare addresses.
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  // Single trailing dot is the FQDN form; resolvers and HTTP stacks accept it.
  if (h.endsWith('.') && !h.endsWith('..')) h = h.slice(0, -1);
  // IPv4-mapped IPv6: dotted-quad form (::ffff:1.2.3.4).
  const dottedMapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(h);
  if (dottedMapped) return dottedMapped[1]!;
  // IPv4-mapped IPv6: hex form (::ffff:a9fe:a9fe).
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1]!, 16);
    const lo = parseInt(hexMapped[2]!, 16);
    if (hi >= 0 && hi <= 0xffff && lo >= 0 && lo <= 0xffff) {
      return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
    }
  }
  // IPv4-compatible IPv6: ::1.2.3.4 (deprecated but still accepted by resolvers).
  const compat = /^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (compat) return compat[1]!;
  return h;
}

function isLiteralIp(host: string): boolean {
  // host is expected to be normalizeHost()'d at the call site.
  if (host.includes(':')) return true;
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
}

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
  /** Domain trie for fast domain lookups */
  private domainTrie: DomainTrie;
  /** Cache of rule IDs indexed by domain for quick access */
  private readonly rulesByDomain: Map<string, AllowlistRule[]>;
  /** Compiled matchers for the user-explicit block list */
  private blockDomainMatchers: DomainMatcher[];
  private blockIpMatcher: IpMatcher | null;
  /** Compiled matchers for the safe-defaults block list */
  private safeDefaultDomainMatchers: DomainMatcher[];
  private safeDefaultIpMatcher: IpMatcher | null;
  /** Brief DNS cache to spare upstream resolvers from per-request load */
  private readonly dnsCache: Map<string, { ips: string[]; expiresAt: number }>;

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
    this.rulesByDomain = new Map();
    this.domainTrie = new DomainTrie();
    this.blockDomainMatchers = [];
    this.blockIpMatcher = null;
    this.safeDefaultDomainMatchers = [];
    this.safeDefaultIpMatcher = null;
    this.dnsCache = new Map();
    this.initializeMatchers();
  }

  /**
   * Pre-compile all domain and path patterns for better performance.
   * Called during construction and when configuration is reloaded.
   */
  private initializeMatchers(): void {
    // Build domain trie for fast lookups
    this.domainTrie = createDomainTrie(this.config.rules);

    for (const rule of this.config.rules) {
      if (rule.enabled === false) continue;

      // Create domain matcher (keep for backward compatibility and edge cases)
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

    // User-explicit blocks
    const block = this.config.block;
    this.blockDomainMatchers = (block?.domains ?? []).map((d) => new DomainMatcher(d));
    this.blockIpMatcher =
      block?.ipRanges && block.ipRanges.length > 0 ? new IpMatcher(block.ipRanges) : null;

    // Safe-default blocks
    const safe = this.config.safeDefaults;
    this.safeDefaultDomainMatchers =
      safe?.enabled && safe.domains.length > 0 ? safe.domains.map((d) => new DomainMatcher(d)) : [];
    this.safeDefaultIpMatcher =
      safe?.enabled && safe.ipRanges.length > 0 ? new IpMatcher([...safe.ipRanges]) : null;

    this.dnsCache.clear();
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
    // Normalize host once so every layer below sees the same canonical form
    // (IPv6 brackets stripped, trailing dot removed, ::ffff:1.2.3.4 mapped
    // to plain IPv4). Without this, ::ffff:169.254.169.254 evades IMDS.
    const normalized: RequestInfo = { ...request, host: normalizeHost(request.host) };

    // 1. User-explicit blocks always win.
    const userBlock = this.matchesUserBlock(normalized);
    if (userBlock) {
      return { allowed: false, reason: userBlock };
    }

    // 2. Allow rules. Use domain trie for fast candidate lookup.
    const candidateRules = this.domainTrie.findMatchingRules(normalized.host);

    if (candidateRules.length > 0) {
      for (const rule of candidateRules) {
        if (rule.enabled === false) continue;
        if (this.matchesRuleDetails(normalized, rule)) {
          return {
            allowed: true,
            matchedRule: rule,
            reason: `Matched rule: ${rule.id}`,
          };
        }
      }
    }

    const enabledRules = this.config.rules.filter((r) => r.enabled !== false);
    for (const rule of enabledRules) {
      if (candidateRules.includes(rule)) continue;
      if (this.matchesRule(normalized, rule)) {
        return {
          allowed: true,
          matchedRule: rule,
          reason: `Matched rule: ${rule.id}`,
        };
      }
    }

    // 3. Safe-default blocks (user allow rules already had their chance above).
    const safeBlock = this.matchesSafeDefault(normalized);
    if (safeBlock) {
      return { allowed: false, reason: safeBlock };
    }

    // 4. Default action.
    const allowed = this.config.defaultAction === 'allow';
    return {
      allowed,
      reason: allowed
        ? 'No rule matched, default action is allow'
        : 'No rule matched, default action is deny',
    };
  }

  /**
   * Return a denial reason if the request hits the user-explicit blocklist,
   * else null.
   */
  private matchesUserBlock(request: RequestInfo): string | null {
    for (const m of this.blockDomainMatchers) {
      if (m.matches(request.host)) {
        return `Blocked by user policy: domain ${request.host}`;
      }
    }
    if (
      this.blockIpMatcher &&
      isLiteralIp(request.host) &&
      this.blockIpMatcher.matches(request.host)
    ) {
      return `Blocked by user policy: IP ${request.host}`;
    }
    return null;
  }

  /**
   * Return a denial reason if the request hits the safe-default blocklist
   * (after allow rules have had their chance), else null.
   */
  private matchesSafeDefault(request: RequestInfo): string | null {
    const safe = this.config.safeDefaults;
    if (!safe?.enabled) return null;

    for (const m of this.safeDefaultDomainMatchers) {
      if (m.matches(request.host)) {
        return `safe-default: blocked metadata/internal hostname ${request.host}`;
      }
    }
    if (this.safeDefaultIpMatcher && isLiteralIp(request.host)) {
      if (this.safeDefaultIpMatcher.matches(request.host)) {
        return `safe-default: blocked private/loopback/link-local IP ${request.host}`;
      }
    }
    if (safe.httpsOnly && request.port === 80) {
      return `safe-default: plain HTTP egress to ${request.host}:80 requires explicit allow`;
    }
    return null;
  }

  /**
   * Resolve a hostname and check the resolved IPs against the safe-default
   * IP blocklist. Used to defend against DNS rebinding (a domain that allow-
   * rules approve but resolves to an internal address).
   *
   * Returns a denial reason if rebinding is detected, else null. Resolution
   * failures are surfaced as "lookup failed"; callers may treat that as
   * deny-fail-closed if appropriate.
   */
  async checkDnsRebinding(host: string): Promise<string | null> {
    const result = await this.resolveAndCheckHost(host);
    return result.kind === 'block' ? result.reason : null;
  }

  /**
   * Resolve a hostname and check the resolved IPs against the safe-default
   * IP blocklist + the user-block IP list. Returns either a block decision
   * or a pinned IP that callers should connect to (rather than re-resolving
   * via the kernel, which is the TOCTOU window an attacker exploits).
   */
  async resolveAndCheckHost(
    host: string,
  ): Promise<
    { kind: 'pass' } | { kind: 'pinned'; ip: string } | { kind: 'block'; reason: string }
  > {
    const normalized = normalizeHost(host);
    if (isLiteralIp(normalized)) return { kind: 'pass' }; // sync match already handled

    let ips: string[];
    const cached = this.dnsCache.get(normalized);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      ips = cached.ips;
    } else {
      try {
        const records = await dns.lookup(normalized, { all: true, verbatim: true });
        ips = records.map((r) => normalizeHost(r.address));
      } catch {
        return { kind: 'pass' }; // upstream connect will surface the error
      }
      // Soft cap to avoid memory growth from probing thousands of distinct
      // hostnames within a single TTL window.
      if (this.dnsCache.size >= 10_000) this.dnsCache.clear();
      this.dnsCache.set(normalized, { ips, expiresAt: now + DNS_CACHE_TTL_MS });
    }

    const safe = this.config.safeDefaults;
    const safeEnabled = !!safe?.enabled && this.safeDefaultIpMatcher !== null;

    for (const ip of ips) {
      if (safeEnabled && this.safeDefaultIpMatcher!.matches(ip)) {
        return {
          kind: 'block',
          reason: `safe-default: DNS rebinding — ${normalized} resolved to blocked IP ${ip}`,
        };
      }
      if (this.blockIpMatcher && this.blockIpMatcher.matches(ip)) {
        return {
          kind: 'block',
          reason: `Blocked by user policy: ${normalized} resolved to blocked IP ${ip}`,
        };
      }
    }

    // Pin the first resolved IP so the caller can connect to a fixed address
    // instead of letting the kernel re-resolve to a different (possibly
    // malicious) record.
    const first = ips[0];
    return first ? { kind: 'pinned', ip: first } : { kind: 'pass' };
  }

  /**
   * Check rule details (path, method, IP) without re-checking domain.
   * Used when domain match is already confirmed via trie.
   */
  private matchesRuleDetails(request: RequestInfo, rule: AllowlistRule): boolean {
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
    this.rulesByDomain.clear();
    this.domainTrie.clear();
    this.blockDomainMatchers = [];
    this.blockIpMatcher = null;
    this.safeDefaultDomainMatchers = [];
    this.safeDefaultIpMatcher = null;
    this.dnsCache.clear();
    this.initializeMatchers();
  }

  /**
   * Get domain trie statistics for monitoring.
   */
  getTrieStats() {
    return this.domainTrie.getStats();
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
