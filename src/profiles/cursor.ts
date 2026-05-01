/**
 * Profile for Cursor's background agents.
 *
 * Cursor is closed-source; this list reflects the documented endpoints and
 * the LLM provider APIs it can be configured against. Users running Cursor
 * with a self-hosted LLM endpoint will need --allow-domain for that host.
 */

import type { Profile } from './types.js';

export const profile: Profile = {
  name: 'cursor',
  description: "Curated allowlist for Cursor's background agents",
  allowlist: [
    // Cursor's own service endpoints
    { id: 'cursor-sh', domain: '*.cursor.sh' },
    { id: 'cursor-com', domain: '*.cursor.com' },

    // LLM providers Cursor can be configured against
    { id: 'anthropic-api', domain: 'api.anthropic.com' },
    { id: 'openai-api', domain: 'api.openai.com' },

    // GitHub
    { id: 'github-com', domain: 'github.com' },
    { id: 'github-api', domain: 'api.github.com' },
    { id: 'github-raw', domain: 'raw.githubusercontent.com' },
    { id: 'github-objects', domain: 'objects.githubusercontent.com' },

    // Package managers
    { id: 'npm-registry', domain: 'registry.npmjs.org' },
    { id: 'npm-cdn', domain: '*.npmjs.org' },
    { id: 'pypi', domain: 'pypi.org' },
    { id: 'pypi-files', domain: 'files.pythonhosted.org' },
  ],
};
