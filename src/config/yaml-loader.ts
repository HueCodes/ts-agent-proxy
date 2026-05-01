/**
 * YAML loader for allowlist policies.
 *
 * JSON is for machines; humans editing a policy on disk often prefer YAML.
 * This module accepts both — auto-detected by extension — and surfaces
 * line/column information when YAML parsing or schema validation fails.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as yamlParse, YAMLError } from 'yaml';
import { ConfigurationError } from '../errors.js';
import { validateAllowlistConfig } from '../validation/validator.js';
import type { AllowlistConfig } from '../types/allowlist.js';

/**
 * Detect the on-disk format of a config file from its extension.
 * Returns 'yaml' for .yaml / .yml, otherwise 'json'.
 */
export function detectFormat(filePath: string): 'json' | 'yaml' {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.yaml' || ext === '.yml' ? 'yaml' : 'json';
}

/**
 * Parse a YAML allowlist config from a string. Errors carry line/column info
 * when the parser knows them.
 */
export function parseAllowlistConfigYaml(source: string, filePath?: string): AllowlistConfig {
  let data: unknown;
  try {
    data = yamlParse(source, { prettyErrors: true });
  } catch (error) {
    if (error instanceof YAMLError) {
      // YAMLError carries .linePos with start/end {line, col} when known.
      const pos = error.linePos?.[0];
      const where = pos ? `:${pos.line}:${pos.col}` : '';
      throw new ConfigurationError(
        `Invalid YAML${filePath ? ` at ${filePath}${where}` : where}: ${error.message}`,
        filePath,
      );
    }
    throw new ConfigurationError(
      `Invalid YAML: ${error instanceof Error ? error.message : 'Parse error'}`,
      filePath,
    );
  }

  return validateAllowlistConfig(data, filePath);
}

/**
 * Load an allowlist config from disk, auto-detecting JSON vs YAML by
 * extension. The file is read synchronously — this is config-loading at
 * boot, not a hot-path read.
 */
export function loadAllowlistConfigFile(filePath: string): AllowlistConfig {
  let source: string;
  try {
    source = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    throw new ConfigurationError(
      `Failed to read configuration file: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      filePath,
    );
  }

  if (detectFormat(filePath) === 'yaml') {
    return parseAllowlistConfigYaml(source, filePath);
  }
  // JSON path: defer to the existing validator entry point.
  return validateAllowlistConfig(JSON.parse(source) as unknown, filePath);
}
