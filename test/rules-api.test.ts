import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RulesApi, createRulesApi } from '../src/admin/rules-api.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AllowlistConfig, AllowlistRule } from '../src/types/allowlist.js';
import { EventEmitter } from 'node:events';

// Helper to create mock request
function createMockReq(options: {
  method?: string;
  url?: string;
  body?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const emitter = new EventEmitter();
  const req = emitter as unknown as IncomingMessage;
  req.method = options.method ?? 'GET';
  req.url = options.url ?? '/api/rules';
  req.headers = { host: 'localhost:9090', ...(options.headers ?? {}) };

  // Simulate body streaming
  if (options.body !== undefined) {
    process.nextTick(() => {
      emitter.emit('data', Buffer.from(options.body!));
      emitter.emit('end');
    });
  } else {
    process.nextTick(() => {
      emitter.emit('end');
    });
  }

  return req;
}

// Helper to create mock response
function createMockRes(): ServerResponse & {
  _status: number;
  _body: string;
  _headers: Record<string, string>;
} {
  const res = {
    _status: 0,
    _body: '',
    _headers: {} as Record<string, string>,
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
      return res;
    },
    end(body?: string) {
      if (body) res._body = body;
      return res;
    },
  };
  return res as any;
}

function parseResBody(res: ReturnType<typeof createMockRes>) {
  return JSON.parse(res._body);
}

// Create test fixtures
function createTestConfig(rules: AllowlistRule[] = []): AllowlistConfig {
  return {
    mode: 'strict',
    defaultAction: 'deny',
    rules,
  };
}

function createTestRule(overrides: Partial<AllowlistRule> = {}): AllowlistRule {
  return {
    id: 'test-rule',
    domain: 'api.example.com',
    ...overrides,
  };
}

function createMockDeps(config?: AllowlistConfig) {
  const currentConfig = config ?? createTestConfig();
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  const allowlistMatcher = {
    getConfig: vi.fn(() => currentConfig),
    reload: vi.fn((newConfig: AllowlistConfig) => {
      // Update the config reference so subsequent getConfig calls return updated config
      allowlistMatcher.getConfig.mockReturnValue(newConfig);
    }),
  };
  const rateLimiter = {
    clear: vi.fn(),
    registerRules: vi.fn(),
  };
  return { logger, allowlistMatcher, rateLimiter };
}

describe('RulesApi', () => {
  describe('GET /api/rules', () => {
    it('should list all rules', async () => {
      const rules = [
        createTestRule({ id: 'rule-1', domain: 'a.com' }),
        createTestRule({ id: 'rule-2', domain: 'b.com' }),
      ];
      const deps = createMockDeps(createTestConfig(rules));
      const api = new RulesApi(deps as any);

      const req = createMockReq({ method: 'GET', url: '/api/rules' });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(200);
      const body = parseResBody(res);
      expect(body.success).toBe(true);
      expect(body.rules).toHaveLength(2);
      expect(body.count).toBe(2);
    });

    it('should filter rules by domain', async () => {
      const rules = [
        createTestRule({ id: 'r1', domain: 'api.example.com' }),
        createTestRule({ id: 'r2', domain: 'other.com' }),
      ];
      const deps = createMockDeps(createTestConfig(rules));
      const api = new RulesApi(deps as any);

      const req = createMockReq({ method: 'GET', url: '/api/rules?domain=example' });
      const res = createMockRes();

      await api.handleRequest(req, res);

      const body = parseResBody(res);
      expect(body.rules).toHaveLength(1);
      expect(body.rules[0].id).toBe('r1');
    });

    it('should filter rules by enabled status', async () => {
      const rules = [
        createTestRule({ id: 'r1', enabled: true }),
        createTestRule({ id: 'r2', enabled: false }),
      ];
      const deps = createMockDeps(createTestConfig(rules));
      const api = new RulesApi(deps as any);

      const req = createMockReq({ method: 'GET', url: '/api/rules?enabled=true' });
      const res = createMockRes();

      await api.handleRequest(req, res);

      const body = parseResBody(res);
      expect(body.rules).toHaveLength(1);
      expect(body.rules[0].id).toBe('r1');
    });

    it('should paginate results', async () => {
      const rules = Array.from({ length: 5 }, (_, i) =>
        createTestRule({ id: `r${i}`, domain: `d${i}.com` }),
      );
      const deps = createMockDeps(createTestConfig(rules));
      const api = new RulesApi(deps as any);

      const req = createMockReq({ method: 'GET', url: '/api/rules?page=2&limit=2' });
      const res = createMockRes();

      await api.handleRequest(req, res);

      const body = parseResBody(res);
      expect(body.rules).toHaveLength(2);
      expect(body.rules[0].id).toBe('r2');
      expect(body.rules[1].id).toBe('r3');
      expect(body.count).toBe(5);
    });

    it('should return empty list when no rules exist', async () => {
      const deps = createMockDeps(createTestConfig([]));
      const api = new RulesApi(deps as any);

      const req = createMockReq({ method: 'GET', url: '/api/rules' });
      const res = createMockRes();

      await api.handleRequest(req, res);

      const body = parseResBody(res);
      expect(body.rules).toHaveLength(0);
      expect(body.count).toBe(0);
    });
  });

  describe('GET /api/rules/:id', () => {
    it('should return a specific rule', async () => {
      const rules = [createTestRule({ id: 'my-rule', domain: 'test.com' })];
      const deps = createMockDeps(createTestConfig(rules));
      const api = new RulesApi(deps as any);

      const req = createMockReq({ method: 'GET', url: '/api/rules/my-rule' });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(200);
      const body = parseResBody(res);
      expect(body.rule.id).toBe('my-rule');
    });

    it('should return 404 for non-existent rule', async () => {
      const deps = createMockDeps(createTestConfig([]));
      const api = new RulesApi(deps as any);

      const req = createMockReq({ method: 'GET', url: '/api/rules/missing' });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(404);
      const body = parseResBody(res);
      expect(body.success).toBe(false);
    });
  });

  describe('POST /api/rules', () => {
    it('should create a new rule', async () => {
      const deps = createMockDeps(createTestConfig([]));
      const onRulesChange = vi.fn();
      const api = new RulesApi({ ...deps, onRulesChange } as any);

      const newRule = { id: 'new-rule', domain: 'new.example.com' };
      const req = createMockReq({
        method: 'POST',
        url: '/api/rules',
        body: JSON.stringify(newRule),
      });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(201);
      const body = parseResBody(res);
      expect(body.success).toBe(true);
      expect(body.rule.id).toBe('new-rule');
      expect(deps.allowlistMatcher.reload).toHaveBeenCalled();
      expect(deps.rateLimiter.clear).toHaveBeenCalled();
      expect(deps.rateLimiter.registerRules).toHaveBeenCalled();
      expect(onRulesChange).toHaveBeenCalled();
    });

    it('should reject invalid rule format (non-JSON)', async () => {
      const deps = createMockDeps(createTestConfig([]));
      const api = new RulesApi(deps as any);

      const req = createMockReq({
        method: 'POST',
        url: '/api/rules',
        body: 'not json',
      });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(400);
    });

    it('should reject rule with invalid ID', async () => {
      const deps = createMockDeps(createTestConfig([]));
      const api = new RulesApi(deps as any);

      const req = createMockReq({
        method: 'POST',
        url: '/api/rules',
        body: JSON.stringify({ id: 'bad rule!', domain: 'x.com' }),
      });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(400);
      const body = parseResBody(res);
      expect(body.errors).toBeDefined();
    });

    it('should reject rule with missing domain', async () => {
      const deps = createMockDeps(createTestConfig([]));
      const api = new RulesApi(deps as any);

      const req = createMockReq({
        method: 'POST',
        url: '/api/rules',
        body: JSON.stringify({ id: 'valid-id' }),
      });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(400);
    });

    it('should reject duplicate rule ID', async () => {
      const existingRules = [createTestRule({ id: 'existing', domain: 'a.com' })];
      const deps = createMockDeps(createTestConfig(existingRules));
      const api = new RulesApi(deps as any);

      const req = createMockReq({
        method: 'POST',
        url: '/api/rules',
        body: JSON.stringify({ id: 'existing', domain: 'b.com' }),
      });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(409);
    });

    it('should reject when max rules limit reached', async () => {
      const rules = [createTestRule({ id: 'r1', domain: 'x.com' })];
      const deps = createMockDeps(createTestConfig(rules));
      const api = new RulesApi({ ...deps, maxRules: 1 } as any);

      const req = createMockReq({
        method: 'POST',
        url: '/api/rules',
        body: JSON.stringify({ id: 'new', domain: 'y.com' }),
      });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(400);
      const body = parseResBody(res);
      expect(body.message).toContain('Maximum rules limit');
    });

    it('should persist rules when persistRules is configured', async () => {
      const persistRules = vi.fn().mockResolvedValue(undefined);
      const deps = createMockDeps(createTestConfig([]));
      const api = new RulesApi({ ...deps, persistRules } as any);

      const req = createMockReq({
        method: 'POST',
        url: '/api/rules',
        body: JSON.stringify({ id: 'new-rule', domain: 'x.com' }),
      });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(persistRules).toHaveBeenCalled();
    });
  });

  describe('PUT /api/rules/:id', () => {
    it('should update an existing rule', async () => {
      const rules = [createTestRule({ id: 'rule-1', domain: 'old.com' })];
      const deps = createMockDeps(createTestConfig(rules));
      const api = new RulesApi(deps as any);

      const req = createMockReq({
        method: 'PUT',
        url: '/api/rules/rule-1',
        body: JSON.stringify({ id: 'rule-1', domain: 'new.com' }),
      });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(200);
      const body = parseResBody(res);
      expect(body.rule.domain).toBe('new.com');
      expect(body.rule.id).toBe('rule-1'); // ID preserved
    });

    it('should return 404 for non-existent rule', async () => {
      const deps = createMockDeps(createTestConfig([]));
      const api = new RulesApi(deps as any);

      const req = createMockReq({
        method: 'PUT',
        url: '/api/rules/missing',
        body: JSON.stringify({ id: 'missing', domain: 'x.com' }),
      });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(404);
    });

    it('should return 400 for invalid body', async () => {
      const rules = [createTestRule({ id: 'rule-1' })];
      const deps = createMockDeps(createTestConfig(rules));
      const api = new RulesApi(deps as any);

      const req = createMockReq({
        method: 'PUT',
        url: '/api/rules/rule-1',
        body: 'not json',
      });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(400);
    });

    it('should return 400 when no rule ID in URL', async () => {
      const deps = createMockDeps(createTestConfig([]));
      const api = new RulesApi(deps as any);

      const req = createMockReq({
        method: 'PUT',
        url: '/api/rules',
        body: JSON.stringify({ id: 'r', domain: 'x.com' }),
      });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(400);
    });

    it('should preserve original ID even if body has different ID', async () => {
      const rules = [createTestRule({ id: 'original', domain: 'old.com' })];
      const deps = createMockDeps(createTestConfig(rules));
      const api = new RulesApi(deps as any);

      const req = createMockReq({
        method: 'PUT',
        url: '/api/rules/original',
        body: JSON.stringify({ id: 'different', domain: 'new.com' }),
      });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(200);
      const body = parseResBody(res);
      expect(body.rule.id).toBe('original');
    });
  });

  describe('DELETE /api/rules/:id', () => {
    it('should delete an existing rule', async () => {
      const rules = [
        createTestRule({ id: 'rule-1', domain: 'a.com' }),
        createTestRule({ id: 'rule-2', domain: 'b.com' }),
      ];
      const deps = createMockDeps(createTestConfig(rules));
      const api = new RulesApi(deps as any);

      const req = createMockReq({ method: 'DELETE', url: '/api/rules/rule-1' });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(200);
      const body = parseResBody(res);
      expect(body.success).toBe(true);
      expect(deps.allowlistMatcher.reload).toHaveBeenCalledWith(
        expect.objectContaining({
          rules: expect.arrayContaining([expect.objectContaining({ id: 'rule-2' })]),
        }),
      );
    });

    it('should return 404 for non-existent rule', async () => {
      const deps = createMockDeps(createTestConfig([]));
      const api = new RulesApi(deps as any);

      const req = createMockReq({ method: 'DELETE', url: '/api/rules/missing' });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(404);
    });

    it('should return 400 when no rule ID in URL', async () => {
      const deps = createMockDeps(createTestConfig([]));
      const api = new RulesApi(deps as any);

      const req = createMockReq({ method: 'DELETE', url: '/api/rules' });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(400);
    });
  });

  describe('POST /api/rules/validate', () => {
    it('should validate a valid rule', async () => {
      const deps = createMockDeps(createTestConfig([]));
      const api = new RulesApi(deps as any);

      const req = createMockReq({
        method: 'POST',
        url: '/api/rules/validate',
        body: JSON.stringify({ id: 'valid-rule', domain: 'x.com' }),
      });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(200);
      const body = parseResBody(res);
      expect(body.success).toBe(true);
      expect(body.message).toBe('Rule is valid');
    });

    it('should return validation errors for invalid rule', async () => {
      const deps = createMockDeps(createTestConfig([]));
      const api = new RulesApi(deps as any);

      const req = createMockReq({
        method: 'POST',
        url: '/api/rules/validate',
        body: JSON.stringify({ id: 'bad rule!', domain: '' }),
      });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(400);
      const body = parseResBody(res);
      expect(body.success).toBe(false);
      expect(body.errors).toBeDefined();
      expect(body.errors.length).toBeGreaterThan(0);
    });
  });

  describe('POST /api/rules/reload', () => {
    it('should trigger reload', async () => {
      const rules = [createTestRule()];
      const deps = createMockDeps(createTestConfig(rules));
      const api = new RulesApi(deps as any);

      const req = createMockReq({ method: 'POST', url: '/api/rules/reload' });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(200);
      const body = parseResBody(res);
      expect(body.success).toBe(true);
      expect(body.count).toBe(1);
    });
  });

  describe('POST /api/rules/batch', () => {
    it('should process batch operations', async () => {
      const deps = createMockDeps(createTestConfig([]));
      const api = new RulesApi(deps as any);

      const req = createMockReq({
        method: 'POST',
        url: '/api/rules/batch',
        body: JSON.stringify({
          operations: [
            { operation: 'create', rule: { id: 'r1', domain: 'a.com' } },
            { operation: 'create', rule: { id: 'r2', domain: 'b.com' } },
          ],
        }),
      });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(200);
      const body = parseResBody(res);
      expect(body.message).toContain('2/2');
    });

    it('should handle partial failures in batch', async () => {
      const rules = [createTestRule({ id: 'existing', domain: 'a.com' })];
      const deps = createMockDeps(createTestConfig(rules));
      const api = new RulesApi(deps as any);

      const req = createMockReq({
        method: 'POST',
        url: '/api/rules/batch',
        body: JSON.stringify({
          operations: [
            { operation: 'create', rule: { id: 'new-rule', domain: 'b.com' } },
            { operation: 'create', rule: { id: 'existing', domain: 'c.com' } }, // duplicate
          ],
        }),
      });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(200);
      const body = parseResBody(res);
      expect(body.message).toContain('1/2');
    });

    it('should reject invalid batch format', async () => {
      const deps = createMockDeps(createTestConfig([]));
      const api = new RulesApi(deps as any);

      const req = createMockReq({
        method: 'POST',
        url: '/api/rules/batch',
        body: JSON.stringify({ notOperations: [] }),
      });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(400);
    });

    it('should reject invalid JSON', async () => {
      const deps = createMockDeps(createTestConfig([]));
      const api = new RulesApi(deps as any);

      const req = createMockReq({
        method: 'POST',
        url: '/api/rules/batch',
        body: 'not json',
      });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(400);
    });
  });

  describe('routing', () => {
    it('should return 404 for unrecognized paths', async () => {
      const deps = createMockDeps(createTestConfig([]));
      const api = new RulesApi(deps as any);

      const req = createMockReq({ method: 'GET', url: '/api/other' });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(404);
    });

    it('should return 405 for unsupported methods', async () => {
      const deps = createMockDeps(createTestConfig([]));
      const api = new RulesApi(deps as any);

      const req = createMockReq({ method: 'PATCH', url: '/api/rules' });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(405);
    });

    it('should return 404 for POST with unknown subpath', async () => {
      const deps = createMockDeps(createTestConfig([]));
      const api = new RulesApi(deps as any);

      const req = createMockReq({ method: 'POST', url: '/api/rules/unknown' });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(404);
    });
  });

  describe('error handling', () => {
    it('should return 500 when handler throws', async () => {
      const deps = createMockDeps(createTestConfig([]));
      deps.allowlistMatcher.getConfig.mockImplementation(() => {
        throw new Error('unexpected');
      });
      const api = new RulesApi(deps as any);

      const req = createMockReq({ method: 'GET', url: '/api/rules' });
      const res = createMockRes();

      await api.handleRequest(req, res);

      expect(res._status).toBe(500);
      expect(deps.logger.error).toHaveBeenCalled();
    });

    it('should handle persist failure gracefully', async () => {
      const persistRules = vi.fn().mockRejectedValue(new Error('disk full'));
      const deps = createMockDeps(createTestConfig([]));
      const api = new RulesApi({ ...deps, persistRules } as any);

      const req = createMockReq({
        method: 'POST',
        url: '/api/rules',
        body: JSON.stringify({ id: 'r1', domain: 'x.com' }),
      });
      const res = createMockRes();

      await api.handleRequest(req, res);

      // Should still succeed (persist is best-effort)
      expect(res._status).toBe(201);
      expect(deps.logger.error).toHaveBeenCalled();
    });
  });

  describe('validateRule', () => {
    it('should validate a correct rule', () => {
      const deps = createMockDeps();
      const api = new RulesApi(deps as any);

      const result = api.validateRule({ id: 'valid-rule', domain: 'x.com' });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject rule with missing id', () => {
      const deps = createMockDeps();
      const api = new RulesApi(deps as any);

      const result = api.validateRule({ id: '', domain: 'x.com' });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject rule with invalid id characters', () => {
      const deps = createMockDeps();
      const api = new RulesApi(deps as any);

      const result = api.validateRule({ id: 'bad rule!', domain: 'x.com' });
      expect(result.valid).toBe(false);
    });

    it('should reject rule with missing domain', () => {
      const deps = createMockDeps();
      const api = new RulesApi(deps as any);

      const result = api.validateRule({ id: 'valid', domain: '' });
      expect(result.valid).toBe(false);
    });

    it('should validate methods', () => {
      const deps = createMockDeps();
      const api = new RulesApi(deps as any);

      const valid = api.validateRule({ id: 'r', domain: 'x.com', methods: ['GET', 'POST'] });
      expect(valid.valid).toBe(true);

      const invalid = api.validateRule({ id: 'r', domain: 'x.com', methods: ['INVALID'] });
      expect(invalid.valid).toBe(false);
    });

    it('should validate rate limit', () => {
      const deps = createMockDeps();
      const api = new RulesApi(deps as any);

      const valid = api.validateRule({
        id: 'r',
        domain: 'x.com',
        rateLimit: { requestsPerMinute: 100 },
      });
      expect(valid.valid).toBe(true);

      const invalid = api.validateRule({
        id: 'r',
        domain: 'x.com',
        rateLimit: { requestsPerMinute: -1 },
      });
      expect(invalid.valid).toBe(false);
    });
  });
});

describe('createRulesApi', () => {
  it('should create a RulesApi instance', () => {
    const deps = createMockDeps();
    const api = createRulesApi(deps as any);
    expect(api).toBeInstanceOf(RulesApi);
  });
});
