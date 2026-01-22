import { describe, it, expect, beforeEach } from 'vitest';
import { DomainTrie, createDomainTrie } from '../src/filter/domain-trie.js';
import type { AllowlistRule } from '../src/types/allowlist.js';

describe('DomainTrie', () => {
  let trie: DomainTrie;

  beforeEach(() => {
    trie = new DomainTrie();
  });

  describe('exact domain matching', () => {
    it('should match exact domains', () => {
      const rule: AllowlistRule = { id: 'rule1', domain: 'api.example.com' };
      trie.addRule(rule);

      const matches = trie.findMatchingRules('api.example.com');
      expect(matches).toHaveLength(1);
      expect(matches[0].id).toBe('rule1');
    });

    it('should not match different domains', () => {
      const rule: AllowlistRule = { id: 'rule1', domain: 'api.example.com' };
      trie.addRule(rule);

      expect(trie.findMatchingRules('other.example.com')).toHaveLength(0);
      expect(trie.findMatchingRules('example.com')).toHaveLength(0);
      expect(trie.findMatchingRules('api.example.org')).toHaveLength(0);
    });

    it('should be case-insensitive', () => {
      const rule: AllowlistRule = { id: 'rule1', domain: 'API.EXAMPLE.COM' };
      trie.addRule(rule);

      const matches = trie.findMatchingRules('api.example.com');
      expect(matches).toHaveLength(1);
    });

    it('should handle multiple exact domain rules', () => {
      trie.addRule({ id: 'rule1', domain: 'api.example.com' });
      trie.addRule({ id: 'rule2', domain: 'cdn.example.com' });
      trie.addRule({ id: 'rule3', domain: 'api.other.com' });

      expect(trie.findMatchingRules('api.example.com')).toHaveLength(1);
      expect(trie.findMatchingRules('cdn.example.com')).toHaveLength(1);
      expect(trie.findMatchingRules('api.other.com')).toHaveLength(1);
    });
  });

  describe('single-level wildcard matching', () => {
    it('should match *.domain.com pattern', () => {
      const rule: AllowlistRule = { id: 'rule1', domain: '*.example.com' };
      trie.addRule(rule);

      const matches = trie.findMatchingRules('api.example.com');
      expect(matches).toHaveLength(1);
      expect(matches[0].id).toBe('rule1');
    });

    it('should match any single subdomain', () => {
      const rule: AllowlistRule = { id: 'rule1', domain: '*.example.com' };
      trie.addRule(rule);

      expect(trie.findMatchingRules('api.example.com')).toHaveLength(1);
      expect(trie.findMatchingRules('www.example.com')).toHaveLength(1);
      expect(trie.findMatchingRules('cdn.example.com')).toHaveLength(1);
    });

    it('should not match nested subdomains', () => {
      const rule: AllowlistRule = { id: 'rule1', domain: '*.example.com' };
      trie.addRule(rule);

      expect(trie.findMatchingRules('api.v1.example.com')).toHaveLength(0);
      expect(trie.findMatchingRules('a.b.example.com')).toHaveLength(0);
    });

    it('should not match base domain', () => {
      const rule: AllowlistRule = { id: 'rule1', domain: '*.example.com' };
      trie.addRule(rule);

      expect(trie.findMatchingRules('example.com')).toHaveLength(0);
    });
  });

  describe('multi-level wildcard matching', () => {
    it('should match **.domain.com pattern', () => {
      const rule: AllowlistRule = { id: 'rule1', domain: '**.example.com' };
      trie.addRule(rule);

      expect(trie.findMatchingRules('api.example.com')).toHaveLength(1);
    });

    it('should match nested subdomains', () => {
      const rule: AllowlistRule = { id: 'rule1', domain: '**.example.com' };
      trie.addRule(rule);

      expect(trie.findMatchingRules('api.v1.example.com')).toHaveLength(1);
      expect(trie.findMatchingRules('a.b.c.example.com')).toHaveLength(1);
      expect(trie.findMatchingRules('deep.nested.sub.example.com')).toHaveLength(1);
    });

    it('should match single subdomain', () => {
      const rule: AllowlistRule = { id: 'rule1', domain: '**.example.com' };
      trie.addRule(rule);

      expect(trie.findMatchingRules('api.example.com')).toHaveLength(1);
    });
  });

  describe('hasMatch', () => {
    it('should return true for matching domains', () => {
      trie.addRule({ id: 'rule1', domain: 'api.example.com' });

      expect(trie.hasMatch('api.example.com')).toBe(true);
    });

    it('should return false for non-matching domains', () => {
      trie.addRule({ id: 'rule1', domain: 'api.example.com' });

      expect(trie.hasMatch('other.example.com')).toBe(false);
    });

    it('should work with wildcards', () => {
      trie.addRule({ id: 'rule1', domain: '*.example.com' });
      trie.addRule({ id: 'rule2', domain: '**.other.com' });

      expect(trie.hasMatch('api.example.com')).toBe(true);
      expect(trie.hasMatch('a.b.other.com')).toBe(true);
      expect(trie.hasMatch('example.com')).toBe(false);
    });
  });

  describe('disabled rules', () => {
    it('should not add disabled rules', () => {
      trie.addRule({ id: 'rule1', domain: 'api.example.com', enabled: false });

      expect(trie.findMatchingRules('api.example.com')).toHaveLength(0);
      expect(trie.getRuleCount()).toBe(0);
    });

    it('should add enabled rules', () => {
      trie.addRule({ id: 'rule1', domain: 'api.example.com', enabled: true });

      expect(trie.findMatchingRules('api.example.com')).toHaveLength(1);
    });

    it('should add rules with undefined enabled', () => {
      trie.addRule({ id: 'rule1', domain: 'api.example.com' });

      expect(trie.findMatchingRules('api.example.com')).toHaveLength(1);
    });
  });

  describe('clear', () => {
    it('should remove all rules', () => {
      trie.addRule({ id: 'rule1', domain: 'api.example.com' });
      trie.addRule({ id: 'rule2', domain: '*.other.com' });

      trie.clear();

      expect(trie.findMatchingRules('api.example.com')).toHaveLength(0);
      expect(trie.getRuleCount()).toBe(0);
    });
  });

  describe('statistics', () => {
    it('should track rule count', () => {
      trie.addRule({ id: 'rule1', domain: 'api.example.com' });
      trie.addRule({ id: 'rule2', domain: 'cdn.example.com' });

      expect(trie.getRuleCount()).toBe(2);
    });

    it('should provide trie stats', () => {
      trie.addRule({ id: 'rule1', domain: 'api.example.com' });
      trie.addRule({ id: 'rule2', domain: 'cdn.example.com' });
      trie.addRule({ id: 'rule3', domain: '*.other.com' });

      const stats = trie.getStats();
      expect(stats.ruleCount).toBe(3);
      expect(stats.exactDomains).toBe(2);
      expect(stats.nodeCount).toBeGreaterThan(0);
      expect(stats.maxDepth).toBeGreaterThan(0);
    });
  });

  describe('multiple rules for same domain', () => {
    it('should return all matching rules', () => {
      trie.addRule({ id: 'rule1', domain: 'api.example.com', methods: ['GET'] });
      trie.addRule({ id: 'rule2', domain: 'api.example.com', methods: ['POST'] });

      const matches = trie.findMatchingRules('api.example.com');
      expect(matches).toHaveLength(2);
      expect(matches.map((r) => r.id)).toContain('rule1');
      expect(matches.map((r) => r.id)).toContain('rule2');
    });
  });
});

describe('createDomainTrie', () => {
  it('should create trie from rules array', () => {
    const rules: AllowlistRule[] = [
      { id: 'rule1', domain: 'api.example.com' },
      { id: 'rule2', domain: '*.other.com' },
      { id: 'rule3', domain: '**.deep.com' },
    ];

    const trie = createDomainTrie(rules);

    expect(trie.getRuleCount()).toBe(3);
    expect(trie.findMatchingRules('api.example.com')).toHaveLength(1);
    expect(trie.findMatchingRules('sub.other.com')).toHaveLength(1);
    expect(trie.findMatchingRules('a.b.deep.com')).toHaveLength(1);
  });

  it('should skip disabled rules', () => {
    const rules: AllowlistRule[] = [
      { id: 'rule1', domain: 'api.example.com', enabled: true },
      { id: 'rule2', domain: 'other.com', enabled: false },
    ];

    const trie = createDomainTrie(rules);

    expect(trie.getRuleCount()).toBe(1);
  });
});
