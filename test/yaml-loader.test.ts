import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  detectFormat,
  loadAllowlistConfigFile,
  parseAllowlistConfigYaml,
} from '../src/config/yaml-loader.js';
import { ConfigurationError } from '../src/errors.js';

const VALID_YAML = `
mode: strict
defaultAction: deny
rules:
  - id: anthropic
    domain: api.anthropic.com
    methods: [POST]
  - id: github
    domain: github.com
block:
  domains:
    - evil.com
  ipRanges:
    - 10.0.0.0/8
`;

const VALID_JSON = JSON.stringify({
  mode: 'strict',
  defaultAction: 'deny',
  rules: [
    { id: 'anthropic', domain: 'api.anthropic.com', methods: ['POST'] },
    { id: 'github', domain: 'github.com' },
  ],
  block: {
    domains: ['evil.com'],
    ipRanges: ['10.0.0.0/8'],
  },
});

describe('detectFormat', () => {
  it('detects .yaml as yaml', () => {
    expect(detectFormat('/etc/policy.yaml')).toBe('yaml');
  });

  it('detects .yml as yaml', () => {
    expect(detectFormat('/etc/policy.yml')).toBe('yaml');
  });

  it('detects .json as json', () => {
    expect(detectFormat('/etc/policy.json')).toBe('json');
  });

  it('treats unknown extensions as json', () => {
    expect(detectFormat('/etc/policy')).toBe('json');
    expect(detectFormat('/etc/policy.config')).toBe('json');
  });
});

describe('parseAllowlistConfigYaml', () => {
  it('parses a valid YAML policy', () => {
    const config = parseAllowlistConfigYaml(VALID_YAML);
    expect(config.mode).toBe('strict');
    expect(config.defaultAction).toBe('deny');
    expect(config.rules.length).toBe(2);
    expect(config.block?.domains).toContain('evil.com');
  });

  it('reports YAML parse errors with line/col when available', () => {
    const broken = `
mode: strict
defaultAction: deny
rules:
  - id: a
    domain: foo
   indent_off: true
`;
    expect(() => parseAllowlistConfigYaml(broken, 'policy.yaml')).toThrow(ConfigurationError);
  });

  it('reports schema violations cleanly', () => {
    const bad = `
mode: invalid
defaultAction: deny
rules: []
`;
    expect(() => parseAllowlistConfigYaml(bad)).toThrow();
  });
});

describe('loadAllowlistConfigFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-yaml-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips: YAML and equivalent JSON parse to the same shape', () => {
    const yamlPath = path.join(tmpDir, 'policy.yaml');
    const jsonPath = path.join(tmpDir, 'policy.json');
    fs.writeFileSync(yamlPath, VALID_YAML);
    fs.writeFileSync(jsonPath, VALID_JSON);

    const fromYaml = loadAllowlistConfigFile(yamlPath);
    const fromJson = loadAllowlistConfigFile(jsonPath);
    expect(fromYaml).toEqual(fromJson);
  });

  it('throws when the file is missing', () => {
    expect(() => loadAllowlistConfigFile(path.join(tmpDir, 'nope.yaml'))).toThrow(
      ConfigurationError,
    );
  });

  it('treats .yml as YAML', () => {
    const ymlPath = path.join(tmpDir, 'policy.yml');
    fs.writeFileSync(ymlPath, VALID_YAML);
    const config = loadAllowlistConfigFile(ymlPath);
    expect(config.mode).toBe('strict');
  });
});
