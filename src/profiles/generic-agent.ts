/**
 * Profile for generic AI coding agents.
 *
 * The broadest defensible allowlist: the major LLM API endpoints plus the
 * package managers and code hosts every agent reaches for. Use this when
 * no specific profile matches; tighten with --allow-domain or a custom
 * config from there.
 */

import type { Profile } from './types.js';

export const profile: Profile = {
  name: 'generic-agent',
  description: 'Broad defaults for any AI coding agent (LLM APIs + package managers + GitHub)',
  allowlist: [
    // Major LLM provider APIs
    { id: 'anthropic-api', domain: 'api.anthropic.com' },
    { id: 'openai-api', domain: 'api.openai.com' },
    { id: 'google-genai', domain: 'generativelanguage.googleapis.com' },
    { id: 'mistral-api', domain: 'api.mistral.ai' },

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
    { id: 'rubygems', domain: 'rubygems.org' },
    { id: 'maven-central', domain: 'repo1.maven.org' },
  ],
};
