/**
 * Configuration validation utilities.
 * Wraps Zod schemas with user-friendly error formatting.
 */

import { ZodError, type ZodSchema } from 'zod';
import { ConfigurationError } from '../errors.js';
import {
  AllowlistConfigSchema,
  ProxyConfigSchema,
  ServerConfigSchema,
  type AllowlistConfig,
  type ProxyConfig,
  type ServerConfig,
} from './schemas.js';

/**
 * Formats Zod validation errors into a human-readable message.
 * @param error - The Zod validation error
 * @returns Formatted error message
 */
function formatZodError(error: ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.join('.');
    const prefix = path ? `${path}: ` : '';
    return `  - ${prefix}${issue.message}`;
  });

  return `Validation failed:\n${issues.join('\n')}`;
}

/**
 * Validates data against a Zod schema.
 * @param schema - The Zod schema to validate against
 * @param data - The data to validate
 * @param path - Optional path to the configuration (for error messages)
 * @returns The validated and transformed data
 * @throws ConfigurationError if validation fails
 */
function validate<T>(schema: ZodSchema<T>, data: unknown, path?: string): T {
  const result = schema.safeParse(data);

  if (!result.success) {
    const message = formatZodError(result.error);
    throw new ConfigurationError(message, path, result.error.issues);
  }

  return result.data;
}

/**
 * Validates an allowlist configuration.
 *
 * @param config - The allowlist configuration to validate
 * @param path - Optional path to the configuration file
 * @returns The validated allowlist configuration
 * @throws ConfigurationError if validation fails
 *
 * @example
 * ```typescript
 * const config = validateAllowlistConfig({
 *   mode: 'strict',
 *   defaultAction: 'deny',
 *   rules: [{ id: 'api', domain: 'api.example.com' }]
 * });
 * ```
 */
export function validateAllowlistConfig(
  config: unknown,
  path?: string
): AllowlistConfig {
  return validate(AllowlistConfigSchema, config, path);
}

/**
 * Validates a server configuration.
 *
 * @param config - The server configuration to validate
 * @param path - Optional path to the configuration file
 * @returns The validated server configuration
 * @throws ConfigurationError if validation fails
 */
export function validateServerConfig(
  config: unknown,
  path?: string
): ServerConfig {
  return validate(ServerConfigSchema, config, path);
}

/**
 * Validates a complete proxy configuration.
 *
 * @param config - The proxy configuration to validate
 * @param path - Optional path to the configuration file
 * @returns The validated proxy configuration
 * @throws ConfigurationError if validation fails
 *
 * @example
 * ```typescript
 * const config = validateProxyConfig({
 *   server: { host: '0.0.0.0', port: 8080, mode: 'tunnel' },
 *   allowlist: { mode: 'strict', defaultAction: 'deny', rules: [] }
 * });
 * ```
 */
export function validateProxyConfig(
  config: unknown,
  path?: string
): ProxyConfig {
  return validate(ProxyConfigSchema, config, path);
}

/**
 * Safely parses JSON and validates as allowlist configuration.
 *
 * @param json - JSON string to parse
 * @param path - Optional path to the configuration file
 * @returns The validated allowlist configuration
 * @throws ConfigurationError if JSON is invalid or validation fails
 */
export function parseAllowlistConfigJson(
  json: string,
  path?: string
): AllowlistConfig {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    throw new ConfigurationError(
      `Invalid JSON: ${error instanceof Error ? error.message : 'Parse error'}`,
      path
    );
  }

  return validateAllowlistConfig(data, path);
}

/**
 * Safely parses JSON and validates as proxy configuration.
 *
 * @param json - JSON string to parse
 * @param path - Optional path to the configuration file
 * @returns The validated proxy configuration
 * @throws ConfigurationError if JSON is invalid or validation fails
 */
export function parseProxyConfigJson(
  json: string,
  path?: string
): ProxyConfig {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    throw new ConfigurationError(
      `Invalid JSON: ${error instanceof Error ? error.message : 'Parse error'}`,
      path
    );
  }

  return validateProxyConfig(data, path);
}
