/**
 * Shared types for built-in agent profiles.
 *
 * A profile is a curated allowlist for a specific agent. Picking a profile
 * is meant to replace "configure a proxy" with "pick the agent you're
 * running."
 */

import type { AllowlistRule } from '../types/allowlist.js';

export interface Profile {
  /** Identifier used on the CLI (e.g., 'claude-code') */
  name: string;
  /** One-line description shown in --list-profiles */
  description: string;
  /** Allow rules merged into the policy when this profile is selected */
  allowlist: AllowlistRule[];
}
