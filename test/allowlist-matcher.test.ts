import { describe, it, expect } from 'vitest';
import { AllowlistMatcher, createAllowlistMatcher } from '../src/filter/allowlist-matcher.js';
import type { AllowlistConfig, RequestInfo } from '../src/types/allowlist.js';

describe('AllowlistMatcher', () => {
  const testConfig: AllowlistConfig = {
    mode: 'strict',
    defaultAction: 'deny',
    rules: [
      {
        id: 'openai',
        domain: 'api.openai.com',
        paths: ['/v1/chat/completions', '/v1/models'],
        methods: ['POST', 'GET'],
      },
      {
        id: 'github',
        domain: 'api.github.com',
        paths: ['/repos/**', '/users/**'],
        methods: ['GET'],
      },
      {
        id: 'wildcard',
        domain: '*.example.com',
        paths: ['/**'],
        methods: ['GET', 'POST'],
      },
      {
        id: 'disabled-rule',
        domain: 'disabled.com',
        enabled: false,
      },
    ],
  };

  describe('domain matching', () => {
    it('should allow matching domains', () => {
      const matcher = createAllowlistMatcher(testConfig);
      const result = matcher.match({ host: 'api.openai.com', port: 443 });

      expect(result.allowed).toBe(true);
      expect(result.matchedRule?.id).toBe('openai');
    });

    it('should deny non-matching domains', () => {
      const matcher = createAllowlistMatcher(testConfig);
      const result = matcher.match({ host: 'evil.com', port: 443 });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('deny');
    });

    it('should match wildcard domains', () => {
      const matcher = createAllowlistMatcher(testConfig);
      const result = matcher.match({ host: 'api.example.com', port: 443 });

      expect(result.allowed).toBe(true);
      expect(result.matchedRule?.id).toBe('wildcard');
    });

    it('should skip disabled rules', () => {
      const matcher = createAllowlistMatcher(testConfig);
      const result = matcher.match({ host: 'disabled.com', port: 443 });

      expect(result.allowed).toBe(false);
    });
  });

  describe('path matching', () => {
    it('should match exact paths', () => {
      const matcher = createAllowlistMatcher(testConfig);
      const result = matcher.match({
        host: 'api.openai.com',
        port: 443,
        path: '/v1/chat/completions',
        method: 'POST',
      });

      expect(result.allowed).toBe(true);
    });

    it('should match glob paths', () => {
      const matcher = createAllowlistMatcher(testConfig);
      const result = matcher.match({
        host: 'api.github.com',
        port: 443,
        path: '/repos/owner/repo/issues',
        method: 'GET',
      });

      expect(result.allowed).toBe(true);
    });

    it('should deny non-matching paths', () => {
      const matcher = createAllowlistMatcher(testConfig);
      const result = matcher.match({
        host: 'api.openai.com',
        port: 443,
        path: '/admin/secret',
        method: 'POST',
      });

      expect(result.allowed).toBe(false);
    });
  });

  describe('method matching', () => {
    it('should match allowed methods', () => {
      const matcher = createAllowlistMatcher(testConfig);
      const result = matcher.match({
        host: 'api.openai.com',
        port: 443,
        path: '/v1/models',
        method: 'GET',
      });

      expect(result.allowed).toBe(true);
    });

    it('should deny non-allowed methods', () => {
      const matcher = createAllowlistMatcher(testConfig);
      const result = matcher.match({
        host: 'api.github.com',
        port: 443,
        path: '/repos/owner/repo',
        method: 'DELETE',
      });

      expect(result.allowed).toBe(false);
    });
  });

  describe('isDomainAllowed', () => {
    it('should check domain-only matching for CONNECT mode', () => {
      const matcher = createAllowlistMatcher(testConfig);

      expect(matcher.isDomainAllowed('api.openai.com').allowed).toBe(true);
      expect(matcher.isDomainAllowed('evil.com').allowed).toBe(false);
    });
  });

  describe('reload', () => {
    it('should reload configuration', () => {
      const matcher = createAllowlistMatcher(testConfig);

      const newConfig: AllowlistConfig = {
        mode: 'strict',
        defaultAction: 'deny',
        rules: [{ id: 'new-rule', domain: 'new.example.com' }],
      };

      matcher.reload(newConfig);

      expect(matcher.isDomainAllowed('api.openai.com').allowed).toBe(false);
      expect(matcher.isDomainAllowed('new.example.com').allowed).toBe(true);
    });
  });

  describe('default action allow', () => {
    it('should allow when default action is allow', () => {
      const permissiveConfig: AllowlistConfig = {
        mode: 'permissive',
        defaultAction: 'allow',
        rules: [],
      };

      const matcher = createAllowlistMatcher(permissiveConfig);
      const result = matcher.match({ host: 'any.domain.com', port: 443 });

      expect(result.allowed).toBe(true);
      expect(result.reason).toContain('allow');
    });
  });
});
