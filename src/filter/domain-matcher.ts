/**
 * Domain matching with wildcard support.
 */

export interface DomainMatcherOptions {
  /** Whether to allow wildcard patterns */
  allowWildcards?: boolean;
  /** Whether matching is case-insensitive (default: true) */
  caseInsensitive?: boolean;
}

export class DomainMatcher {
  private readonly pattern: string;
  private readonly regex: RegExp;
  private readonly options: Required<DomainMatcherOptions>;

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
   */
  matches(domain: string): boolean {
    return this.regex.test(domain);
  }

  /**
   * Get the original pattern.
   */
  getPattern(): string {
    return this.pattern;
  }
}

/**
 * Create a domain matcher from a pattern string.
 */
export function createDomainMatcher(
  pattern: string,
  options?: DomainMatcherOptions
): DomainMatcher {
  return new DomainMatcher(pattern, options);
}

/**
 * Test if a domain matches any of the given patterns.
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
