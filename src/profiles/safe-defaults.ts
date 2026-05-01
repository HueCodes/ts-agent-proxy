/**
 * Safe defaults that protect every agent run, regardless of profile or policy.
 *
 * These blocks are applied unless --unsafe-disable-defaults is passed. They
 * close the obvious attack surface: cloud metadata services (IMDS), private
 * IP ranges, the loopback adapter, link-local, and the IPv4/IPv6 unspecified
 * addresses. A separate DNS-rebinding check resolves outbound hostnames and
 * compares the resolved IP against the same blocklist, so a domain that
 * points at 169.254.169.254 is denied even if its name passes.
 */

import type { AllowlistConfig } from '../types/allowlist.js';

/**
 * IP ranges blocked by default.
 *
 * RFC1918 + loopback + link-local + ULA + unspecified. Link-local catches
 * IMDS at 169.254.169.254. ULA (fc00::/7) and IPv6 link-local cover the
 * IPv6 equivalents.
 */
export const SAFE_DEFAULT_IP_RANGES: readonly string[] = [
  // Loopback
  '127.0.0.0/8',
  '::1/128',
  // RFC1918 private ranges
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  // Carrier-grade NAT
  '100.64.0.0/10',
  // Link-local (catches IMDS 169.254.169.254 and IPv6 fe80::/10)
  '169.254.0.0/16',
  'fe80::/10',
  // Unique local IPv6
  'fc00::/7',
  // "This network" reserved range (covers 0.0.0.0 itself and the never-route
  // /8 reserved for source-only addressing).
  '0.0.0.0/8',
  '::/128',
];

/**
 * Domain names blocked by default.
 *
 * Cloud metadata DNS endpoints. These resolve to link-local IPs anyway, but
 * blocking them by name avoids the DNS round-trip and produces a clearer
 * audit reason.
 */
export const SAFE_DEFAULT_DOMAINS: readonly string[] = [
  // GCP
  'metadata.google.internal',
  'metadata',
  // Azure
  'metadata.azure.com',
  '*.metadata.azure.com',
  // AWS legacy hostname (current-day uses 169.254.169.254 directly)
  'instance-data',
  'instance-data.ec2.internal',
  // Alibaba Cloud
  '100.100.100.200',
];

/**
 * Settings that drive the safe-defaults policy at request time.
 */
export interface SafeDefaultsPolicy {
  /** Whether safe defaults are active. */
  enabled: boolean;
  /** IP ranges (CIDR) blocked unless explicitly overridden. */
  ipRanges: readonly string[];
  /** Hostnames blocked unless explicitly overridden. */
  domains: readonly string[];
  /**
   * If true, plain HTTP egress to non-allowlisted destinations is denied.
   * Allowlisted destinations may still receive plain HTTP (left to the rule).
   */
  httpsOnly: boolean;
}

/**
 * Build the safe-defaults policy. Pure function — does not mutate config.
 */
export function buildSafeDefaultsPolicy(
  opts: { disabled?: boolean | undefined } = {},
): SafeDefaultsPolicy {
  const enabled = !opts.disabled;
  return {
    enabled,
    ipRanges: enabled ? SAFE_DEFAULT_IP_RANGES : [],
    domains: enabled ? SAFE_DEFAULT_DOMAINS : [],
    httpsOnly: enabled,
  };
}

/**
 * Merge safe defaults into an allowlist config. The returned config carries a
 * `safeDefaults` field that the matcher consults after allow rules — so a
 * user `allow` rule overrides a default-blocked domain, but in the absence of
 * one, the default block fires.
 *
 * User-explicit `block` entries are not touched by this function; they are
 * always honoured, ahead of allow rules.
 */
export function applySafeDefaults(
  config: AllowlistConfig,
  opts: {
    disabled?: boolean | undefined;
    extraBlockDomains?: string[] | undefined;
    extraBlockIpRanges?: string[] | undefined;
  } = {},
): AllowlistConfig {
  const policy = buildSafeDefaultsPolicy({ disabled: opts.disabled });

  const userBlock = config.block ?? {};
  const mergedBlock = {
    domains: [...(userBlock.domains ?? []), ...(opts.extraBlockDomains ?? [])],
    ipRanges: [...(userBlock.ipRanges ?? []), ...(opts.extraBlockIpRanges ?? [])],
  };

  return {
    ...config,
    block:
      mergedBlock.domains.length > 0 || mergedBlock.ipRanges.length > 0 ? mergedBlock : undefined,
    safeDefaults: policy,
  };
}

/**
 * Format the startup banner line that announces what's blocked by default.
 */
export function formatSafeDefaultsBanner(policy: SafeDefaultsPolicy): string {
  if (!policy.enabled) {
    return 'safe defaults DISABLED (--unsafe-disable-defaults). IMDS, RFC1918, and plain-HTTP egress will pass.';
  }
  return `safe defaults active: blocks IMDS/RFC1918/loopback/link-local; HTTPS required for non-allowlisted destinations`;
}
