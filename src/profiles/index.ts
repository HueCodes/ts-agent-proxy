/**
 * Built-in agent profiles.
 *
 * A profile is a curated allowlist for a specific agent. Pick one with
 * --profile <name>; extend with --allow-domain.
 */

import type { AllowlistConfig, AllowlistRule } from '../types/allowlist.js';
import type { Profile } from './types.js';
import { profile as claudeCode } from './claude-code.js';
import { profile as codex } from './codex.js';
import { profile as cursor } from './cursor.js';
import { profile as genericAgent } from './generic-agent.js';

export type { Profile } from './types.js';
export { applySafeDefaults, formatSafeDefaultsBanner } from './safe-defaults.js';

const profiles: ReadonlyMap<string, Profile> = new Map([
  [claudeCode.name, claudeCode],
  [codex.name, codex],
  [cursor.name, cursor],
  [genericAgent.name, genericAgent],
]);

export function getProfile(name: string): Profile | undefined {
  return profiles.get(name);
}

export function listProfiles(): Profile[] {
  return Array.from(profiles.values());
}

/**
 * Merge a profile's allowlist into an existing AllowlistConfig.
 * Profile rules append after any user rules with id collisions resolved by
 * suffixing — the user's authored rule keeps its id; the profile's gets a
 * `:profile` suffix so audit logs can distinguish them.
 */
export function mergeProfile(config: AllowlistConfig, profile: Profile): AllowlistConfig {
  const existingIds = new Set(config.rules.map((r) => r.id));
  const profileRules: AllowlistRule[] = profile.allowlist.map((r) => {
    if (!existingIds.has(r.id)) return r;
    return { ...r, id: `${r.id}-profile-${profile.name}` };
  });
  return {
    ...config,
    rules: [...config.rules, ...profileRules],
  };
}
