/**
 * Profile for Anthropic Claude Code CLI.
 *
 * Allowlist derived from observing claude-code's outbound traffic when
 * working through a typical TypeScript repo. Be conservative: if an entry
 * here breaks something, expanding it is one --allow-domain away.
 */

import type { Profile } from './types.js';

export const profile: Profile = {
  name: 'claude-code',
  description: 'Curated allowlist for Anthropic Claude Code CLI',
  allowlist: [
    // Anthropic API (model traffic)
    { id: 'anthropic-api', domain: 'api.anthropic.com' },
    { id: 'anthropic-statsig', domain: 'statsig.anthropic.com' },

    // Claude Code update channel and feedback
    { id: 'claude-ai', domain: '*.claude.ai' },

    // GitHub: source retrieval, gh CLI, raw content
    { id: 'github-com', domain: 'github.com' },
    { id: 'github-api', domain: 'api.github.com' },
    { id: 'github-raw', domain: 'raw.githubusercontent.com' },
    { id: 'github-objects', domain: 'objects.githubusercontent.com' },
    { id: 'github-codeload', domain: 'codeload.github.com' },

    // npm registry + tarball CDN
    { id: 'npm-registry', domain: 'registry.npmjs.org' },
    { id: 'npm-cdn', domain: '*.npmjs.org' },

    // PyPI
    { id: 'pypi', domain: 'pypi.org' },
    { id: 'pypi-files', domain: 'files.pythonhosted.org' },

    // crates.io (Rust)
    { id: 'crates-io', domain: 'crates.io' },
    { id: 'crates-static', domain: 'static.crates.io' },

    // Go module proxy
    { id: 'go-proxy', domain: 'proxy.golang.org' },
    { id: 'go-sum', domain: 'sum.golang.org' },
  ],
};
