/**
 * IP address matching with CIDR support.
 *
 * Provides utilities for matching IP addresses against patterns,
 * including CIDR notation for network ranges.
 *
 * @module filter/ip-matcher
 */

/**
 * Parsed CIDR representation.
 */
interface ParsedCidr {
  /** IP address as 32-bit number (IPv4) or BigInt (IPv6) */
  address: number | bigint;
  /** Network mask as 32-bit number (IPv4) or BigInt (IPv6) */
  mask: number | bigint;
  /** Whether this is an IPv6 address */
  isIpv6: boolean;
}

/**
 * IP address matcher supporting CIDR notation.
 *
 * Supports:
 * - Exact IPv4 addresses: `192.168.1.1`
 * - IPv4 CIDR ranges: `192.168.0.0/24`
 * - Exact IPv6 addresses: `::1`, `2001:db8::1`
 * - IPv6 CIDR ranges: `2001:db8::/32`
 *
 * @example
 * ```typescript
 * const matcher = new IpMatcher(['192.168.0.0/24', '10.0.0.1']);
 *
 * matcher.matches('192.168.0.50');   // true
 * matcher.matches('192.168.1.1');    // false
 * matcher.matches('10.0.0.1');       // true
 * ```
 */
export class IpMatcher {
  private readonly patterns: ParsedCidr[];

  /**
   * Creates a new IpMatcher.
   *
   * @param patterns - Array of IP addresses or CIDR ranges
   */
  constructor(patterns: string[]) {
    this.patterns = patterns
      .map((p) => this.parseCidr(p))
      .filter((p): p is ParsedCidr => p !== null);
  }

  /**
   * Check if an IP address matches any of the patterns.
   *
   * @param ip - The IP address to check
   * @returns True if the IP matches any pattern
   */
  matches(ip: string): boolean {
    const parsed = this.parseIp(ip);
    if (parsed === null) return false;

    for (const pattern of this.patterns) {
      if (pattern.isIpv6 !== parsed.isIpv6) continue;

      if (pattern.isIpv6) {
        // IPv6 comparison using BigInt
        const addr = parsed.address as bigint;
        const patternAddr = pattern.address as bigint;
        const mask = pattern.mask as bigint;
        if ((addr & mask) === (patternAddr & mask)) {
          return true;
        }
      } else {
        // IPv4 comparison using number
        const addr = parsed.address as number;
        const patternAddr = pattern.address as number;
        const mask = pattern.mask as number;
        if ((addr & mask) === (patternAddr & mask)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Parse a CIDR notation string.
   */
  private parseCidr(cidr: string): ParsedCidr | null {
    const parts = cidr.split('/');
    const ip = parts[0];
    const prefixStr = parts[1];

    // Determine if IPv4 or IPv6
    const isIpv6 = ip.includes(':');

    // Parse the IP address
    const parsed = this.parseIp(ip);
    if (parsed === null || parsed.isIpv6 !== isIpv6) {
      return null;
    }

    // Parse prefix length
    let prefix: number;
    if (prefixStr !== undefined) {
      prefix = parseInt(prefixStr, 10);
      if (isNaN(prefix)) return null;
      if (isIpv6 && (prefix < 0 || prefix > 128)) return null;
      if (!isIpv6 && (prefix < 0 || prefix > 32)) return null;
    } else {
      // No prefix = exact match
      prefix = isIpv6 ? 128 : 32;
    }

    // Create mask
    let mask: number | bigint;
    if (isIpv6) {
      if (prefix === 0) {
        mask = BigInt(0);
      } else if (prefix === 128) {
        mask = (BigInt(1) << BigInt(128)) - BigInt(1);
      } else {
        mask = ((BigInt(1) << BigInt(128)) - BigInt(1)) ^ ((BigInt(1) << BigInt(128 - prefix)) - BigInt(1));
      }
    } else {
      if (prefix === 0) {
        mask = 0;
      } else if (prefix === 32) {
        mask = 0xffffffff;
      } else {
        mask = (0xffffffff << (32 - prefix)) >>> 0;
      }
    }

    return {
      address: parsed.address,
      mask,
      isIpv6,
    };
  }

  /**
   * Parse an IP address string.
   */
  private parseIp(ip: string): { address: number | bigint; isIpv6: boolean } | null {
    // Check for IPv6
    if (ip.includes(':')) {
      return this.parseIpv6(ip);
    }

    // Parse IPv4
    return this.parseIpv4(ip);
  }

  /**
   * Parse an IPv4 address.
   */
  private parseIpv4(ip: string): { address: number; isIpv6: boolean } | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;

    let address = 0;
    for (const part of parts) {
      const num = parseInt(part, 10);
      if (isNaN(num) || num < 0 || num > 255) return null;
      address = (address << 8) | num;
    }

    return { address: address >>> 0, isIpv6: false };
  }

  /**
   * Parse an IPv6 address.
   */
  private parseIpv6(ip: string): { address: bigint; isIpv6: boolean } | null {
    // Handle IPv4-mapped IPv6 (::ffff:192.168.1.1)
    if (ip.includes('.')) {
      const lastColon = ip.lastIndexOf(':');
      const ipv4Part = ip.substring(lastColon + 1);
      const ipv4 = this.parseIpv4(ipv4Part);
      if (ipv4 === null) return null;

      const prefix = ip.substring(0, lastColon + 1);
      // Replace IPv4 with two hex groups
      const high = (ipv4.address >>> 16) & 0xffff;
      const low = ipv4.address & 0xffff;
      ip = prefix + high.toString(16) + ':' + low.toString(16);
    }

    // Expand :: shorthand
    let expandedIp = ip;
    if (ip.includes('::')) {
      const parts = ip.split('::');
      if (parts.length > 2) return null;

      const left = parts[0] ? parts[0].split(':') : [];
      const right = parts[1] ? parts[1].split(':') : [];
      const missing = 8 - left.length - right.length;

      if (missing < 0) return null;

      const middle = Array(missing).fill('0');
      expandedIp = [...left, ...middle, ...right].join(':');
    }

    // Parse each group
    const groups = expandedIp.split(':');
    if (groups.length !== 8) return null;

    let address = BigInt(0);
    for (const group of groups) {
      if (group.length === 0 || group.length > 4) return null;
      const num = parseInt(group, 16);
      if (isNaN(num) || num < 0 || num > 0xffff) return null;
      address = (address << BigInt(16)) | BigInt(num);
    }

    return { address, isIpv6: true };
  }
}

/**
 * Create an IP matcher from patterns.
 *
 * @param patterns - Array of IP addresses or CIDR ranges
 * @returns New IpMatcher instance
 *
 * @example
 * ```typescript
 * const matcher = createIpMatcher(['192.168.0.0/24', '10.0.0.0/8']);
 * ```
 */
export function createIpMatcher(patterns: string[]): IpMatcher {
  return new IpMatcher(patterns);
}

/**
 * Check if an IP matches any of the given patterns.
 *
 * Convenience function for one-off checks.
 *
 * @param ip - The IP address to check
 * @param patterns - Array of IP addresses or CIDR ranges
 * @returns True if the IP matches any pattern
 *
 * @example
 * ```typescript
 * if (matchesIp('192.168.1.50', ['192.168.0.0/16', '10.0.0.0/8'])) {
 *   console.log('IP is in allowed range');
 * }
 * ```
 */
export function matchesIp(ip: string, patterns: string[]): boolean {
  return new IpMatcher(patterns).matches(ip);
}

/**
 * Check if an IP is in a list and not in an exclusion list.
 *
 * @param ip - The IP address to check
 * @param allowList - Patterns that should match
 * @param excludeList - Patterns that should not match (takes priority)
 * @returns True if IP matches allowList but not excludeList
 *
 * @example
 * ```typescript
 * // Allow 192.168.0.0/24 except 192.168.0.1
 * const allowed = matchesIpWithExclusion(
 *   '192.168.0.50',
 *   ['192.168.0.0/24'],
 *   ['192.168.0.1']
 * );
 * ```
 */
export function matchesIpWithExclusion(
  ip: string,
  allowList?: string[],
  excludeList?: string[]
): boolean {
  // If no allow list, allow all (unless excluded)
  if (!allowList || allowList.length === 0) {
    // If there's an exclude list, check it
    if (excludeList && excludeList.length > 0) {
      return !matchesIp(ip, excludeList);
    }
    return true;
  }

  // Check if in allow list
  if (!matchesIp(ip, allowList)) {
    return false;
  }

  // Check if excluded
  if (excludeList && excludeList.length > 0) {
    return !matchesIp(ip, excludeList);
  }

  return true;
}
