/**
 * Multi-tenant support for the proxy.
 *
 * Provides tenant isolation with separate configurations, rate limits,
 * and metrics per tenant.
 *
 * @module proxy/multi-tenant
 */

import type { IncomingMessage } from 'node:http';
import type { AllowlistConfig, AllowlistRule } from '../types/allowlist.js';
import type { Logger } from '../logging/logger.js';
import { createAllowlistMatcher, type AllowlistMatcher } from '../filter/allowlist-matcher.js';
import { createRateLimiter, type RateLimiter } from '../filter/rate-limiter.js';

/**
 * Tenant configuration.
 */
export interface TenantConfig {
  /** Tenant unique identifier */
  id: string;
  /** Tenant name */
  name: string;
  /** Whether tenant is enabled */
  enabled: boolean;
  /** Allowlist configuration for this tenant */
  allowlist: AllowlistConfig;
  /** Global rate limit for entire tenant (requests per second) */
  globalRateLimit?: number;
  /** Maximum concurrent connections */
  maxConnections?: number;
  /** Metadata */
  metadata?: Record<string, unknown>;
  /** Created timestamp */
  createdAt: number;
  /** Updated timestamp */
  updatedAt: number;
}

/**
 * Tenant extraction method.
 */
export type TenantExtractor = (req: IncomingMessage) => string | null;

/**
 * Built-in tenant extractors.
 */
export const TenantExtractors = {
  /**
   * Extract tenant from X-Tenant-ID header.
   */
  fromHeader(headerName: string = 'x-tenant-id'): TenantExtractor {
    return (req: IncomingMessage) => {
      const value = req.headers[headerName.toLowerCase()];
      return typeof value === 'string' ? value : null;
    };
  },

  /**
   * Extract tenant from API key prefix.
   * Expects format: {tenant}_{key} in Authorization header.
   */
  fromApiKeyPrefix(): TenantExtractor {
    return (req: IncomingMessage) => {
      const auth = req.headers.authorization;
      if (!auth) return null;

      const match = auth.match(/^Bearer\s+([^_]+)_/i);
      return match?.[1] ?? null;
    };
  },

  /**
   * Extract tenant from subdomain.
   * E.g., tenant1.proxy.example.com -> tenant1
   */
  fromSubdomain(baseDomain: string): TenantExtractor {
    return (req: IncomingMessage) => {
      const host = req.headers.host;
      if (!host) return null;

      const hostname = host.split(':')[0];
      if (!hostname.endsWith(baseDomain)) return null;

      const subdomain = hostname.slice(0, -(baseDomain.length + 1));
      return subdomain || null;
    };
  },

  /**
   * Extract tenant from URL path prefix.
   * E.g., /tenant1/api/... -> tenant1
   */
  fromPathPrefix(): TenantExtractor {
    return (req: IncomingMessage) => {
      const url = req.url;
      if (!url) return null;

      const match = url.match(/^\/([^/]+)/);
      return match?.[1] ?? null;
    };
  },

  /**
   * Combine multiple extractors, returning first match.
   */
  combine(...extractors: TenantExtractor[]): TenantExtractor {
    return (req: IncomingMessage) => {
      for (const extractor of extractors) {
        const tenantId = extractor(req);
        if (tenantId) return tenantId;
      }
      return null;
    };
  },
};

/**
 * Multi-tenant manager configuration.
 */
export interface MultiTenantConfig {
  /** Logger instance */
  logger: Logger;
  /** Tenant extractor function */
  tenantExtractor: TenantExtractor;
  /** Default tenant ID for unidentified requests (optional) */
  defaultTenantId?: string;
  /** Whether to reject requests from unknown tenants */
  rejectUnknownTenants?: boolean;
  /** Initial tenant configurations */
  tenants?: TenantConfig[];
}

/**
 * Tenant context for a request.
 */
export interface TenantContext {
  /** Tenant ID */
  id: string;
  /** Tenant configuration */
  config: TenantConfig;
  /** Tenant's allowlist matcher */
  allowlistMatcher: AllowlistMatcher;
  /** Tenant's rate limiter */
  rateLimiter: RateLimiter;
}

/**
 * Tenant resolution result.
 */
export interface TenantResolutionResult {
  /** Whether tenant was resolved */
  resolved: boolean;
  /** Tenant context if resolved */
  context?: TenantContext;
  /** Error message if not resolved */
  error?: string;
}

/**
 * Tenant statistics.
 */
export interface TenantStats {
  id: string;
  name: string;
  enabled: boolean;
  rulesCount: number;
  activeConnections: number;
  totalRequests: number;
  totalBytes: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Multi-tenant manager.
 *
 * Manages multiple tenant configurations with isolated allowlists,
 * rate limits, and metrics.
 *
 * @example
 * ```typescript
 * const manager = new MultiTenantManager({
 *   logger,
 *   tenantExtractor: TenantExtractors.fromHeader('x-tenant-id'),
 *   rejectUnknownTenants: true,
 * });
 *
 * // Add a tenant
 * manager.addTenant({
 *   id: 'tenant-1',
 *   name: 'Tenant 1',
 *   enabled: true,
 *   allowlist: { rules: [...] },
 * });
 *
 * // Resolve tenant from request
 * const result = manager.resolveTenant(req);
 * if (!result.resolved) {
 *   return sendError(403, result.error);
 * }
 *
 * // Use tenant context
 * const { allowlistMatcher, rateLimiter } = result.context;
 * ```
 */
export class MultiTenantManager {
  private readonly config: Required<Omit<MultiTenantConfig, 'tenants' | 'defaultTenantId'>> &
    Pick<MultiTenantConfig, 'defaultTenantId'>;
  private readonly tenants: Map<string, TenantContext> = new Map();
  private readonly tenantStats: Map<string, { activeConnections: number; totalRequests: number; totalBytes: number }> = new Map();

  constructor(config: MultiTenantConfig) {
    this.config = {
      logger: config.logger,
      tenantExtractor: config.tenantExtractor,
      defaultTenantId: config.defaultTenantId,
      rejectUnknownTenants: config.rejectUnknownTenants ?? true,
    };

    // Initialize any provided tenants
    if (config.tenants) {
      for (const tenantConfig of config.tenants) {
        this.addTenant(tenantConfig);
      }
    }
  }

  /**
   * Resolve tenant from a request.
   */
  resolveTenant(req: IncomingMessage): TenantResolutionResult {
    // Extract tenant ID from request
    let tenantId = this.config.tenantExtractor(req);

    // Fall back to default tenant if configured
    if (!tenantId && this.config.defaultTenantId) {
      tenantId = this.config.defaultTenantId;
    }

    if (!tenantId) {
      if (this.config.rejectUnknownTenants) {
        return { resolved: false, error: 'Tenant not identified' };
      }
      return { resolved: false, error: 'Tenant not identified' };
    }

    const context = this.tenants.get(tenantId);
    if (!context) {
      return { resolved: false, error: `Unknown tenant: ${tenantId}` };
    }

    if (!context.config.enabled) {
      return { resolved: false, error: `Tenant disabled: ${tenantId}` };
    }

    return { resolved: true, context };
  }

  /**
   * Add or update a tenant.
   */
  addTenant(tenantConfig: Omit<TenantConfig, 'createdAt' | 'updatedAt'> & Partial<Pick<TenantConfig, 'createdAt' | 'updatedAt'>>): void {
    const now = Date.now();
    const existing = this.tenants.get(tenantConfig.id);

    const config: TenantConfig = {
      ...tenantConfig,
      createdAt: existing?.config.createdAt ?? tenantConfig.createdAt ?? now,
      updatedAt: now,
    };

    const allowlistMatcher = createAllowlistMatcher(config.allowlist);
    const rateLimiter = createRateLimiter(config.allowlist.rules);

    const context: TenantContext = {
      id: config.id,
      config,
      allowlistMatcher,
      rateLimiter,
    };

    this.tenants.set(config.id, context);

    // Initialize stats if new tenant
    if (!this.tenantStats.has(config.id)) {
      this.tenantStats.set(config.id, {
        activeConnections: 0,
        totalRequests: 0,
        totalBytes: 0,
      });
    }

    this.config.logger.info(
      { tenantId: config.id, name: config.name },
      existing ? 'Tenant updated' : 'Tenant added'
    );
  }

  /**
   * Remove a tenant.
   */
  removeTenant(tenantId: string): boolean {
    const existed = this.tenants.delete(tenantId);
    if (existed) {
      this.tenantStats.delete(tenantId);
      this.config.logger.info({ tenantId }, 'Tenant removed');
    }
    return existed;
  }

  /**
   * Get a tenant context by ID.
   */
  getTenant(tenantId: string): TenantContext | undefined {
    return this.tenants.get(tenantId);
  }

  /**
   * Get tenant configuration by ID.
   */
  getTenantConfig(tenantId: string): TenantConfig | undefined {
    return this.tenants.get(tenantId)?.config;
  }

  /**
   * Update tenant configuration.
   */
  updateTenant(tenantId: string, updates: Partial<Omit<TenantConfig, 'id' | 'createdAt' | 'updatedAt'>>): boolean {
    const existing = this.tenants.get(tenantId);
    if (!existing) return false;

    const newConfig: TenantConfig = {
      ...existing.config,
      ...updates,
      id: tenantId, // Preserve ID
      updatedAt: Date.now(),
    };

    this.addTenant(newConfig);
    return true;
  }

  /**
   * Enable or disable a tenant.
   */
  setTenantEnabled(tenantId: string, enabled: boolean): boolean {
    return this.updateTenant(tenantId, { enabled });
  }

  /**
   * Update tenant allowlist rules.
   */
  updateTenantRules(tenantId: string, rules: AllowlistRule[]): boolean {
    const existing = this.tenants.get(tenantId);
    if (!existing) return false;

    const newAllowlist: AllowlistConfig = {
      ...existing.config.allowlist,
      rules,
    };

    return this.updateTenant(tenantId, { allowlist: newAllowlist });
  }

  /**
   * Add a rule to a tenant.
   */
  addTenantRule(tenantId: string, rule: AllowlistRule): boolean {
    const existing = this.tenants.get(tenantId);
    if (!existing) return false;

    const rules = [...existing.config.allowlist.rules, rule];
    return this.updateTenantRules(tenantId, rules);
  }

  /**
   * Remove a rule from a tenant.
   */
  removeTenantRule(tenantId: string, ruleId: string): boolean {
    const existing = this.tenants.get(tenantId);
    if (!existing) return false;

    const rules = existing.config.allowlist.rules.filter((r) => r.id !== ruleId);
    return this.updateTenantRules(tenantId, rules);
  }

  /**
   * List all tenants.
   */
  listTenants(): TenantConfig[] {
    return Array.from(this.tenants.values()).map((t) => t.config);
  }

  /**
   * Get tenant count.
   */
  getTenantCount(): number {
    return this.tenants.size;
  }

  /**
   * Record a request for a tenant.
   */
  recordRequest(tenantId: string, bytes: number = 0): void {
    const stats = this.tenantStats.get(tenantId);
    if (stats) {
      stats.totalRequests++;
      stats.totalBytes += bytes;
    }
  }

  /**
   * Increment active connections for a tenant.
   */
  incrementConnections(tenantId: string): boolean {
    const context = this.tenants.get(tenantId);
    const stats = this.tenantStats.get(tenantId);

    if (!context || !stats) return false;

    // Check max connections limit
    if (context.config.maxConnections !== undefined &&
        stats.activeConnections >= context.config.maxConnections) {
      return false;
    }

    stats.activeConnections++;
    return true;
  }

  /**
   * Decrement active connections for a tenant.
   */
  decrementConnections(tenantId: string): void {
    const stats = this.tenantStats.get(tenantId);
    if (stats) {
      stats.activeConnections = Math.max(0, stats.activeConnections - 1);
    }
  }

  /**
   * Get statistics for all tenants.
   */
  getAllStats(): TenantStats[] {
    const results: TenantStats[] = [];

    for (const [tenantId, context] of this.tenants) {
      const stats = this.tenantStats.get(tenantId);

      results.push({
        id: tenantId,
        name: context.config.name,
        enabled: context.config.enabled,
        rulesCount: context.config.allowlist.rules.length,
        activeConnections: stats?.activeConnections ?? 0,
        totalRequests: stats?.totalRequests ?? 0,
        totalBytes: stats?.totalBytes ?? 0,
        createdAt: context.config.createdAt,
        updatedAt: context.config.updatedAt,
      });
    }

    return results;
  }

  /**
   * Get statistics for a single tenant.
   */
  getTenantStats(tenantId: string): TenantStats | null {
    const context = this.tenants.get(tenantId);
    if (!context) return null;

    const stats = this.tenantStats.get(tenantId);

    return {
      id: tenantId,
      name: context.config.name,
      enabled: context.config.enabled,
      rulesCount: context.config.allowlist.rules.length,
      activeConnections: stats?.activeConnections ?? 0,
      totalRequests: stats?.totalRequests ?? 0,
      totalBytes: stats?.totalBytes ?? 0,
      createdAt: context.config.createdAt,
      updatedAt: context.config.updatedAt,
    };
  }

  /**
   * Check if a tenant exists.
   */
  hasTenant(tenantId: string): boolean {
    return this.tenants.has(tenantId);
  }

  /**
   * Clear all tenants.
   */
  clearAllTenants(): void {
    this.tenants.clear();
    this.tenantStats.clear();
    this.config.logger.info('All tenants cleared');
  }
}

/**
 * Create a multi-tenant manager.
 */
export function createMultiTenantManager(config: MultiTenantConfig): MultiTenantManager {
  return new MultiTenantManager(config);
}
