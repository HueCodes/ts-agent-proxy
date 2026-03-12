/**
 * Tests for the CertManager module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import forge from 'node-forge';
import fs from 'node:fs';
import {
  CertManager,
  createCertManager,
  DEFAULT_CERT_CACHE_CONFIG,
  type CertManagerOptions,
  type CertificateInfo,
} from '../src/proxy/mitm/cert-manager.js';

/**
 * Helper: generate a self-signed CA cert/key pair (PEM strings) for test use.
 */
function generateTestCa(): { certPem: string; keyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
  const attrs = [
    { name: 'commonName', value: 'Test CA' },
    { name: 'organizationName', value: 'Test Org' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'basicConstraints', cA: true }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

describe('CertManager', () => {
  describe('construction', () => {
    it('should construct with default options', () => {
      const mgr = new CertManager();
      expect(mgr.isInitialized()).toBe(false);
    });

    it('should construct with custom cache config', () => {
      const mgr = new CertManager({ cacheConfig: { maxSize: 5, ttlMs: 1000 } });
      expect(mgr.getCacheSize()).toBe(0);
    });
  });

  describe('CA generation (autoGenerate)', () => {
    let mgr: CertManager;

    beforeEach(async () => {
      mgr = new CertManager({ autoGenerate: true });
      await mgr.initialize();
    });

    it('should initialize with auto-generated CA', () => {
      expect(mgr.isInitialized()).toBe(true);
    });

    it('should return CA cert PEM', () => {
      const pem = mgr.getCaCertPem();
      expect(pem).toContain('-----BEGIN CERTIFICATE-----');
      expect(pem).toContain('-----END CERTIFICATE-----');
    });

    it('should return CA key PEM', () => {
      const pem = mgr.getCaKeyPem();
      expect(pem).toContain('-----BEGIN RSA PRIVATE KEY-----');
      expect(pem).toContain('-----END RSA PRIVATE KEY-----');
    });

    it('should generate a valid CA certificate', () => {
      const certPem = mgr.getCaCertPem();
      const cert = forge.pki.certificateFromPem(certPem);
      const cn = cert.subject.getField('CN');
      expect(cn.value).toBe('Agent Network Proxy CA');
    });

    it('should generate CA with 10-year validity', () => {
      const certPem = mgr.getCaCertPem();
      const cert = forge.pki.certificateFromPem(certPem);
      const notBefore = cert.validity.notBefore;
      const notAfter = cert.validity.notAfter;
      const yearDiff = notAfter.getFullYear() - notBefore.getFullYear();
      expect(yearDiff).toBe(10);
    });

    it('should generate CA with basicConstraints cA=true', () => {
      const certPem = mgr.getCaCertPem();
      const cert = forge.pki.certificateFromPem(certPem);
      const bc = cert.getExtension('basicConstraints') as { cA: boolean } | null;
      expect(bc).not.toBeNull();
      expect(bc!.cA).toBe(true);
    });
  });

  describe('loading CA from files', () => {
    let ca: { certPem: string; keyPem: string };

    beforeEach(() => {
      ca = generateTestCa();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should load CA cert and key from provided paths', async () => {
      vi.spyOn(fs, 'readFileSync').mockImplementation((filePath: any) => {
        if (String(filePath).endsWith('ca.crt')) return ca.certPem;
        if (String(filePath).endsWith('ca.key')) return ca.keyPem;
        throw new Error('unexpected path');
      });

      const mgr = new CertManager({ caCertPath: '/tmp/ca.crt', caKeyPath: '/tmp/ca.key' });
      await mgr.initialize();

      expect(mgr.isInitialized()).toBe(true);
      expect(mgr.getCaCertPem()).toContain('BEGIN CERTIFICATE');
      expect(mgr.getCaKeyPem()).toContain('BEGIN RSA PRIVATE KEY');
    });

    it('should throw if CA paths are set but loading fails', async () => {
      vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const mgr = new CertManager({ caCertPath: '/no/such.crt', caKeyPath: '/no/such.key' });
      await expect(mgr.initialize()).rejects.toThrow('ENOENT');
    });
  });

  describe('getCaCertPem / getCaKeyPem without init', () => {
    it('should throw when getCaCertPem called before init', () => {
      const mgr = new CertManager();
      expect(() => mgr.getCaCertPem()).toThrow('CA not initialized');
    });

    it('should throw when getCaKeyPem called before init', () => {
      const mgr = new CertManager();
      expect(() => mgr.getCaKeyPem()).toThrow('CA not initialized');
    });
  });

  describe('leaf certificate generation', () => {
    let mgr: CertManager;

    beforeEach(async () => {
      mgr = new CertManager({ autoGenerate: true });
      await mgr.initialize();
    });

    it('should generate a cert for a domain', () => {
      const info = mgr.generateCertForDomain('example.com');
      expect(info.cert).toContain('BEGIN CERTIFICATE');
      expect(info.key).toContain('BEGIN RSA PRIVATE KEY');
    });

    it('should set CN to the domain', () => {
      const info = mgr.generateCertForDomain('example.com');
      const cert = forge.pki.certificateFromPem(info.cert);
      const cn = cert.subject.getField('CN');
      expect(cn.value).toBe('example.com');
    });

    it('should set issuer to CA subject', () => {
      const info = mgr.generateCertForDomain('example.com');
      const leafCert = forge.pki.certificateFromPem(info.cert);
      const caCert = forge.pki.certificateFromPem(mgr.getCaCertPem());
      expect(leafCert.issuer.getField('CN').value).toBe(caCert.subject.getField('CN').value);
    });

    it('should include SAN extension with the domain', () => {
      const info = mgr.generateCertForDomain('api.example.com');
      const cert = forge.pki.certificateFromPem(info.cert);
      const san = cert.getExtension('subjectAltName') as any;
      expect(san).not.toBeNull();
      expect(san.altNames).toBeDefined();
      const dnsName = san.altNames.find((n: any) => n.type === 2);
      expect(dnsName).toBeDefined();
      expect(dnsName.value).toBe('api.example.com');
    });

    it('should have 1-year validity period', () => {
      const info = mgr.generateCertForDomain('example.com');
      const cert = forge.pki.certificateFromPem(info.cert);
      const yearDiff = cert.validity.notAfter.getFullYear() - cert.validity.notBefore.getFullYear();
      expect(yearDiff).toBe(1);
    });

    it('should have basicConstraints cA=false', () => {
      const info = mgr.generateCertForDomain('example.com');
      const cert = forge.pki.certificateFromPem(info.cert);
      const bc = cert.getExtension('basicConstraints') as any;
      expect(bc).not.toBeNull();
      expect(bc.cA).toBe(false);
    });

    it('should have extKeyUsage with serverAuth', () => {
      const info = mgr.generateCertForDomain('example.com');
      const cert = forge.pki.certificateFromPem(info.cert);
      const eku = cert.getExtension('extKeyUsage') as any;
      expect(eku).not.toBeNull();
      expect(eku.serverAuth).toBe(true);
    });

    it('should be verifiable against the CA cert', () => {
      const info = mgr.generateCertForDomain('example.com');
      const caCert = forge.pki.certificateFromPem(mgr.getCaCertPem());
      const leafCert = forge.pki.certificateFromPem(info.cert);
      expect(() => caCert.verify(leafCert)).not.toThrow();
    });

    it('should throw when CA is not initialized', () => {
      const uninit = new CertManager();
      expect(() => uninit.generateCertForDomain('x.com')).toThrow('CA not initialized');
    });
  });

  describe('certificate caching', () => {
    let mgr: CertManager;

    beforeEach(async () => {
      mgr = new CertManager({ autoGenerate: true, cacheConfig: { maxSize: 3, ttlMs: 0 } });
      await mgr.initialize();
    });

    it('should cache generated certificates', () => {
      const first = mgr.generateCertForDomain('example.com');
      const second = mgr.generateCertForDomain('example.com');
      // Same object reference means it came from cache
      expect(first).toBe(second);
    });

    it('should track cache size', () => {
      mgr.generateCertForDomain('a.com');
      mgr.generateCertForDomain('b.com');
      expect(mgr.getCacheSize()).toBe(2);
    });

    it('should clear cache', () => {
      mgr.generateCertForDomain('a.com');
      mgr.clearCache();
      expect(mgr.getCacheSize()).toBe(0);
    });

    it('should report cache stats', () => {
      mgr.generateCertForDomain('a.com');
      mgr.generateCertForDomain('a.com'); // cache hit
      mgr.generateCertForDomain('b.com'); // cache miss
      const stats = mgr.getCacheStats();
      expect(stats.hits).toBe(1);
      expect(stats.size).toBe(2);
    });
  });

  describe('LRU cache eviction', () => {
    let mgr: CertManager;

    beforeEach(async () => {
      mgr = new CertManager({ autoGenerate: true, cacheConfig: { maxSize: 2, ttlMs: 0 } });
      await mgr.initialize();
    });

    it('should evict least-recently-used cert when cache is full', () => {
      const certA = mgr.generateCertForDomain('a.com');
      mgr.generateCertForDomain('b.com');
      mgr.generateCertForDomain('c.com'); // evicts a.com

      // a.com should be regenerated (new cert), so different object
      const certA2 = mgr.generateCertForDomain('a.com');
      expect(certA2).not.toBe(certA);
      expect(mgr.getCacheSize()).toBe(2);
    });

    it('should evict stats reflect evictions', () => {
      mgr.generateCertForDomain('a.com');
      mgr.generateCertForDomain('b.com');
      mgr.generateCertForDomain('c.com'); // evicts a.com

      const stats = mgr.getCacheStats();
      expect(stats.evictions).toBeGreaterThanOrEqual(1);
    });
  });

  describe('TTL expiration', () => {
    let mgr: CertManager;

    beforeEach(async () => {
      vi.useFakeTimers();
      mgr = new CertManager({ autoGenerate: true, cacheConfig: { maxSize: 10, ttlMs: 5000 } });
      await mgr.initialize();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return cached cert before TTL expires', () => {
      const first = mgr.generateCertForDomain('x.com');
      vi.advanceTimersByTime(3000);
      const second = mgr.generateCertForDomain('x.com');
      expect(first).toBe(second);
    });

    it('should regenerate cert after TTL expires', () => {
      const first = mgr.generateCertForDomain('x.com');
      vi.advanceTimersByTime(6000);
      const second = mgr.generateCertForDomain('x.com');
      expect(first).not.toBe(second);
    });

    it('should prune expired certificates', () => {
      mgr.generateCertForDomain('a.com');
      mgr.generateCertForDomain('b.com');
      vi.advanceTimersByTime(6000);
      const pruned = mgr.pruneCache();
      expect(pruned).toBe(2);
      expect(mgr.getCacheSize()).toBe(0);
    });
  });

  describe('pre-warm cache', () => {
    it('should pre-warm cache with specified domains', async () => {
      const mgr = new CertManager({
        autoGenerate: true,
        cacheConfig: { maxSize: 10, ttlMs: 0, prewarmDomains: ['a.com', 'b.com'] },
      });
      await mgr.initialize();

      expect(mgr.getCacheSize()).toBe(2);
      // Second call should hit cache
      const cert = mgr.generateCertForDomain('a.com');
      expect(cert.cert).toContain('BEGIN CERTIFICATE');
    });
  });

  describe('createCertManager helper', () => {
    it('should return a CertManager instance', () => {
      const mgr = createCertManager({ autoGenerate: true });
      expect(mgr).toBeInstanceOf(CertManager);
    });

    it('should work with no options', () => {
      const mgr = createCertManager();
      expect(mgr).toBeInstanceOf(CertManager);
    });
  });
});
