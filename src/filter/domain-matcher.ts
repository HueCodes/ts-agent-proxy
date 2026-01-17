/**
 * Domain matching with wildcard support.
 *
 * This module provides domain pattern matching for the proxy's allowlist system.
 * It supports exact matching and two types of wildcard patterns.
 *
 * @module filter/domain-matcher
 */

/**
 * Configuration options for domain matching behavior.
 */
export interface DomainMatcherOptions {
  /**
   * Whether to allow wildcard patterns in domain matching.
   * When false, all patterns are treated as exact matches.
   * @default true
   */
  allowWildcards?: boolean;

  /**
   * Whether domain matching is case-insensitive.
   * DNS is case-insensitive, so this should usually be true.
   * @default true
   */
  caseInsensitive?: boolean;
}

/**
 * Domain pattern matcher with wildcard support.
 *
 * Supports three types of patterns:
 * - **Exact match**: `api.example.com` matches only `api.example.com`
 * - **Single wildcard**: `*.example.com` matches `foo.example.com` but NOT `bar.foo.example.com`
 * - **Double wildcard**: `**.example.com` matches any subdomain depth like `a.b.c.example.com`
 *
 * Patterns are compiled to RegExp at construction time for efficient repeated matching.
 *
 * @example
 * ```typescript
 * // Exact match
 * const exact = new DomainMatcher('api.github.com');
 * exact.matches('api.github.com');  // true
 * exact.matches('www.github.com');  // false
 *
 * // Single wildcard - one level only
 * const single = new DomainMatcher('*.github.com');
 * single.matches('api.github.com');      // true
 * single.matches('raw.github.com');      // true
 * single.matches('a.b.github.com');      // false (too many levels)
 *
 * // Double wildcard - any depth
 * const multi = new DomainMatcher('**.github.com');
 * multi.matches('api.github.com');       // true
 * multi.matches('a.b.c.github.com');     // true
 * ```
 */
export class DomainMatcher {
  private readonly pattern: string;
  private readonly regex: RegExp;
  private readonly options: Required<DomainMatcherOptions>;

  /**
   * Creates a new DomainMatcher.
   *
   * @param pattern - The domain pattern to match against
   * @param options - Matching options
   */
  constructor(pattern: string, options: DomainMatcherOptions = {}) {
    this.pattern = pattern;
    this.options = {
      allowWildcards: options.allowWildcards ?? true,
      caseInsensitive: options.caseInsensitive ?? true,
    };
    this.regex = this.compilePattern(pattern);
  }

  /**
   * Compile a domain pattern to a RegExp.
   *
   * Supports:
   * - Exact match: "api.example.com"
   * - Wildcard subdomain: "*.example.com" (matches any subdomain)
   * - Double wildcard: "**.example.com" (matches any depth of subdomain)
   */
  private compilePattern(pattern: string): RegExp {
    let regexStr = '^';

    if (this.options.allowWildcards) {
      // Handle different wildcard patterns
      if (pattern.startsWith('**.')) {
        // Double wildcard - matches any depth of subdomain
        // **.example.com matches foo.bar.example.com
        const suffix = pattern.slice(3);
        regexStr += `([a-zA-Z0-9-]+\\.)*${this.escapeRegex(suffix)}`;
      } else if (pattern.startsWith('*.')) {
        // Single wildcard - matches exactly one subdomain level
        // *.example.com matches foo.example.com but not foo.bar.example.com
        const suffix = pattern.slice(2);
        regexStr += `[a-zA-Z0-9-]+\\.${this.escapeRegex(suffix)}`;
      } else {
        // Exact match
        regexStr += this.escapeRegex(pattern);
      }
    } else {
      // No wildcards - exact match only
      regexStr += this.escapeRegex(pattern);
    }

    regexStr += '$';
    const flags = this.options.caseInsensitive ? 'i' : '';
    return new RegExp(regexStr, flags);
  }

  /**
   * Escape special regex characters.
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Test if a domain matches this pattern.
   *
   * @param domain - The domain to test
   * @returns True if the domain matches the pattern
   */
  matches(domain: string): boolean {
    return this.regex.test(domain);
  }

  /**
   * Get the original pattern string.
   *
   * @returns The pattern this matcher was created with
   */
  getPattern(): string {
    return this.pattern;
  }
}

/**
 * Factory function to create a domain matcher.
 *
 * @param pattern - The domain pattern (exact or wildcard)
 * @param options - Matching options
 * @returns A new DomainMatcher instance
 *
 * @example
 * ```typescript
 * const matcher = createDomainMatcher('*.example.com');
 * matcher.matches('api.example.com'); // true
 * ```
 */
export function createDomainMatcher(
  pattern: string,
  options?: DomainMatcherOptions
): DomainMatcher {
  return new DomainMatcher(pattern, options);
}

/**
 * Test if a domain matches any of the given patterns.
 *
 * Convenience function for checking a domain against multiple patterns.
 * Creates new DomainMatcher instances for each check, so for repeated
 * matching, prefer creating matchers once and reusing them.
 *
 * @param domain - The domain to test
 * @param patterns - Array of domain patterns to match against
 * @param options - Matching options applied to all patterns
 * @returns True if the domain matches at least one pattern
 *
 * @example
 * ```typescript
 * const allowed = matchesDomain('api.github.com', [
 *   'api.github.com',
 *   '*.githubusercontent.com'
 * ]);
 * ```
 */
export function matchesDomain(
  domain: string,
  patterns: string[],
  options?: DomainMatcherOptions
): boolean {
  return patterns.some((pattern) =>
    new DomainMatcher(pattern, options).matches(domain)
  );
}
