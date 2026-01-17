/**
 * Header transformation utilities.
 *
 * Provides functions for modifying HTTP headers according to configured rules.
 *
 * @module transform/header-transformer
 */

import type { HeaderTransform } from '../types/allowlist.js';

/**
 * Context for variable substitution in header values.
 */
export interface TransformContext {
  /** Client IP address */
  clientIp?: string;
  /** Matched rule ID */
  ruleId?: string;
  /** Request timestamp (ISO string) */
  timestamp?: string;
  /** Request ID for tracing */
  requestId?: string;
  /** Target host */
  host?: string;
  /** Request path */
  path?: string;
  /** HTTP method */
  method?: string;
}

/**
 * Transform headers according to the given transformation rules.
 *
 * Operations are applied in order:
 * 1. Rename headers (changes header names while preserving values)
 * 2. Remove headers (deletes specified headers)
 * 3. Set headers (adds or overwrites headers with new values)
 *
 * Header names are case-insensitive for matching.
 *
 * @param headers - The headers to transform (modified in place)
 * @param transform - The transformation rules to apply
 * @param context - Optional context for variable substitution
 * @returns The transformed headers
 *
 * @example
 * ```typescript
 * const headers: Record<string, string> = {
 *   'Authorization': 'Bearer token123',
 *   'User-Agent': 'MyApp/1.0',
 *   'X-Old-Header': 'value'
 * };
 *
 * transformHeaders(headers, {
 *   rename: { 'X-Old-Header': 'X-New-Header' },
 *   remove: ['User-Agent'],
 *   set: { 'X-Proxy-By': 'ts-agent-proxy' }
 * });
 *
 * // Result:
 * // {
 * //   'Authorization': 'Bearer token123',
 * //   'X-New-Header': 'value',
 * //   'X-Proxy-By': 'ts-agent-proxy'
 * // }
 * ```
 */
export function transformHeaders(
  headers: Record<string, string | string[] | undefined>,
  transform: HeaderTransform,
  context?: TransformContext
): Record<string, string | string[] | undefined> {
  // Step 1: Rename headers
  if (transform.rename) {
    for (const [oldName, newName] of Object.entries(transform.rename)) {
      const value = getHeader(headers, oldName);
      if (value !== undefined) {
        deleteHeader(headers, oldName);
        headers[newName] = value;
      }
    }
  }

  // Step 2: Remove headers
  if (transform.remove) {
    for (const name of transform.remove) {
      deleteHeader(headers, name);
    }
  }

  // Step 3: Set headers (with variable substitution)
  if (transform.set) {
    for (const [name, value] of Object.entries(transform.set)) {
      headers[name] = substituteVariables(value, context);
    }
  }

  return headers;
}

/**
 * Get a header value case-insensitively.
 *
 * @param headers - The headers object
 * @param name - The header name to find
 * @returns The header value, or undefined if not found
 */
export function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | string[] | undefined {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return value;
    }
  }
  return undefined;
}

/**
 * Delete a header case-insensitively.
 *
 * @param headers - The headers object
 * @param name - The header name to delete
 * @returns True if the header was found and deleted
 */
export function deleteHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): boolean {
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) {
      delete headers[key];
      return true;
    }
  }
  return false;
}

/**
 * Substitute variables in a string.
 *
 * Supports the following variables:
 * - `${clientIp}` - Client IP address
 * - `${ruleId}` - Matched rule ID
 * - `${timestamp}` - Current timestamp (ISO format)
 * - `${requestId}` - Request ID for tracing
 * - `${host}` - Target host
 * - `${path}` - Request path
 * - `${method}` - HTTP method
 *
 * @param value - The string containing variables
 * @param context - The context with variable values
 * @returns The string with variables substituted
 *
 * @example
 * ```typescript
 * const result = substituteVariables(
 *   'Proxied by ${ruleId} at ${timestamp}',
 *   { ruleId: 'api-rule', timestamp: new Date().toISOString() }
 * );
 * // "Proxied by api-rule at 2024-01-15T10:30:00.000Z"
 * ```
 */
export function substituteVariables(
  value: string,
  context?: TransformContext
): string {
  if (!context) return value;

  return value.replace(/\$\{(\w+)\}/g, (match, varName) => {
    switch (varName) {
      case 'clientIp':
        return context.clientIp ?? '';
      case 'ruleId':
        return context.ruleId ?? '';
      case 'timestamp':
        return context.timestamp ?? new Date().toISOString();
      case 'requestId':
        return context.requestId ?? '';
      case 'host':
        return context.host ?? '';
      case 'path':
        return context.path ?? '';
      case 'method':
        return context.method ?? '';
      default:
        return match; // Leave unknown variables as-is
    }
  });
}

/**
 * Create a transform context from request information.
 *
 * @param info - Request information
 * @returns Transform context
 */
export function createTransformContext(info: {
  clientIp?: string;
  ruleId?: string;
  host?: string;
  path?: string;
  method?: string;
  requestId?: string;
}): TransformContext {
  return {
    clientIp: info.clientIp,
    ruleId: info.ruleId,
    timestamp: new Date().toISOString(),
    requestId: info.requestId ?? generateRequestId(),
    host: info.host,
    path: info.path,
    method: info.method,
  };
}

/**
 * Generate a simple request ID.
 *
 * @returns A unique request ID
 */
function generateRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Apply request header transformations from a matched rule.
 *
 * @param headers - Request headers to transform
 * @param transform - Transform rules from the matched rule
 * @param context - Transform context
 * @returns Transformed headers
 */
export function applyRequestTransform(
  headers: Record<string, string | string[] | undefined>,
  transform?: HeaderTransform,
  context?: TransformContext
): Record<string, string | string[] | undefined> {
  if (!transform) return headers;
  return transformHeaders(headers, transform, context);
}

/**
 * Apply response header transformations from a matched rule.
 *
 * @param headers - Response headers to transform
 * @param transform - Transform rules from the matched rule
 * @param context - Transform context
 * @returns Transformed headers
 */
export function applyResponseTransform(
  headers: Record<string, string | string[] | undefined>,
  transform?: HeaderTransform,
  context?: TransformContext
): Record<string, string | string[] | undefined> {
  if (!transform) return headers;
  return transformHeaders(headers, transform, context);
}
