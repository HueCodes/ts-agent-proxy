import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import {
  MultiTenantManager,
  TenantExtractors,
  createMultiTenantManager,
  type TenantConfig,
} from '../src/proxy/multi-tenant.js';
import type { Logger } from '../src/logging/logger.js';

describe('MultiTenantManager', () => {
  let manager: MultiTenantManager;
  let mockLogger: Logger;

  const createMockRequest = (headers: Record<string, string> = {}, url: string = '/'): IncomingMessage => {
    return {
      headers,
      url,
    } as IncomingMessage;
  };

  const createTenantConfig = (id: string, overrides: Partial<TenantConfig> = {}): Omit<TenantConfig, 'createdAt' | 'updatedAt'> => ({
    id,
    name: `Tenant ${id}`,
    enabled: true,
    allowlist: {
      mode: 'strict',
      defaultAction: 'deny',
      rules: [
        { id: 'default-rule', domain: '*.example.com' },
      ],
    },
    ...overrides,
  });

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as Logger;

    manager = new MultiTenantManager({
      logger: mockLogger,
      tenantExtractor: TenantExtractors.fromHeader('x-tenant-id'),
      rejectUnknownTenants: true,
    });
  });

  describe('tenant resolution', () => {
    it('should resolve tenant from header', () => {
      manager.addTenant(createTenantConfig('tenant-1'));

      const req = createMockRequest({ 'x-tenant-id': 'tenant-1' });
      const result = manager.resolveTenant(req);

      expect(result.resolved).toBe(true);
      expect(result.context?.id).toBe('tenant-1');
    });

    it('should reject unknown tenant', () => {
      const req = createMockRequest({ 'x-tenant-id': 'unknown' });
      const result = manager.resolveTenant(req);

      expect(result.resolved).toBe(false);
      expect(result.error).toContain('Unknown tenant');
    });

    it('should reject disabled tenant', () => {
      manager.addTenant(createTenantConfig('disabled', { enabled: false }));

      const req = createMockRequest({ 'x-tenant-id': 'disabled' });
      const result = manager.resolveTenant(req);

      expect(result.resolved).toBe(false);
      expect(result.error).toContain('disabled');
    });

    it('should use default tenant when configured', () => {
      const managerWithDefault = createMultiTenantManager({
        logger: mockLogger,
        tenantExtractor: TenantExtractors.fromHeader('x-tenant-id'),
        defaultTenantId: 'default',
      });

      managerWithDefault.addTenant(createTenantConfig('default'));

      const req = createMockRequest({}); // No tenant header
      const result = managerWithDefault.resolveTenant(req);

      expect(result.resolved).toBe(true);
      expect(result.context?.id).toBe('default');
    });

    it('should reject requests without tenant when configured', () => {
      const req = createMockRequest({}); // No tenant header
      const result = manager.resolveTenant(req);

      expect(result.resolved).toBe(false);
      expect(result.error).toContain('not identified');
    });
  });

  describe('tenant management', () => {
    it('should add tenant', () => {
      manager.addTenant(createTenantConfig('new-tenant'));

      expect(manager.hasTenant('new-tenant')).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'new-tenant' }),
        'Tenant added'
      );
    });

    it('should update existing tenant', () => {
      manager.addTenant(createTenantConfig('tenant-1', { name: 'Original' }));
      manager.addTenant(createTenantConfig('tenant-1', { name: 'Updated' }));

      const config = manager.getTenantConfig('tenant-1');
      expect(config?.name).toBe('Updated');
    });

    it('should remove tenant', () => {
      manager.addTenant(createTenantConfig('tenant-1'));
      expect(manager.removeTenant('tenant-1')).toBe(true);
      expect(manager.hasTenant('tenant-1')).toBe(false);
    });

    it('should return false when removing non-existent tenant', () => {
      expect(manager.removeTenant('non-existent')).toBe(false);
    });

    it('should update tenant properties', () => {
      manager.addTenant(createTenantConfig('tenant-1', { name: 'Original' }));

      expect(manager.updateTenant('tenant-1', { name: 'Updated' })).toBe(true);
      expect(manager.getTenantConfig('tenant-1')?.name).toBe('Updated');
    });

    it('should enable/disable tenant', () => {
      manager.addTenant(createTenantConfig('tenant-1'));

      manager.setTenantEnabled('tenant-1', false);
      expect(manager.getTenantConfig('tenant-1')?.enabled).toBe(false);

      manager.setTenantEnabled('tenant-1', true);
      expect(manager.getTenantConfig('tenant-1')?.enabled).toBe(true);
    });

    it('should list all tenants', () => {
      manager.addTenant(createTenantConfig('tenant-1'));
      manager.addTenant(createTenantConfig('tenant-2'));

      const tenants = manager.listTenants();
      expect(tenants).toHaveLength(2);
      expect(tenants.map((t) => t.id)).toContain('tenant-1');
      expect(tenants.map((t) => t.id)).toContain('tenant-2');
    });

    it('should get tenant count', () => {
      manager.addTenant(createTenantConfig('tenant-1'));
      manager.addTenant(createTenantConfig('tenant-2'));

      expect(manager.getTenantCount()).toBe(2);
    });

    it('should clear all tenants', () => {
      manager.addTenant(createTenantConfig('tenant-1'));
      manager.addTenant(createTenantConfig('tenant-2'));

      manager.clearAllTenants();
      expect(manager.getTenantCount()).toBe(0);
    });
  });

  describe('rule management', () => {
    it('should update tenant rules', () => {
      manager.addTenant(createTenantConfig('tenant-1'));

      const newRules = [
        { id: 'new-rule', domain: 'api.example.com' },
      ];

      expect(manager.updateTenantRules('tenant-1', newRules)).toBe(true);

      const config = manager.getTenantConfig('tenant-1');
      expect(config?.allowlist.rules).toHaveLength(1);
      expect(config?.allowlist.rules[0].domain).toBe('api.example.com');
    });

    it('should add rule to tenant', () => {
      manager.addTenant(createTenantConfig('tenant-1'));

      expect(manager.addTenantRule('tenant-1', { id: 'added', domain: 'new.com' })).toBe(true);

      const config = manager.getTenantConfig('tenant-1');
      expect(config?.allowlist.rules).toHaveLength(2);
    });

    it('should remove rule from tenant', () => {
      manager.addTenant(createTenantConfig('tenant-1'));

      expect(manager.removeTenantRule('tenant-1', 'default-rule')).toBe(true);

      const config = manager.getTenantConfig('tenant-1');
      expect(config?.allowlist.rules).toHaveLength(0);
    });
  });

  describe('statistics', () => {
    it('should track requests', () => {
      manager.addTenant(createTenantConfig('tenant-1'));

      manager.recordRequest('tenant-1', 1024);
      manager.recordRequest('tenant-1', 2048);

      const stats = manager.getTenantStats('tenant-1');
      expect(stats?.totalRequests).toBe(2);
      expect(stats?.totalBytes).toBe(3072);
    });

    it('should track connections', () => {
      manager.addTenant(createTenantConfig('tenant-1'));

      expect(manager.incrementConnections('tenant-1')).toBe(true);
      expect(manager.incrementConnections('tenant-1')).toBe(true);

      let stats = manager.getTenantStats('tenant-1');
      expect(stats?.activeConnections).toBe(2);

      manager.decrementConnections('tenant-1');
      stats = manager.getTenantStats('tenant-1');
      expect(stats?.activeConnections).toBe(1);
    });

    it('should enforce max connections', () => {
      manager.addTenant(createTenantConfig('tenant-1', { maxConnections: 2 }));

      expect(manager.incrementConnections('tenant-1')).toBe(true);
      expect(manager.incrementConnections('tenant-1')).toBe(true);
      expect(manager.incrementConnections('tenant-1')).toBe(false); // At limit
    });

    it('should get all stats', () => {
      manager.addTenant(createTenantConfig('tenant-1'));
      manager.addTenant(createTenantConfig('tenant-2'));

      manager.recordRequest('tenant-1', 100);
      manager.recordRequest('tenant-2', 200);

      const allStats = manager.getAllStats();
      expect(allStats).toHaveLength(2);
    });
  });

  describe('tenant context', () => {
    it('should provide allowlist matcher in context', () => {
      manager.addTenant(createTenantConfig('tenant-1'));

      const req = createMockRequest({ 'x-tenant-id': 'tenant-1' });
      const result = manager.resolveTenant(req);

      expect(result.context?.allowlistMatcher).toBeDefined();
      expect(typeof result.context?.allowlistMatcher.match).toBe('function');
    });

    it('should provide rate limiter in context', () => {
      manager.addTenant(createTenantConfig('tenant-1'));

      const req = createMockRequest({ 'x-tenant-id': 'tenant-1' });
      const result = manager.resolveTenant(req);

      expect(result.context?.rateLimiter).toBeDefined();
      expect(typeof result.context?.rateLimiter.consume).toBe('function');
    });
  });
});

describe('TenantExtractors', () => {
  describe('fromHeader', () => {
    it('should extract from custom header', () => {
      const extractor = TenantExtractors.fromHeader('x-custom-tenant');
      const req = { headers: { 'x-custom-tenant': 'tenant-123' } } as IncomingMessage;

      expect(extractor(req)).toBe('tenant-123');
    });

    it('should return null for missing header', () => {
      const extractor = TenantExtractors.fromHeader('x-tenant-id');
      const req = { headers: {} } as IncomingMessage;

      expect(extractor(req)).toBeNull();
    });
  });

  describe('fromApiKeyPrefix', () => {
    it('should extract from API key prefix', () => {
      const extractor = TenantExtractors.fromApiKeyPrefix();
      const req = {
        headers: { authorization: 'Bearer tenant1_abc123xyz' },
      } as IncomingMessage;

      expect(extractor(req)).toBe('tenant1');
    });

    it('should return null for invalid format', () => {
      const extractor = TenantExtractors.fromApiKeyPrefix();
      const req = {
        headers: { authorization: 'Bearer keywithnounderscore' },
      } as IncomingMessage;

      expect(extractor(req)).toBeNull();
    });
  });

  describe('fromSubdomain', () => {
    it('should extract subdomain', () => {
      const extractor = TenantExtractors.fromSubdomain('proxy.example.com');
      const req = { headers: { host: 'tenant1.proxy.example.com' } } as IncomingMessage;

      expect(extractor(req)).toBe('tenant1');
    });

    it('should return null for base domain', () => {
      const extractor = TenantExtractors.fromSubdomain('proxy.example.com');
      const req = { headers: { host: 'proxy.example.com' } } as IncomingMessage;

      expect(extractor(req)).toBeNull();
    });

    it('should handle port in host header', () => {
      const extractor = TenantExtractors.fromSubdomain('proxy.example.com');
      const req = { headers: { host: 'tenant1.proxy.example.com:8080' } } as IncomingMessage;

      expect(extractor(req)).toBe('tenant1');
    });
  });

  describe('fromPathPrefix', () => {
    it('should extract from path prefix', () => {
      const extractor = TenantExtractors.fromPathPrefix();
      const req = { url: '/tenant1/api/users' } as IncomingMessage;

      expect(extractor(req)).toBe('tenant1');
    });

    it('should return null for root path', () => {
      const extractor = TenantExtractors.fromPathPrefix();
      const req = { url: '/' } as IncomingMessage;

      expect(extractor(req)).toBeNull();
    });
  });

  describe('combine', () => {
    it('should try extractors in order', () => {
      const extractor = TenantExtractors.combine(
        TenantExtractors.fromHeader('x-tenant-id'),
        TenantExtractors.fromSubdomain('example.com')
      );

      // First extractor matches
      const req1 = {
        headers: { 'x-tenant-id': 'from-header', host: 'tenant.example.com' },
        url: '/',
      } as IncomingMessage;
      expect(extractor(req1)).toBe('from-header');

      // Falls back to second
      const req2 = {
        headers: { host: 'tenant.example.com' },
        url: '/',
      } as IncomingMessage;
      expect(extractor(req2)).toBe('tenant');
    });

    it('should return null if no extractor matches', () => {
      const extractor = TenantExtractors.combine(
        TenantExtractors.fromHeader('x-tenant-id'),
        TenantExtractors.fromHeader('x-other')
      );

      const req = { headers: {} } as IncomingMessage;
      expect(extractor(req)).toBeNull();
    });
  });
});
