import { describe, it, expect } from 'vitest';
import {
  GrpcMatcher,
  createGrpcMatcher,
  GRPC_REFLECTION_SERVICE,
  GRPC_REFLECTION_SERVICE_V1,
  GRPC_HEALTH_SERVICE,
} from '../src/filter/grpc-matcher.js';
import type { GrpcRuleConfig } from '../src/types/allowlist.js';

describe('GrpcMatcher', () => {
  let matcher: GrpcMatcher;

  beforeEach(() => {
    matcher = new GrpcMatcher();
  });

  describe('basic matching', () => {
    it('should allow all when no config provided', () => {
      const result = matcher.match('/myapp.UserService/GetUser', undefined);

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('No gRPC restrictions');
    });

    it('should reject invalid gRPC paths', () => {
      const result = matcher.match('invalid-path', {});

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Invalid gRPC path format');
    });

    it('should allow when config has no restrictions', () => {
      const result = matcher.match('/myapp.UserService/GetUser', {});

      expect(result.allowed).toBe(true);
      expect(result.reason).toContain('no service restrictions');
    });
  });

  describe('service matching', () => {
    it('should match exact service', () => {
      const config: GrpcRuleConfig = {
        services: ['myapp.UserService'],
      };

      const result = matcher.match('/myapp.UserService/GetUser', config);

      expect(result.allowed).toBe(true);
      expect(result.matchedService).toBe('myapp.UserService');
    });

    it('should match package wildcard', () => {
      const config: GrpcRuleConfig = {
        services: ['myapp.*'],
      };

      expect(matcher.match('/myapp.UserService/GetUser', config).allowed).toBe(true);
      expect(matcher.match('/myapp.OrderService/Create', config).allowed).toBe(true);
      expect(matcher.match('/other.Service/Method', config).allowed).toBe(false);
    });

    it('should match double wildcard', () => {
      const config: GrpcRuleConfig = {
        services: ['**'],
      };

      expect(matcher.match('/any.Service/Method', config).allowed).toBe(true);
      expect(matcher.match('/deeply.nested.pkg.Service/Method', config).allowed).toBe(true);
    });

    it('should reject non-matching service', () => {
      const config: GrpcRuleConfig = {
        services: ['allowed.Service'],
      };

      const result = matcher.match('/blocked.Service/Method', config);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in allowed list');
    });

    it('should match multiple services', () => {
      const config: GrpcRuleConfig = {
        services: ['app.UserService', 'app.OrderService'],
      };

      expect(matcher.match('/app.UserService/Get', config).allowed).toBe(true);
      expect(matcher.match('/app.OrderService/Create', config).allowed).toBe(true);
      expect(matcher.match('/app.Other/Method', config).allowed).toBe(false);
    });
  });

  describe('method matching', () => {
    it('should match exact method', () => {
      const config: GrpcRuleConfig = {
        methods: ['myapp.UserService/GetUser'],
      };

      const result = matcher.match('/myapp.UserService/GetUser', config);

      expect(result.allowed).toBe(true);
      expect(result.matchedMethod).toBe('myapp.UserService/GetUser');
    });

    it('should match method wildcard', () => {
      const config: GrpcRuleConfig = {
        methods: ['myapp.UserService/*'],
      };

      expect(matcher.match('/myapp.UserService/GetUser', config).allowed).toBe(true);
      expect(matcher.match('/myapp.UserService/CreateUser', config).allowed).toBe(true);
      expect(matcher.match('/myapp.OrderService/Create', config).allowed).toBe(false);
    });

    it('should reject non-matching method', () => {
      const config: GrpcRuleConfig = {
        methods: ['myapp.UserService/GetUser'],
      };

      // Different method, no service rule to fall back to
      const result = matcher.match('/myapp.UserService/DeleteUser', config);
      expect(result.allowed).toBe(false);
    });
  });

  describe('combined service and method rules', () => {
    it('should prefer method rules over service rules', () => {
      const config: GrpcRuleConfig = {
        services: ['other.*'],
        methods: ['myapp.UserService/SpecificMethod'],
      };

      // Method rule should match even though service doesn't match service rules
      const result = matcher.match('/myapp.UserService/SpecificMethod', config);
      expect(result.allowed).toBe(true);
      expect(result.matchedMethod).toBeDefined();
    });

    it('should fall back to service rules when method not matched', () => {
      const config: GrpcRuleConfig = {
        services: ['myapp.*'],
        methods: ['other.Service/Method'],
      };

      const result = matcher.match('/myapp.UserService/AnyMethod', config);
      expect(result.allowed).toBe(true);
      expect(result.matchedService).toBeDefined();
    });
  });

  describe('reflection service', () => {
    it('should block reflection by default', () => {
      const config: GrpcRuleConfig = {
        services: ['**'], // Allow all services
      };

      const result = matcher.match(`/${GRPC_REFLECTION_SERVICE}/ServerReflectionInfo`, config);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('reflection not allowed');
    });

    it('should allow reflection when explicitly enabled', () => {
      const config: GrpcRuleConfig = {
        allowReflection: true,
      };

      const result = matcher.match(`/${GRPC_REFLECTION_SERVICE}/ServerReflectionInfo`, config);

      expect(result.allowed).toBe(true);
      expect(result.reason).toContain('Reflection service allowed');
    });

    it('should recognize v1 reflection service', () => {
      const config: GrpcRuleConfig = {
        allowReflection: false,
      };

      const result = matcher.match(`/${GRPC_REFLECTION_SERVICE_V1}/ServerReflectionInfo`, config);
      expect(result.allowed).toBe(false);
    });
  });

  describe('health check service', () => {
    it('should allow health check by default', () => {
      const config: GrpcRuleConfig = {
        services: ['other.Service'], // Different service, but health should still work
      };

      const result = matcher.match(`/${GRPC_HEALTH_SERVICE}/Check`, config);

      expect(result.allowed).toBe(true);
      expect(result.reason).toContain('Health check service allowed');
    });

    it('should block health check when explicitly disabled', () => {
      const config: GrpcRuleConfig = {
        allowHealthCheck: false,
      };

      const result = matcher.match(`/${GRPC_HEALTH_SERVICE}/Check`, config);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('health check not allowed');
    });
  });

  describe('validateConfig', () => {
    it('should accept valid config', () => {
      const config: GrpcRuleConfig = {
        services: ['myapp.UserService'],
        methods: ['myapp.UserService/GetUser'],
        maxMessageSize: 4 * 1024 * 1024,
        maxConcurrentStreams: 100,
      };

      const errors = GrpcMatcher.validateConfig(config);
      expect(errors).toHaveLength(0);
    });

    it('should reject invalid services', () => {
      const config = {
        services: [123 as any],
      } as GrpcRuleConfig;

      const errors = GrpcMatcher.validateConfig(config);
      expect(errors.length).toBeGreaterThan(0);
    });

    it('should reject invalid methods format', () => {
      const config: GrpcRuleConfig = {
        methods: ['NoSlashInMethod'],
      };

      const errors = GrpcMatcher.validateConfig(config);
      expect(errors.some((e) => e.includes('Service/Method'))).toBe(true);
    });

    it('should reject invalid maxMessageSize', () => {
      const config: GrpcRuleConfig = {
        maxMessageSize: -1,
      };

      const errors = GrpcMatcher.validateConfig(config);
      expect(errors.some((e) => e.includes('maxMessageSize'))).toBe(true);
    });

    it('should reject invalid maxConcurrentStreams', () => {
      const config: GrpcRuleConfig = {
        maxConcurrentStreams: 0,
      };

      const errors = GrpcMatcher.validateConfig(config);
      expect(errors.some((e) => e.includes('maxConcurrentStreams'))).toBe(true);
    });

    it('should reject invalid streamingRateLimit', () => {
      const config: GrpcRuleConfig = {
        streamingRateLimit: -10,
      };

      const errors = GrpcMatcher.validateConfig(config);
      expect(errors.some((e) => e.includes('streamingRateLimit'))).toBe(true);
    });
  });

  describe('createGrpcMatcher', () => {
    it('should create a GrpcMatcher instance', () => {
      const m = createGrpcMatcher();
      expect(m).toBeInstanceOf(GrpcMatcher);
    });
  });
});
