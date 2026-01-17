import { describe, it, expect } from 'vitest';
import { DomainMatcher, matchesDomain } from '../src/filter/domain-matcher.js';

describe('DomainMatcher', () => {
  describe('exact matching', () => {
    it('should match exact domains', () => {
      const matcher = new DomainMatcher('api.example.com');
      expect(matcher.matches('api.example.com')).toBe(true);
      expect(matcher.matches('API.EXAMPLE.COM')).toBe(true); // Case insensitive
      expect(matcher.matches('other.example.com')).toBe(false);
      expect(matcher.matches('example.com')).toBe(false);
    });
  });

  describe('single wildcard (*)', () => {
    it('should match one subdomain level', () => {
      const matcher = new DomainMatcher('*.example.com');
      expect(matcher.matches('api.example.com')).toBe(true);
      expect(matcher.matches('www.example.com')).toBe(true);
      expect(matcher.matches('example.com')).toBe(false);
      expect(matcher.matches('foo.bar.example.com')).toBe(false);
    });
  });

  describe('double wildcard (**)', () => {
    it('should match any subdomain depth', () => {
      const matcher = new DomainMatcher('**.example.com');
      expect(matcher.matches('api.example.com')).toBe(true);
      expect(matcher.matches('foo.bar.example.com')).toBe(true);
      expect(matcher.matches('a.b.c.example.com')).toBe(true);
      expect(matcher.matches('example.com')).toBe(true);
    });
  });

  describe('options', () => {
    it('should support case-sensitive matching', () => {
      const matcher = new DomainMatcher('api.example.com', { caseInsensitive: false });
      expect(matcher.matches('api.example.com')).toBe(true);
      expect(matcher.matches('API.example.com')).toBe(false);
    });

    it('should support disabling wildcards', () => {
      const matcher = new DomainMatcher('*.example.com', { allowWildcards: false });
      expect(matcher.matches('*.example.com')).toBe(true);
      expect(matcher.matches('api.example.com')).toBe(false);
    });
  });
});

describe('matchesDomain', () => {
  it('should match against multiple patterns', () => {
    const patterns = ['api.example.com', '*.github.com', '**.internal.com'];

    expect(matchesDomain('api.example.com', patterns)).toBe(true);
    expect(matchesDomain('api.github.com', patterns)).toBe(true);
    expect(matchesDomain('deep.nested.internal.com', patterns)).toBe(true);
    expect(matchesDomain('evil.com', patterns)).toBe(false);
  });
});
