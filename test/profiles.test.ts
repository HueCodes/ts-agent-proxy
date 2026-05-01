import { describe, it, expect } from 'vitest';
import { getProfile, listProfiles, mergeProfile } from '../src/profiles/index.js';
import { profile as claudeCode } from '../src/profiles/claude-code.js';
import { profile as codex } from '../src/profiles/codex.js';
import { profile as cursor } from '../src/profiles/cursor.js';
import { profile as genericAgent } from '../src/profiles/generic-agent.js';
import { AllowlistRuleSchema } from '../src/validation/schemas.js';
import type { AllowlistConfig } from '../src/types/allowlist.js';

const allProfiles = [claudeCode, codex, cursor, genericAgent];

describe('Built-in profiles', () => {
  it.each(allProfiles)('$name has a non-empty allowlist', (p) => {
    expect(p.allowlist.length).toBeGreaterThan(0);
  });

  it.each(allProfiles)('$name uses well-formed rule schemas', (p) => {
    for (const rule of p.allowlist) {
      expect(() => AllowlistRuleSchema.parse(rule)).not.toThrow();
    }
  });

  it.each(allProfiles)('$name has unique rule IDs within itself', (p) => {
    const ids = p.allowlist.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rejects an obviously bogus domain in any profile', () => {
    const seen = new Set<string>();
    for (const p of allProfiles) {
      for (const rule of p.allowlist) {
        // No localhost / IMDS / private addresses leaking through profiles.
        expect(rule.domain).not.toBe('localhost');
        expect(rule.domain).not.toBe('169.254.169.254');
        expect(rule.domain).not.toMatch(/^10\./);
        seen.add(rule.domain);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });
});

describe('Profile registry', () => {
  it('listProfiles returns at least claude-code, codex, cursor, generic-agent', () => {
    const names = listProfiles().map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining(['claude-code', 'codex', 'cursor', 'generic-agent']),
    );
  });

  it('getProfile returns the right profile by name', () => {
    expect(getProfile('claude-code')?.name).toBe('claude-code');
    expect(getProfile('codex')?.name).toBe('codex');
  });

  it('getProfile returns undefined for unknown names', () => {
    expect(getProfile('not-a-real-agent')).toBeUndefined();
  });
});

describe('mergeProfile', () => {
  function emptyConfig(): AllowlistConfig {
    return { mode: 'strict', defaultAction: 'deny', rules: [] };
  }

  it('appends profile rules onto an empty config', () => {
    const merged = mergeProfile(emptyConfig(), claudeCode);
    expect(merged.rules.length).toBe(claudeCode.allowlist.length);
  });

  it('keeps the user rule when an ID collides, suffixes the profile rule', () => {
    const userConfig: AllowlistConfig = {
      mode: 'strict',
      defaultAction: 'deny',
      rules: [{ id: 'github-com', domain: 'private.github.example' }],
    };
    const merged = mergeProfile(userConfig, claudeCode);
    const userRule = merged.rules.find((r) => r.id === 'github-com');
    expect(userRule?.domain).toBe('private.github.example');
    const profileRule = merged.rules.find((r) => r.id.startsWith('github-com-profile'));
    expect(profileRule?.domain).toBe('github.com');
  });

  it('preserves mode and defaultAction', () => {
    const merged = mergeProfile(emptyConfig(), codex);
    expect(merged.mode).toBe('strict');
    expect(merged.defaultAction).toBe('deny');
  });
});
