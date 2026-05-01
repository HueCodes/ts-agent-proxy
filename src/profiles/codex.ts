/**
 * Profile for OpenAI Codex CLI.
 *
 * The Codex CLI is open source; this allowlist is derived from its source
 * tree (network calls + the package managers a typical session reaches for).
 */

import type { Profile } from './types.js';

export const profile: Profile = {
  name: 'codex',
  description: 'Curated allowlist for the OpenAI Codex CLI',
  allowlist: [
    // OpenAI API
    { id: 'openai-api', domain: 'api.openai.com' },
    { id: 'openai-cdn', domain: 'cdn.openai.com' },

    // GitHub
    { id: 'github-com', domain: 'github.com' },
    { id: 'github-api', domain: 'api.github.com' },
    { id: 'github-raw', domain: 'raw.githubusercontent.com' },
    { id: 'github-objects', domain: 'objects.githubusercontent.com' },
    { id: 'github-codeload', domain: 'codeload.github.com' },

    // Package managers
    { id: 'npm-registry', domain: 'registry.npmjs.org' },
    { id: 'npm-cdn', domain: '*.npmjs.org' },
    { id: 'pypi', domain: 'pypi.org' },
    { id: 'pypi-files', domain: 'files.pythonhosted.org' },
    { id: 'crates-io', domain: 'crates.io' },
    { id: 'crates-static', domain: 'static.crates.io' },
    { id: 'go-proxy', domain: 'proxy.golang.org' },
    { id: 'go-sum', domain: 'sum.golang.org' },
  ],
};
