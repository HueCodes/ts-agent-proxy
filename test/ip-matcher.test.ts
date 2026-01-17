import { describe, it, expect } from 'vitest';
import { IpMatcher, createIpMatcher, matchesIp, matchesIpWithExclusion } from '../src/filter/ip-matcher.js';

describe('IpMatcher', () => {
  describe('IPv4 matching', () => {
    it('should match exact IPv4 addresses', () => {
      const matcher = new IpMatcher(['192.168.1.1', '10.0.0.1']);

      expect(matcher.matches('192.168.1.1')).toBe(true);
      expect(matcher.matches('10.0.0.1')).toBe(true);
      expect(matcher.matches('192.168.1.2')).toBe(false);
      expect(matcher.matches('10.0.0.2')).toBe(false);
    });

    it('should match IPv4 CIDR ranges', () => {
      const matcher = new IpMatcher(['192.168.0.0/24']);

      expect(matcher.matches('192.168.0.0')).toBe(true);
      expect(matcher.matches('192.168.0.1')).toBe(true);
      expect(matcher.matches('192.168.0.255')).toBe(true);
      expect(matcher.matches('192.168.1.0')).toBe(false);
      expect(matcher.matches('192.169.0.0')).toBe(false);
    });

    it('should match /16 CIDR ranges', () => {
      const matcher = new IpMatcher(['10.0.0.0/16']);

      expect(matcher.matches('10.0.0.1')).toBe(true);
      expect(matcher.matches('10.0.255.255')).toBe(true);
      expect(matcher.matches('10.1.0.0')).toBe(false);
    });

    it('should match /8 CIDR ranges', () => {
      const matcher = new IpMatcher(['10.0.0.0/8']);

      expect(matcher.matches('10.0.0.1')).toBe(true);
      expect(matcher.matches('10.255.255.255')).toBe(true);
      expect(matcher.matches('11.0.0.0')).toBe(false);
    });

    it('should handle /32 CIDR (exact match)', () => {
      const matcher = new IpMatcher(['192.168.1.100/32']);

      expect(matcher.matches('192.168.1.100')).toBe(true);
      expect(matcher.matches('192.168.1.101')).toBe(false);
    });
  });

  describe('IPv6 matching', () => {
    it('should match exact IPv6 addresses', () => {
      const matcher = new IpMatcher(['::1', '2001:db8::1']);

      expect(matcher.matches('::1')).toBe(true);
      expect(matcher.matches('0:0:0:0:0:0:0:1')).toBe(true);
      expect(matcher.matches('2001:db8::1')).toBe(true);
      expect(matcher.matches('2001:db8::2')).toBe(false);
    });

    it('should match IPv6 CIDR ranges', () => {
      const matcher = new IpMatcher(['2001:db8::/32']);

      expect(matcher.matches('2001:db8::1')).toBe(true);
      expect(matcher.matches('2001:db8:1::1')).toBe(true);
      expect(matcher.matches('2001:db9::1')).toBe(false);
    });

    it('should handle full IPv6 addresses', () => {
      const matcher = new IpMatcher(['2001:0db8:0000:0000:0000:0000:0000:0001']);

      expect(matcher.matches('2001:db8::1')).toBe(true);
    });
  });

  describe('mixed IPv4 and IPv6', () => {
    it('should handle mixed patterns', () => {
      const matcher = new IpMatcher(['192.168.0.0/24', '::1', '2001:db8::/32']);

      expect(matcher.matches('192.168.0.50')).toBe(true);
      expect(matcher.matches('::1')).toBe(true);
      expect(matcher.matches('2001:db8::1')).toBe(true);
      expect(matcher.matches('10.0.0.1')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should return false for invalid IP addresses', () => {
      const matcher = new IpMatcher(['192.168.0.0/24']);

      expect(matcher.matches('invalid')).toBe(false);
      expect(matcher.matches('256.0.0.1')).toBe(false);
      expect(matcher.matches('')).toBe(false);
    });

    it('should handle empty patterns', () => {
      const matcher = new IpMatcher([]);

      expect(matcher.matches('192.168.0.1')).toBe(false);
    });
  });
});

describe('createIpMatcher', () => {
  it('should create a matcher from patterns', () => {
    const matcher = createIpMatcher(['192.168.0.0/24']);
    expect(matcher.matches('192.168.0.1')).toBe(true);
  });
});

describe('matchesIp', () => {
  it('should check if IP matches any pattern', () => {
    expect(matchesIp('192.168.0.50', ['192.168.0.0/24', '10.0.0.0/8'])).toBe(true);
    expect(matchesIp('172.16.0.1', ['192.168.0.0/24', '10.0.0.0/8'])).toBe(false);
  });
});

describe('matchesIpWithExclusion', () => {
  it('should allow IPs in allow list', () => {
    expect(matchesIpWithExclusion('192.168.0.50', ['192.168.0.0/24'])).toBe(true);
  });

  it('should deny IPs not in allow list', () => {
    expect(matchesIpWithExclusion('10.0.0.1', ['192.168.0.0/24'])).toBe(false);
  });

  it('should exclude IPs in exclude list', () => {
    expect(matchesIpWithExclusion(
      '192.168.0.1',
      ['192.168.0.0/24'],
      ['192.168.0.1']
    )).toBe(false);

    expect(matchesIpWithExclusion(
      '192.168.0.50',
      ['192.168.0.0/24'],
      ['192.168.0.1']
    )).toBe(true);
  });

  it('should allow all if no allow list but with exclusions', () => {
    expect(matchesIpWithExclusion('10.0.0.1', undefined, ['192.168.0.1'])).toBe(true);
    expect(matchesIpWithExclusion('192.168.0.1', undefined, ['192.168.0.1'])).toBe(false);
  });

  it('should allow all if no lists', () => {
    expect(matchesIpWithExclusion('10.0.0.1')).toBe(true);
    expect(matchesIpWithExclusion('192.168.0.1', [], [])).toBe(true);
  });
});
