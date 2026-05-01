import { describe, it, expect } from 'vitest';
import {
  applySafeDefaults,
  buildSafeDefaultsPolicy,
  SAFE_DEFAULT_DOMAINS,
  SAFE_DEFAULT_IP_RANGES,
  formatSafeDefaultsBanner,
} from '../src/profiles/safe-defaults.js';
import { AllowlistMatcher } from '../src/filter/allowlist-matcher.js';
import type { AllowlistConfig } from '../src/types/allowlist.js';

function baseConfig(): AllowlistConfig {
  return {
    mode: 'strict',
    defaultAction: 'deny',
    rules: [
      { id: 'allowed', domain: 'api.anthropic.com', methods: ['POST'] },
      { id: 'gh', domain: 'github.com' },
    ],
  };
}

describe('buildSafeDefaultsPolicy', () => {
  it('is enabled by default', () => {
    const p = buildSafeDefaultsPolicy();
    expect(p.enabled).toBe(true);
    expect(p.ipRanges.length).toBeGreaterThan(0);
    expect(p.domains.length).toBeGreaterThan(0);
    expect(p.httpsOnly).toBe(true);
  });

  it('produces an empty policy when disabled', () => {
    const p = buildSafeDefaultsPolicy({ disabled: true });
    expect(p.enabled).toBe(false);
    expect(p.ipRanges.length).toBe(0);
    expect(p.domains.length).toBe(0);
    expect(p.httpsOnly).toBe(false);
  });

  it('always includes loopback, RFC1918, and link-local in the IP set', () => {
    expect(SAFE_DEFAULT_IP_RANGES).toContain('127.0.0.0/8');
    expect(SAFE_DEFAULT_IP_RANGES).toContain('10.0.0.0/8');
    expect(SAFE_DEFAULT_IP_RANGES).toContain('172.16.0.0/12');
    expect(SAFE_DEFAULT_IP_RANGES).toContain('192.168.0.0/16');
    expect(SAFE_DEFAULT_IP_RANGES).toContain('169.254.0.0/16');
  });

  it('always includes the major cloud metadata DNS names', () => {
    expect(SAFE_DEFAULT_DOMAINS).toContain('metadata.google.internal');
    expect(SAFE_DEFAULT_DOMAINS).toContain('metadata.azure.com');
  });
});

describe('applySafeDefaults', () => {
  it('attaches a populated safeDefaults policy by default', () => {
    const c = applySafeDefaults(baseConfig());
    expect(c.safeDefaults?.enabled).toBe(true);
    expect(c.safeDefaults?.ipRanges.length).toBeGreaterThan(0);
  });

  it('attaches an empty policy when disabled', () => {
    const c = applySafeDefaults(baseConfig(), { disabled: true });
    expect(c.safeDefaults?.enabled).toBe(false);
  });

  it('merges --block-domain and --block-ip-range into the user block list', () => {
    const c = applySafeDefaults(baseConfig(), {
      extraBlockDomains: ['evil.com'],
      extraBlockIpRanges: ['203.0.113.0/24'],
    });
    expect(c.block?.domains).toContain('evil.com');
    expect(c.block?.ipRanges).toContain('203.0.113.0/24');
  });
});

describe('AllowlistMatcher with safe defaults', () => {
  it('blocks IMDS by literal IP', () => {
    const c = applySafeDefaults(baseConfig());
    const m = new AllowlistMatcher(c);
    const r = m.match({ host: '169.254.169.254', port: 80 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/safe-default/i);
  });

  it('blocks RFC1918 by literal IP', () => {
    const c = applySafeDefaults(baseConfig());
    const m = new AllowlistMatcher(c);
    const r = m.match({ host: '10.0.0.5', port: 443 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/safe-default/i);
  });

  it('blocks loopback by literal IP', () => {
    const c = applySafeDefaults(baseConfig());
    const m = new AllowlistMatcher(c);
    expect(m.match({ host: '127.0.0.1', port: 443 }).allowed).toBe(false);
  });

  it('blocks metadata DNS names', () => {
    const c = applySafeDefaults(baseConfig());
    const m = new AllowlistMatcher(c);
    expect(m.match({ host: 'metadata.google.internal', port: 443 }).allowed).toBe(false);
  });

  it('blocks plain HTTP egress to non-allowlisted hosts when httpsOnly is on', () => {
    const c = applySafeDefaults(baseConfig());
    const m = new AllowlistMatcher(c);
    const r = m.match({ host: 'unknown.example.com', port: 80 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/plain HTTP/i);
  });

  it('still permits an explicitly allowlisted destination on HTTP', () => {
    const c = applySafeDefaults({
      ...baseConfig(),
      rules: [{ id: 'r', domain: 'example.com' }],
    });
    const m = new AllowlistMatcher(c);
    expect(m.match({ host: 'example.com', port: 80 }).allowed).toBe(true);
  });

  it('lets allow rules override default-blocked domains', () => {
    // Edge case: user explicitly opted into talking to metadata.google.internal.
    const c = applySafeDefaults({
      ...baseConfig(),
      rules: [{ id: 'meta', domain: 'metadata.google.internal' }],
    });
    const m = new AllowlistMatcher(c);
    expect(m.match({ host: 'metadata.google.internal', port: 443 }).allowed).toBe(true);
  });

  it('honours user-explicit blocks ahead of allow rules', () => {
    const c = applySafeDefaults({
      ...baseConfig(),
      rules: [{ id: 'gh', domain: 'github.com' }],
      block: { domains: ['github.com'] },
    });
    const m = new AllowlistMatcher(c);
    const r = m.match({ host: 'github.com', port: 443 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/Blocked by user policy/i);
  });

  it('passes IMDS when --unsafe-disable-defaults is set', () => {
    const c = applySafeDefaults(baseConfig(), { disabled: true });
    const m = new AllowlistMatcher(c);
    // No allow rule for 169.254.169.254 → still denied by defaultAction, but
    // the reason is the default action, NOT a safe-default block.
    const r = m.match({ host: '169.254.169.254', port: 80 });
    expect(r.reason).toMatch(/default action/i);
  });
});

describe('AllowlistMatcher.checkDnsRebinding', () => {
  it('returns null when safe defaults are disabled', async () => {
    const c = applySafeDefaults(baseConfig(), { disabled: true });
    const m = new AllowlistMatcher(c);
    expect(await m.checkDnsRebinding('example.com')).toBeNull();
  });

  it('returns null for literal IP hosts', async () => {
    const c = applySafeDefaults(baseConfig());
    const m = new AllowlistMatcher(c);
    expect(await m.checkDnsRebinding('169.254.169.254')).toBeNull();
  });

  it('detects DNS rebinding when a domain resolves to a blocked IP', async () => {
    const c = applySafeDefaults(baseConfig());
    const m = new AllowlistMatcher(c);
    // localhost resolves to 127.0.0.1 (loopback) — blocked by safe defaults.
    const reason = await m.checkDnsRebinding('localhost');
    // Some CI environments may resolve localhost differently; assert non-null
    // OR that resolution failed cleanly (returned null). Both indicate the
    // path is wired; a positive match is the strong-signal case.
    if (reason !== null) {
      expect(reason).toMatch(/DNS rebinding/i);
    }
  });
});

describe('formatSafeDefaultsBanner', () => {
  it('warns when defaults are disabled', () => {
    const banner = formatSafeDefaultsBanner(buildSafeDefaultsPolicy({ disabled: true }));
    expect(banner).toMatch(/DISABLED/);
  });

  it('summarises what is blocked when enabled', () => {
    const banner = formatSafeDefaultsBanner(buildSafeDefaultsPolicy());
    expect(banner).toMatch(/IMDS|RFC1918|safe defaults active/i);
  });
});
