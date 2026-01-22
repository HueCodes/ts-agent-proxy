/**
 * Request/Response body transformer.
 *
 * Provides transformations for HTTP request and response bodies
 * including JSON manipulation, text replacement, and header injection.
 *
 * @module proxy/body-transformer
 */

import type { IncomingHttpHeaders } from 'node:http';

/**
 * JSON transformation operation types.
 */
export type JsonOperation =
  | { type: 'set'; path: string; value: unknown }
  | { type: 'delete'; path: string }
  | { type: 'rename'; path: string; newPath: string }
  | { type: 'copy'; path: string; newPath: string }
  | { type: 'move'; path: string; newPath: string };

/**
 * Text replacement operation.
 */
export interface TextReplacement {
  /** Pattern to match (string or regex pattern) */
  pattern: string | RegExp;
  /** Replacement string */
  replacement: string;
  /** Replace all occurrences (default: true) */
  global?: boolean;
}

/**
 * Header transformation operation.
 */
export interface HeaderTransform {
  /** Add header (value can be a function for dynamic values) */
  add?: Record<string, string | (() => string)>;
  /** Remove headers by name */
  remove?: string[];
  /** Rename headers */
  rename?: Record<string, string>;
  /** Override headers (set regardless of existing value) */
  override?: Record<string, string | (() => string)>;
}

/**
 * Body transformation rule.
 */
export interface BodyTransformRule {
  /** Rule identifier */
  id: string;
  /** Apply to request or response */
  direction: 'request' | 'response';
  /** Optional condition to match (host pattern) */
  hostPattern?: string | RegExp;
  /** Optional path pattern to match */
  pathPattern?: string | RegExp;
  /** Optional content-type filter */
  contentTypeFilter?: string | RegExp;
  /** JSON operations */
  jsonOperations?: JsonOperation[];
  /** Text replacements */
  textReplacements?: TextReplacement[];
  /** Header transformations */
  headerTransforms?: HeaderTransform;
  /** Custom transformation function */
  customTransform?: (body: Buffer, context: TransformContext) => Buffer | Promise<Buffer>;
  /** Whether to skip if body is empty */
  skipEmpty?: boolean;
  /** Priority (higher runs first) */
  priority?: number;
}

/**
 * Context passed to transformations.
 */
export interface TransformContext {
  host: string;
  path: string;
  method: string;
  headers: IncomingHttpHeaders;
  statusCode?: number;
  contentType?: string;
}

/**
 * Transformation result.
 */
export interface TransformResult {
  /** Transformed body */
  body: Buffer;
  /** Transformed headers */
  headers: IncomingHttpHeaders;
  /** Applied rules */
  appliedRules: string[];
  /** Whether body was modified */
  bodyModified: boolean;
  /** Whether headers were modified */
  headersModified: boolean;
}

/**
 * Body transformer configuration.
 */
export interface BodyTransformerConfig {
  /** Maximum body size to transform (default: 10MB) */
  maxBodySize?: number;
  /** Transform rules */
  rules?: BodyTransformRule[];
}

/**
 * Body transformer class.
 *
 * Applies transformations to HTTP request and response bodies.
 *
 * @example
 * ```typescript
 * const transformer = new BodyTransformer({
 *   rules: [
 *     {
 *       id: 'add-timestamp',
 *       direction: 'request',
 *       contentTypeFilter: /application\/json/,
 *       jsonOperations: [
 *         { type: 'set', path: 'timestamp', value: Date.now() }
 *       ]
 *     }
 *   ]
 * });
 *
 * const result = await transformer.transform(body, context, 'request');
 * ```
 */
export class BodyTransformer {
  private readonly config: Required<BodyTransformerConfig>;
  private readonly rules: Map<string, BodyTransformRule> = new Map();

  constructor(config: BodyTransformerConfig = {}) {
    this.config = {
      maxBodySize: config.maxBodySize ?? 10 * 1024 * 1024, // 10MB
      rules: config.rules ?? [],
    };

    for (const rule of this.config.rules) {
      this.rules.set(rule.id, rule);
    }
  }

  /**
   * Transform a body.
   */
  async transform(
    body: Buffer,
    context: TransformContext,
    direction: 'request' | 'response'
  ): Promise<TransformResult> {
    const result: TransformResult = {
      body,
      headers: { ...context.headers },
      appliedRules: [],
      bodyModified: false,
      headersModified: false,
    };

    // Check body size
    if (body.length > this.config.maxBodySize) {
      return result;
    }

    // Get applicable rules sorted by priority
    const applicableRules = this.getApplicableRules(context, direction);

    for (const rule of applicableRules) {
      // Skip empty bodies if configured
      if (rule.skipEmpty && result.body.length === 0) {
        continue;
      }

      // Apply header transformations
      if (rule.headerTransforms) {
        const headerResult = this.transformHeaders(result.headers, rule.headerTransforms);
        if (headerResult.modified) {
          result.headers = headerResult.headers;
          result.headersModified = true;
        }
      }

      // Apply JSON operations
      if (rule.jsonOperations && this.isJson(context.contentType)) {
        const jsonResult = this.transformJson(result.body, rule.jsonOperations);
        if (jsonResult.modified) {
          result.body = jsonResult.body;
          result.bodyModified = true;
        }
      }

      // Apply text replacements
      if (rule.textReplacements) {
        const textResult = this.transformText(result.body, rule.textReplacements);
        if (textResult.modified) {
          result.body = textResult.body;
          result.bodyModified = true;
        }
      }

      // Apply custom transformation
      if (rule.customTransform) {
        try {
          const customResult = await rule.customTransform(result.body, context);
          if (!customResult.equals(result.body)) {
            result.body = customResult;
            result.bodyModified = true;
          }
        } catch {
          // Skip custom transform on error
        }
      }

      result.appliedRules.push(rule.id);
    }

    // Update content-length if body was modified
    if (result.bodyModified) {
      result.headers['content-length'] = String(result.body.length);
      result.headersModified = true;
    }

    return result;
  }

  /**
   * Get rules applicable to a context.
   */
  private getApplicableRules(
    context: TransformContext,
    direction: 'request' | 'response'
  ): BodyTransformRule[] {
    const applicable: BodyTransformRule[] = [];

    for (const rule of this.rules.values()) {
      if (rule.direction !== direction) {
        continue;
      }

      // Check host pattern
      if (rule.hostPattern) {
        const pattern = typeof rule.hostPattern === 'string'
          ? new RegExp(rule.hostPattern)
          : rule.hostPattern;
        if (!pattern.test(context.host)) {
          continue;
        }
      }

      // Check path pattern
      if (rule.pathPattern) {
        const pattern = typeof rule.pathPattern === 'string'
          ? new RegExp(rule.pathPattern)
          : rule.pathPattern;
        if (!pattern.test(context.path)) {
          continue;
        }
      }

      // Check content type
      if (rule.contentTypeFilter && context.contentType) {
        const pattern = typeof rule.contentTypeFilter === 'string'
          ? new RegExp(rule.contentTypeFilter)
          : rule.contentTypeFilter;
        if (!pattern.test(context.contentType)) {
          continue;
        }
      }

      applicable.push(rule);
    }

    // Sort by priority (higher first)
    return applicable.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  /**
   * Transform headers.
   */
  private transformHeaders(
    headers: IncomingHttpHeaders,
    transforms: HeaderTransform
  ): { headers: IncomingHttpHeaders; modified: boolean } {
    const result = { ...headers };
    let modified = false;

    // Remove headers
    if (transforms.remove) {
      for (const name of transforms.remove) {
        const lowerName = name.toLowerCase();
        if (lowerName in result) {
          delete result[lowerName];
          modified = true;
        }
      }
    }

    // Rename headers
    if (transforms.rename) {
      for (const [oldName, newName] of Object.entries(transforms.rename)) {
        const lowerOld = oldName.toLowerCase();
        const lowerNew = newName.toLowerCase();
        if (lowerOld in result) {
          result[lowerNew] = result[lowerOld];
          delete result[lowerOld];
          modified = true;
        }
      }
    }

    // Add headers (only if not present)
    if (transforms.add) {
      for (const [name, value] of Object.entries(transforms.add)) {
        const lowerName = name.toLowerCase();
        if (!(lowerName in result)) {
          result[lowerName] = typeof value === 'function' ? value() : value;
          modified = true;
        }
      }
    }

    // Override headers (set regardless)
    if (transforms.override) {
      for (const [name, value] of Object.entries(transforms.override)) {
        const lowerName = name.toLowerCase();
        const newValue = typeof value === 'function' ? value() : value;
        if (result[lowerName] !== newValue) {
          result[lowerName] = newValue;
          modified = true;
        }
      }
    }

    return { headers: result, modified };
  }

  /**
   * Transform JSON body.
   */
  private transformJson(
    body: Buffer,
    operations: JsonOperation[]
  ): { body: Buffer; modified: boolean } {
    try {
      const json = JSON.parse(body.toString('utf-8'));
      let modified = false;

      for (const op of operations) {
        const result = this.applyJsonOperation(json, op);
        if (result) {
          modified = true;
        }
      }

      if (modified) {
        return {
          body: Buffer.from(JSON.stringify(json), 'utf-8'),
          modified: true,
        };
      }
    } catch {
      // Not valid JSON, skip
    }

    return { body, modified: false };
  }

  /**
   * Apply a single JSON operation.
   */
  private applyJsonOperation(obj: any, op: JsonOperation): boolean {
    switch (op.type) {
      case 'set':
        this.setJsonPath(obj, op.path, op.value);
        return true;

      case 'delete':
        return this.deleteJsonPath(obj, op.path);

      case 'rename': {
        const value = this.getJsonPath(obj, op.path);
        if (value !== undefined) {
          this.deleteJsonPath(obj, op.path);
          this.setJsonPath(obj, op.newPath, value);
          return true;
        }
        return false;
      }

      case 'copy': {
        const value = this.getJsonPath(obj, op.path);
        if (value !== undefined) {
          this.setJsonPath(obj, op.newPath, JSON.parse(JSON.stringify(value)));
          return true;
        }
        return false;
      }

      case 'move': {
        const value = this.getJsonPath(obj, op.path);
        if (value !== undefined) {
          this.deleteJsonPath(obj, op.path);
          this.setJsonPath(obj, op.newPath, value);
          return true;
        }
        return false;
      }

      default:
        return false;
    }
  }

  /**
   * Get value at JSON path.
   */
  private getJsonPath(obj: any, path: string): any {
    const parts = path.split('.');
    let current = obj;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      current = current[part];
    }

    return current;
  }

  /**
   * Set value at JSON path.
   */
  private setJsonPath(obj: any, path: string, value: any): void {
    const parts = path.split('.');
    let current = obj;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in current) || current[part] === null) {
        current[part] = {};
      }
      current = current[part];
    }

    current[parts[parts.length - 1]] = value;
  }

  /**
   * Delete value at JSON path.
   */
  private deleteJsonPath(obj: any, path: string): boolean {
    const parts = path.split('.');
    let current = obj;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in current)) {
        return false;
      }
      current = current[part];
    }

    const lastPart = parts[parts.length - 1];
    if (lastPart in current) {
      delete current[lastPart];
      return true;
    }

    return false;
  }

  /**
   * Transform text body.
   */
  private transformText(
    body: Buffer,
    replacements: TextReplacement[]
  ): { body: Buffer; modified: boolean } {
    let text = body.toString('utf-8');
    let modified = false;

    for (const replacement of replacements) {
      const pattern = typeof replacement.pattern === 'string'
        ? new RegExp(replacement.pattern, replacement.global !== false ? 'g' : '')
        : replacement.pattern;

      const newText = text.replace(pattern, replacement.replacement);
      if (newText !== text) {
        text = newText;
        modified = true;
      }
    }

    if (modified) {
      return { body: Buffer.from(text, 'utf-8'), modified: true };
    }

    return { body, modified: false };
  }

  /**
   * Check if content type is JSON.
   */
  private isJson(contentType?: string): boolean {
    if (!contentType) return false;
    return contentType.includes('application/json') ||
           contentType.includes('+json');
  }

  /**
   * Add a transformation rule.
   */
  addRule(rule: BodyTransformRule): void {
    this.rules.set(rule.id, rule);
  }

  /**
   * Remove a transformation rule.
   */
  removeRule(id: string): boolean {
    return this.rules.delete(id);
  }

  /**
   * Get a transformation rule by ID.
   */
  getRule(id: string): BodyTransformRule | undefined {
    return this.rules.get(id);
  }

  /**
   * Get all transformation rules.
   */
  getRules(): BodyTransformRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * Clear all transformation rules.
   */
  clearRules(): void {
    this.rules.clear();
  }
}

/**
 * Create a body transformer.
 */
export function createBodyTransformer(config?: BodyTransformerConfig): BodyTransformer {
  return new BodyTransformer(config);
}
