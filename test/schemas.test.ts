import { describe, it, expect } from 'vitest';
import {
  HttpMethodSchema,
  RateLimitConfigSchema,
  HeaderTransformSchema,
  AllowlistRuleSchema,
  AllowlistConfigSchema,
  AllowlistModeSchema,
  DefaultActionSchema,
  ProxyModeSchema,
  LogLevelSchema,
  TlsConfigSchema,
  LoggingConfigSchema,
  LimitsConfigSchema,
  TimeoutsConfigSchema,
  AdminAuthConfigSchema,
  AdminConfigSchema,
  ServerConfigSchema,
  ProxyConfigSchema,
} from '../src/validation/schemas.js';

describe('HttpMethodSchema', () => {
  it('should accept valid HTTP methods', () => {
    for (const method of [
      'GET',
      'POST',
      'PUT',
      'DELETE',
      'PATCH',
      'HEAD',
      'OPTIONS',
      'CONNECT',
      'TRACE',
    ]) {
      expect(HttpMethodSchema.parse(method)).toBe(method);
    }
  });

  it('should reject invalid methods', () => {
    expect(() => HttpMethodSchema.parse('INVALID')).toThrow();
    expect(() => HttpMethodSchema.parse('')).toThrow();
    expect(() => HttpMethodSchema.parse(123)).toThrow();
  });
});

describe('RateLimitConfigSchema', () => {
  it('should accept valid rate limit', () => {
    expect(RateLimitConfigSchema.parse({ requestsPerMinute: 100 })).toEqual({
      requestsPerMinute: 100,
    });
  });

  it('should accept max value', () => {
    expect(RateLimitConfigSchema.parse({ requestsPerMinute: 10000 })).toEqual({
      requestsPerMinute: 10000,
    });
  });

  it('should reject zero', () => {
    expect(() => RateLimitConfigSchema.parse({ requestsPerMinute: 0 })).toThrow();
  });

  it('should reject negative numbers', () => {
    expect(() => RateLimitConfigSchema.parse({ requestsPerMinute: -1 })).toThrow();
  });

  it('should reject values exceeding max', () => {
    expect(() => RateLimitConfigSchema.parse({ requestsPerMinute: 10001 })).toThrow();
  });

  it('should reject non-integer values', () => {
    expect(() => RateLimitConfigSchema.parse({ requestsPerMinute: 1.5 })).toThrow();
  });

  it('should reject missing field', () => {
    expect(() => RateLimitConfigSchema.parse({})).toThrow();
  });
});

describe('HeaderTransformSchema', () => {
  it('should accept empty object', () => {
    expect(HeaderTransformSchema.parse({})).toEqual({});
  });

  it('should accept set headers', () => {
    const result = HeaderTransformSchema.parse({ set: { 'X-Custom': 'value' } });
    expect(result.set).toEqual({ 'X-Custom': 'value' });
  });

  it('should accept remove headers', () => {
    const result = HeaderTransformSchema.parse({ remove: ['X-Remove-Me'] });
    expect(result.remove).toEqual(['X-Remove-Me']);
  });

  it('should accept rename headers', () => {
    const result = HeaderTransformSchema.parse({ rename: { 'X-Old': 'X-New' } });
    expect(result.rename).toEqual({ 'X-Old': 'X-New' });
  });

  it('should accept all operations together', () => {
    const transform = {
      set: { 'X-Added': 'val' },
      remove: ['X-Remove'],
      rename: { 'X-Old': 'X-New' },
    };
    const result = HeaderTransformSchema.parse(transform);
    expect(result).toEqual(transform);
  });
});

describe('AllowlistRuleSchema', () => {
  const validRule = {
    id: 'test-rule',
    domain: 'api.example.com',
  };

  it('should accept a minimal valid rule', () => {
    const result = AllowlistRuleSchema.parse(validRule);
    expect(result.id).toBe('test-rule');
    expect(result.domain).toBe('api.example.com');
    expect(result.enabled).toBe(true); // default
  });

  it('should accept a fully populated rule', () => {
    const full = {
      ...validRule,
      paths: ['/api/*'],
      methods: ['GET', 'POST'],
      rateLimit: { requestsPerMinute: 100 },
      description: 'Test rule',
      enabled: false,
      clientIps: ['10.0.0.0/8'],
      excludeClientIps: ['10.0.0.1'],
      requestHeaders: { set: { 'X-Via': 'proxy' } },
      responseHeaders: { remove: ['Server'] },
    };
    const result = AllowlistRuleSchema.parse(full);
    expect(result.enabled).toBe(false);
    expect(result.methods).toEqual(['GET', 'POST']);
  });

  it('should reject empty rule ID', () => {
    expect(() => AllowlistRuleSchema.parse({ ...validRule, id: '' })).toThrow();
  });

  it('should reject rule ID with special characters', () => {
    expect(() => AllowlistRuleSchema.parse({ ...validRule, id: 'bad rule!' })).toThrow();
  });

  it('should reject rule ID exceeding 64 characters', () => {
    expect(() => AllowlistRuleSchema.parse({ ...validRule, id: 'a'.repeat(65) })).toThrow();
  });

  it('should reject empty domain', () => {
    expect(() => AllowlistRuleSchema.parse({ ...validRule, domain: '' })).toThrow();
  });

  it('should reject domain exceeding 253 characters', () => {
    expect(() => AllowlistRuleSchema.parse({ ...validRule, domain: 'a'.repeat(254) })).toThrow();
  });

  it('should accept lowercase methods and transform them to uppercase', () => {
    const result = AllowlistRuleSchema.parse({ ...validRule, methods: ['get', 'post'] });
    expect(result.methods).toEqual(['GET', 'POST']);
  });

  it('should reject invalid HTTP methods', () => {
    expect(() => AllowlistRuleSchema.parse({ ...validRule, methods: ['INVALID'] })).toThrow();
  });

  it('should reject description exceeding 500 characters', () => {
    expect(() =>
      AllowlistRuleSchema.parse({ ...validRule, description: 'x'.repeat(501) }),
    ).toThrow();
  });

  it('should accept valid rule IDs with hyphens and underscores', () => {
    const result = AllowlistRuleSchema.parse({ ...validRule, id: 'my_rule-123' });
    expect(result.id).toBe('my_rule-123');
  });

  it('should reject missing required fields', () => {
    expect(() => AllowlistRuleSchema.parse({})).toThrow();
    expect(() => AllowlistRuleSchema.parse({ id: 'test' })).toThrow();
    expect(() => AllowlistRuleSchema.parse({ domain: 'x.com' })).toThrow();
  });
});

describe('AllowlistConfigSchema', () => {
  const validConfig = {
    mode: 'strict',
    defaultAction: 'deny',
    rules: [{ id: 'rule-1', domain: 'example.com' }],
  };

  it('should accept valid config', () => {
    const result = AllowlistConfigSchema.parse(validConfig);
    expect(result.mode).toBe('strict');
    expect(result.defaultAction).toBe('deny');
    expect(result.rules).toHaveLength(1);
  });

  it('should accept empty rules array', () => {
    const result = AllowlistConfigSchema.parse({ ...validConfig, rules: [] });
    expect(result.rules).toEqual([]);
  });

  it('should reject duplicate rule IDs', () => {
    const config = {
      ...validConfig,
      rules: [
        { id: 'dup', domain: 'a.com' },
        { id: 'dup', domain: 'b.com' },
      ],
    };
    expect(() => AllowlistConfigSchema.parse(config)).toThrow(/[Dd]uplicate/);
  });

  it('should reject invalid mode', () => {
    expect(() => AllowlistConfigSchema.parse({ ...validConfig, mode: 'invalid' })).toThrow();
  });

  it('should reject invalid defaultAction', () => {
    expect(() => AllowlistConfigSchema.parse({ ...validConfig, defaultAction: 'block' })).toThrow();
  });
});

describe('AllowlistModeSchema', () => {
  it('should accept strict and permissive', () => {
    expect(AllowlistModeSchema.parse('strict')).toBe('strict');
    expect(AllowlistModeSchema.parse('permissive')).toBe('permissive');
  });

  it('should reject other values', () => {
    expect(() => AllowlistModeSchema.parse('other')).toThrow();
  });
});

describe('DefaultActionSchema', () => {
  it('should accept allow and deny', () => {
    expect(DefaultActionSchema.parse('allow')).toBe('allow');
    expect(DefaultActionSchema.parse('deny')).toBe('deny');
  });

  it('should reject other values', () => {
    expect(() => DefaultActionSchema.parse('block')).toThrow();
  });
});

describe('ProxyModeSchema', () => {
  it('should accept tunnel and mitm', () => {
    expect(ProxyModeSchema.parse('tunnel')).toBe('tunnel');
    expect(ProxyModeSchema.parse('mitm')).toBe('mitm');
  });

  it('should reject other values', () => {
    expect(() => ProxyModeSchema.parse('passthrough')).toThrow();
  });
});

describe('LogLevelSchema', () => {
  it('should accept all valid log levels', () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']) {
      expect(LogLevelSchema.parse(level)).toBe(level);
    }
  });

  it('should reject invalid levels', () => {
    expect(() => LogLevelSchema.parse('verbose')).toThrow();
  });
});

describe('TlsConfigSchema', () => {
  it('should accept empty object with defaults', () => {
    const result = TlsConfigSchema.parse({});
    expect(result.autoGenerateCa).toBe(true);
  });

  it('should accept full config', () => {
    const config = {
      caCertPath: '/path/to/cert.pem',
      caKeyPath: '/path/to/key.pem',
      autoGenerateCa: false,
      certCacheDir: '/tmp/certs',
    };
    const result = TlsConfigSchema.parse(config);
    expect(result.autoGenerateCa).toBe(false);
  });
});

describe('LoggingConfigSchema', () => {
  it('should provide sensible defaults', () => {
    const result = LoggingConfigSchema.parse({});
    expect(result.level).toBe('info');
    expect(result.console).toBe(true);
    expect(result.pretty).toBe(true);
    expect(result.logHeaders).toBe(false);
    expect(result.logBody).toBe(false);
    expect(result.maxBodyLogSize).toBe(1024);
    expect(result.redactHeaders).toEqual(['authorization', 'cookie', 'x-api-key', 'x-auth-token']);
  });

  it('should accept custom values', () => {
    const result = LoggingConfigSchema.parse({
      level: 'debug',
      console: false,
      logHeaders: true,
      maxBodyLogSize: 4096,
    });
    expect(result.level).toBe('debug');
    expect(result.console).toBe(false);
    expect(result.logHeaders).toBe(true);
    expect(result.maxBodyLogSize).toBe(4096);
  });

  it('should reject invalid log level', () => {
    expect(() => LoggingConfigSchema.parse({ level: 'verbose' })).toThrow();
  });

  it('should reject negative maxBodyLogSize', () => {
    expect(() => LoggingConfigSchema.parse({ maxBodyLogSize: -1 })).toThrow();
  });
});

describe('LimitsConfigSchema', () => {
  it('should provide defaults', () => {
    const result = LimitsConfigSchema.parse({});
    expect(result.maxRequestBodySize).toBe(10 * 1024 * 1024);
    expect(result.maxResponseBodySize).toBe(50 * 1024 * 1024);
    expect(result.maxHeaderSize).toBe(16 * 1024);
    expect(result.maxUrlLength).toBe(8 * 1024);
    expect(result.maxConcurrentConnectionsPerIp).toBe(100);
    expect(result.maxTotalConnections).toBe(10000);
  });

  it('should reject zero values', () => {
    expect(() => LimitsConfigSchema.parse({ maxRequestBodySize: 0 })).toThrow();
  });

  it('should reject values exceeding maximum', () => {
    expect(() =>
      LimitsConfigSchema.parse({ maxRequestBodySize: 1024 * 1024 * 1024 + 1 }),
    ).toThrow();
  });
});

describe('TimeoutsConfigSchema', () => {
  it('should provide defaults', () => {
    const result = TimeoutsConfigSchema.parse({});
    expect(result.connectTimeout).toBe(10000);
    expect(result.responseTimeout).toBe(30000);
    expect(result.idleTimeout).toBe(60000);
    expect(result.requestTimeout).toBe(30000);
  });

  it('should reject zero values', () => {
    expect(() => TimeoutsConfigSchema.parse({ connectTimeout: 0 })).toThrow();
  });

  it('should reject values exceeding maximums', () => {
    expect(() => TimeoutsConfigSchema.parse({ connectTimeout: 300001 })).toThrow();
    expect(() => TimeoutsConfigSchema.parse({ responseTimeout: 600001 })).toThrow();
  });
});

describe('AdminAuthConfigSchema', () => {
  it('should accept method none without credentials', () => {
    const result = AdminAuthConfigSchema.parse({ method: 'none' });
    expect(result.method).toBe('none');
  });

  it('should accept bearer method with token', () => {
    const result = AdminAuthConfigSchema.parse({
      method: 'bearer',
      bearerToken: 'a'.repeat(32),
    });
    expect(result.method).toBe('bearer');
  });

  it('should reject bearer method without token', () => {
    expect(() => AdminAuthConfigSchema.parse({ method: 'bearer' })).toThrow();
  });

  it('should accept api-key method with key', () => {
    const result = AdminAuthConfigSchema.parse({
      method: 'api-key',
      apiKey: 'a'.repeat(32),
    });
    expect(result.method).toBe('api-key');
  });

  it('should reject api-key method without key', () => {
    expect(() => AdminAuthConfigSchema.parse({ method: 'api-key' })).toThrow();
  });

  it('should accept ip-allowlist method with IPs', () => {
    const result = AdminAuthConfigSchema.parse({
      method: 'ip-allowlist',
      allowedIps: ['127.0.0.1'],
    });
    expect(result.method).toBe('ip-allowlist');
  });

  it('should reject ip-allowlist method without IPs', () => {
    expect(() => AdminAuthConfigSchema.parse({ method: 'ip-allowlist' })).toThrow();
  });

  it('should reject ip-allowlist method with empty IPs array', () => {
    expect(() => AdminAuthConfigSchema.parse({ method: 'ip-allowlist', allowedIps: [] })).toThrow();
  });

  it('should reject bearer token shorter than 16 characters', () => {
    expect(() => AdminAuthConfigSchema.parse({ method: 'bearer', bearerToken: 'short' })).toThrow();
  });

  it('should provide default protectedEndpoints', () => {
    const result = AdminAuthConfigSchema.parse({ method: 'none' });
    expect(result.protectedEndpoints).toEqual(['/metrics', '/config']);
  });

  it('should provide default rateLimitPerMinute', () => {
    const result = AdminAuthConfigSchema.parse({ method: 'none' });
    expect(result.rateLimitPerMinute).toBe(60);
  });
});

describe('AdminConfigSchema', () => {
  it('should provide defaults', () => {
    const result = AdminConfigSchema.parse({});
    expect(result.enabled).toBe(false);
    expect(result.port).toBe(9090);
    expect(result.host).toBe('127.0.0.1');
  });

  it('should reject invalid port', () => {
    expect(() => AdminConfigSchema.parse({ port: 0 })).toThrow();
    expect(() => AdminConfigSchema.parse({ port: 65536 })).toThrow();
  });
});

describe('ServerConfigSchema', () => {
  it('should provide defaults', () => {
    const result = ServerConfigSchema.parse({});
    expect(result.host).toBe('127.0.0.1');
    expect(result.port).toBe(8080);
    expect(result.mode).toBe('tunnel');
  });

  it('should accept custom values', () => {
    const result = ServerConfigSchema.parse({
      host: '0.0.0.0',
      port: 3128,
      mode: 'mitm',
    });
    expect(result.host).toBe('0.0.0.0');
    expect(result.port).toBe(3128);
    expect(result.mode).toBe('mitm');
  });
});

describe('ProxyConfigSchema', () => {
  it('should accept valid full config', () => {
    const config = {
      server: { host: '127.0.0.1', port: 8080, mode: 'tunnel' },
      allowlist: {
        mode: 'strict',
        defaultAction: 'deny',
        rules: [{ id: 'rule-1', domain: 'example.com' }],
      },
    };
    const result = ProxyConfigSchema.parse(config);
    expect(result.server.port).toBe(8080);
    expect(result.allowlist.rules).toHaveLength(1);
  });

  it('should reject missing server', () => {
    expect(() =>
      ProxyConfigSchema.parse({
        allowlist: { mode: 'strict', defaultAction: 'deny', rules: [] },
      }),
    ).toThrow();
  });

  it('should reject missing allowlist', () => {
    expect(() =>
      ProxyConfigSchema.parse({
        server: {},
      }),
    ).toThrow();
  });
});
