/**
 * Dynamic rule management API.
 *
 * Provides RESTful endpoints for managing allowlist rules at runtime.
 *
 * @module admin/rules-api
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '../logging/logger.js';
import type { AllowlistRule, AllowlistConfig } from '../types/allowlist.js';
import type { AllowlistMatcher } from '../filter/allowlist-matcher.js';
import type { RateLimiter } from '../filter/rate-limiter.js';

/**
 * Rules API configuration.
 */
export interface RulesApiConfig {
  /** Logger instance */
  logger: Logger;
  /** Allowlist matcher for rule operations */
  allowlistMatcher: AllowlistMatcher;
  /** Rate limiter for syncing rules */
  rateLimiter: RateLimiter;
  /** Optional callback when rules change */
  onRulesChange?: (rules: AllowlistRule[]) => void;
  /** Optional function to persist rules */
  persistRules?: (config: AllowlistConfig) => Promise<void>;
  /** Maximum rules allowed (default: 10000) */
  maxRules?: number;
}

/**
 * Rule validation result.
 */
export interface RuleValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * API response for rule operations.
 */
export interface RuleApiResponse {
  success: boolean;
  message: string;
  rule?: AllowlistRule;
  rules?: AllowlistRule[];
  count?: number;
  errors?: string[];
}

/**
 * Rules API handler.
 *
 * Provides CRUD operations for allowlist rules:
 * - `GET /api/rules` - List all rules
 * - `GET /api/rules/:id` - Get rule by ID
 * - `POST /api/rules` - Create a new rule
 * - `PUT /api/rules/:id` - Update an existing rule
 * - `DELETE /api/rules/:id` - Delete a rule
 * - `POST /api/rules/validate` - Validate a rule without saving
 * - `POST /api/rules/reload` - Reload rules from config
 * - `POST /api/rules/batch` - Batch create/update/delete operations
 *
 * @example
 * ```typescript
 * const rulesApi = new RulesApi({
 *   logger,
 *   allowlistMatcher,
 *   rateLimiter,
 *   onRulesChange: (rules) => console.log('Rules changed:', rules.length),
 * });
 *
 * // In admin server request handler:
 * if (url.pathname.startsWith('/api/rules')) {
 *   await rulesApi.handleRequest(req, res);
 * }
 * ```
 */
export class RulesApi {
  private readonly config: Required<Omit<RulesApiConfig, 'onRulesChange' | 'persistRules'>> &
    Pick<RulesApiConfig, 'onRulesChange' | 'persistRules'>;

  constructor(config: RulesApiConfig) {
    this.config = {
      ...config,
      maxRules: config.maxRules ?? 10000,
    };
  }

  /**
   * Handle an incoming API request.
   */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const method = req.method?.toUpperCase() ?? 'GET';
    const pathParts = url.pathname.split('/').filter(Boolean);

    // Expected paths: /api/rules, /api/rules/:id, /api/rules/validate, /api/rules/reload, /api/rules/batch
    if (pathParts.length < 2 || pathParts[0] !== 'api' || pathParts[1] !== 'rules') {
      this.sendError(res, 404, 'Not found');
      return;
    }

    const subPath = pathParts[2]; // May be undefined, rule ID, or special action

    try {
      switch (method) {
        case 'GET':
          if (subPath) {
            await this.handleGetRule(req, res, subPath);
          } else {
            await this.handleListRules(req, res, url);
          }
          break;

        case 'POST':
          if (subPath === 'validate') {
            await this.handleValidateRule(req, res);
          } else if (subPath === 'reload') {
            await this.handleReloadRules(req, res);
          } else if (subPath === 'batch') {
            await this.handleBatchOperations(req, res);
          } else if (!subPath) {
            await this.handleCreateRule(req, res);
          } else {
            this.sendError(res, 404, 'Not found');
          }
          break;

        case 'PUT':
          if (subPath) {
            await this.handleUpdateRule(req, res, subPath);
          } else {
            this.sendError(res, 400, 'Rule ID required');
          }
          break;

        case 'DELETE':
          if (subPath) {
            await this.handleDeleteRule(req, res, subPath);
          } else {
            this.sendError(res, 400, 'Rule ID required');
          }
          break;

        default:
          this.sendError(res, 405, 'Method not allowed');
      }
    } catch (error) {
      this.config.logger.error({ error }, 'Rules API error');
      this.sendError(res, 500, 'Internal server error');
    }
  }

  /**
   * Handle GET /api/rules - List all rules.
   */
  private async handleListRules(
    _req: IncomingMessage,
    res: ServerResponse,
    url: URL
  ): Promise<void> {
    const config = this.config.allowlistMatcher.getConfig();
    let rules = config.rules;

    // Apply filters
    const domain = url.searchParams.get('domain');
    const enabled = url.searchParams.get('enabled');
    const tag = url.searchParams.get('tag');

    if (domain) {
      rules = rules.filter((r) =>
        r.domain.toLowerCase().includes(domain.toLowerCase())
      );
    }

    if (enabled !== null) {
      const isEnabled = enabled === 'true';
      rules = rules.filter((r) => (r.enabled ?? true) === isEnabled);
    }

    if (tag) {
      // Filter by description containing the tag (tags not in base type)
      rules = rules.filter((r) => r.description?.toLowerCase().includes(tag.toLowerCase()));
    }

    // Apply pagination
    const page = parseInt(url.searchParams.get('page') ?? '1', 10);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10), 1000);
    const offset = (page - 1) * limit;

    const paginatedRules = rules.slice(offset, offset + limit);

    const response: RuleApiResponse = {
      success: true,
      message: 'Rules retrieved',
      rules: paginatedRules,
      count: rules.length,
    };

    this.sendJson(res, 200, response);
  }

  /**
   * Handle GET /api/rules/:id - Get rule by ID.
   */
  private async handleGetRule(
    _req: IncomingMessage,
    res: ServerResponse,
    ruleId: string
  ): Promise<void> {
    const config = this.config.allowlistMatcher.getConfig();
    const rule = config.rules.find((r) => r.id === ruleId);

    if (!rule) {
      this.sendError(res, 404, `Rule not found: ${ruleId}`);
      return;
    }

    const response: RuleApiResponse = {
      success: true,
      message: 'Rule retrieved',
      rule,
    };

    this.sendJson(res, 200, response);
  }

  /**
   * Handle POST /api/rules - Create a new rule.
   */
  private async handleCreateRule(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req);
    const rule = this.parseRule(body);

    if (!rule) {
      this.sendError(res, 400, 'Invalid rule format');
      return;
    }

    // Validate rule
    const validation = this.validateRule(rule);
    if (!validation.valid) {
      this.sendError(res, 400, 'Rule validation failed', validation.errors);
      return;
    }

    // Check for duplicate ID
    const config = this.config.allowlistMatcher.getConfig();
    if (config.rules.some((r) => r.id === rule.id)) {
      this.sendError(res, 409, `Rule with ID '${rule.id}' already exists`);
      return;
    }

    // Check max rules limit
    if (config.rules.length >= this.config.maxRules) {
      this.sendError(res, 400, `Maximum rules limit (${this.config.maxRules}) reached`);
      return;
    }

    // Add rule
    const newConfig: AllowlistConfig = {
      ...config,
      rules: [...config.rules, rule],
    };

    this.applyConfig(newConfig);
    await this.persistIfConfigured(newConfig);

    this.config.logger.info({ ruleId: rule.id, domain: rule.domain }, 'Rule created');

    const response: RuleApiResponse = {
      success: true,
      message: 'Rule created',
      rule,
    };

    this.sendJson(res, 201, response);
  }

  /**
   * Handle PUT /api/rules/:id - Update an existing rule.
   */
  private async handleUpdateRule(
    req: IncomingMessage,
    res: ServerResponse,
    ruleId: string
  ): Promise<void> {
    const body = await this.readBody(req);
    const updates = this.parseRule(body);

    if (!updates) {
      this.sendError(res, 400, 'Invalid rule format');
      return;
    }

    const config = this.config.allowlistMatcher.getConfig();
    const existingIndex = config.rules.findIndex((r) => r.id === ruleId);

    if (existingIndex === -1) {
      this.sendError(res, 404, `Rule not found: ${ruleId}`);
      return;
    }

    // Merge existing rule with updates (keep ID)
    const updatedRule: AllowlistRule = {
      ...config.rules[existingIndex],
      ...updates,
      id: ruleId, // Preserve original ID
    };

    // Validate updated rule
    const validation = this.validateRule(updatedRule);
    if (!validation.valid) {
      this.sendError(res, 400, 'Rule validation failed', validation.errors);
      return;
    }

    // Update rule
    const newRules = [...config.rules];
    newRules[existingIndex] = updatedRule;

    const newConfig: AllowlistConfig = {
      ...config,
      rules: newRules,
    };

    this.applyConfig(newConfig);
    await this.persistIfConfigured(newConfig);

    this.config.logger.info({ ruleId, domain: updatedRule.domain }, 'Rule updated');

    const response: RuleApiResponse = {
      success: true,
      message: 'Rule updated',
      rule: updatedRule,
    };

    this.sendJson(res, 200, response);
  }

  /**
   * Handle DELETE /api/rules/:id - Delete a rule.
   */
  private async handleDeleteRule(
    _req: IncomingMessage,
    res: ServerResponse,
    ruleId: string
  ): Promise<void> {
    const config = this.config.allowlistMatcher.getConfig();
    const existingIndex = config.rules.findIndex((r) => r.id === ruleId);

    if (existingIndex === -1) {
      this.sendError(res, 404, `Rule not found: ${ruleId}`);
      return;
    }

    // Remove rule
    const newRules = config.rules.filter((r) => r.id !== ruleId);

    const newConfig: AllowlistConfig = {
      ...config,
      rules: newRules,
    };

    this.applyConfig(newConfig);
    await this.persistIfConfigured(newConfig);

    this.config.logger.info({ ruleId }, 'Rule deleted');

    const response: RuleApiResponse = {
      success: true,
      message: 'Rule deleted',
    };

    this.sendJson(res, 200, response);
  }

  /**
   * Handle POST /api/rules/validate - Validate a rule without saving.
   */
  private async handleValidateRule(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req);
    const rule = this.parseRule(body);

    if (!rule) {
      this.sendError(res, 400, 'Invalid rule format');
      return;
    }

    const validation = this.validateRule(rule);

    const response: RuleApiResponse = {
      success: validation.valid,
      message: validation.valid ? 'Rule is valid' : 'Rule validation failed',
      errors: validation.errors.length > 0 ? validation.errors : undefined,
    };

    this.sendJson(res, validation.valid ? 200 : 400, response);
  }

  /**
   * Handle POST /api/rules/reload - Reload rules from external source.
   */
  private async handleReloadRules(
    _req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // This endpoint is a placeholder - actual implementation would
    // depend on the config source (file, database, etc.)
    const response: RuleApiResponse = {
      success: true,
      message: 'Rules reload triggered',
      count: this.config.allowlistMatcher.getConfig().rules.length,
    };

    this.sendJson(res, 200, response);
  }

  /**
   * Handle POST /api/rules/batch - Batch operations.
   */
  private async handleBatchOperations(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req);
    let operations: BatchOperation[];

    try {
      const parsed = JSON.parse(body);
      if (!Array.isArray(parsed.operations)) {
        this.sendError(res, 400, 'Invalid batch format: operations array required');
        return;
      }
      operations = parsed.operations;
    } catch {
      this.sendError(res, 400, 'Invalid JSON');
      return;
    }

    const config = this.config.allowlistMatcher.getConfig();
    let newRules = [...config.rules];
    const results: BatchOperationResult[] = [];

    for (const op of operations) {
      const result = this.executeBatchOperation(op, newRules);
      results.push(result);

      if (result.success && result.rules) {
        newRules = result.rules;
      }
    }

    // Apply all successful changes
    const successCount = results.filter((r) => r.success).length;

    if (successCount > 0) {
      const newConfig: AllowlistConfig = {
        ...config,
        rules: newRules,
      };

      this.applyConfig(newConfig);
      await this.persistIfConfigured(newConfig);
    }

    const response = {
      success: true,
      message: `Batch completed: ${successCount}/${operations.length} operations succeeded`,
      results,
    };

    this.sendJson(res, 200, response);
  }

  /**
   * Execute a single batch operation.
   */
  private executeBatchOperation(
    op: BatchOperation,
    rules: AllowlistRule[]
  ): BatchOperationResult {
    switch (op.operation) {
      case 'create': {
        if (!op.rule) {
          return { operation: 'create', success: false, error: 'Rule required' };
        }
        const validation = this.validateRule(op.rule);
        if (!validation.valid) {
          return { operation: 'create', success: false, error: validation.errors.join(', ') };
        }
        if (rules.some((r) => r.id === op.rule!.id)) {
          return { operation: 'create', success: false, error: 'Duplicate ID' };
        }
        return {
          operation: 'create',
          success: true,
          ruleId: op.rule.id,
          rules: [...rules, op.rule],
        };
      }

      case 'update': {
        if (!op.ruleId || !op.rule) {
          return { operation: 'update', success: false, error: 'Rule ID and updates required' };
        }
        const index = rules.findIndex((r) => r.id === op.ruleId);
        if (index === -1) {
          return { operation: 'update', success: false, error: 'Rule not found' };
        }
        const updatedRule = { ...rules[index], ...op.rule, id: op.ruleId };
        const validation = this.validateRule(updatedRule);
        if (!validation.valid) {
          return { operation: 'update', success: false, error: validation.errors.join(', ') };
        }
        const newRules = [...rules];
        newRules[index] = updatedRule;
        return { operation: 'update', success: true, ruleId: op.ruleId, rules: newRules };
      }

      case 'delete': {
        if (!op.ruleId) {
          return { operation: 'delete', success: false, error: 'Rule ID required' };
        }
        const exists = rules.some((r) => r.id === op.ruleId);
        if (!exists) {
          return { operation: 'delete', success: false, error: 'Rule not found' };
        }
        return {
          operation: 'delete',
          success: true,
          ruleId: op.ruleId,
          rules: rules.filter((r) => r.id !== op.ruleId),
        };
      }

      default:
        return { operation: op.operation, success: false, error: 'Unknown operation' };
    }
  }

  /**
   * Validate a rule.
   */
  validateRule(rule: AllowlistRule): RuleValidationResult {
    const errors: string[] = [];

    if (!rule.id || typeof rule.id !== 'string') {
      errors.push('Rule ID is required and must be a string');
    } else if (!/^[a-zA-Z0-9_-]+$/.test(rule.id)) {
      errors.push('Rule ID must contain only alphanumeric characters, hyphens, and underscores');
    }

    if (!rule.domain || typeof rule.domain !== 'string') {
      errors.push('Domain is required and must be a string');
    }

    if (rule.methods !== undefined) {
      if (!Array.isArray(rule.methods)) {
        errors.push('Methods must be an array');
      } else {
        const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'CONNECT'];
        for (const method of rule.methods) {
          if (!validMethods.includes(method.toUpperCase())) {
            errors.push(`Invalid HTTP method: ${method}`);
          }
        }
      }
    }

    if (rule.paths !== undefined) {
      if (!Array.isArray(rule.paths)) {
        errors.push('Paths must be an array');
      } else {
        for (const path of rule.paths) {
          try {
            new RegExp(path);
          } catch {
            errors.push(`Invalid path regex: ${path}`);
          }
        }
      }
    }

    if (rule.rateLimit !== undefined) {
      if (typeof rule.rateLimit.requestsPerMinute !== 'number' || rule.rateLimit.requestsPerMinute <= 0) {
        errors.push('Rate limit requestsPerMinute must be a positive number');
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Apply configuration changes.
   */
  private applyConfig(config: AllowlistConfig): void {
    this.config.allowlistMatcher.reload(config);
    this.config.rateLimiter.clear();
    this.config.rateLimiter.registerRules(config.rules);

    if (this.config.onRulesChange) {
      this.config.onRulesChange(config.rules);
    }
  }

  /**
   * Persist configuration if configured.
   */
  private async persistIfConfigured(config: AllowlistConfig): Promise<void> {
    if (this.config.persistRules) {
      try {
        await this.config.persistRules(config);
      } catch (error) {
        this.config.logger.error({ error }, 'Failed to persist rules');
      }
    }
  }

  /**
   * Read request body.
   */
  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }

  /**
   * Parse rule from JSON string.
   */
  private parseRule(json: string): AllowlistRule | null {
    try {
      const parsed = JSON.parse(json);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as AllowlistRule;
      }
    } catch {
      // Invalid JSON
    }
    return null;
  }

  /**
   * Send JSON response.
   */
  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  }

  /**
   * Send error response.
   */
  private sendError(res: ServerResponse, status: number, message: string, errors?: string[]): void {
    const response: RuleApiResponse = {
      success: false,
      message,
      errors,
    };
    this.sendJson(res, status, response);
  }
}

/**
 * Batch operation definition.
 */
interface BatchOperation {
  operation: 'create' | 'update' | 'delete';
  ruleId?: string;
  rule?: AllowlistRule;
}

/**
 * Batch operation result.
 */
interface BatchOperationResult {
  operation: string;
  success: boolean;
  ruleId?: string;
  error?: string;
  rules?: AllowlistRule[];
}

/**
 * Create a rules API handler.
 */
export function createRulesApi(config: RulesApiConfig): RulesApi {
  return new RulesApi(config);
}
