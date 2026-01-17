/**
 * Dynamic certificate generation for MITM proxy mode.
 */

import forge from 'node-forge';
import fs from 'node:fs';
import path from 'node:path';

export interface CertificateInfo {
  cert: string;
  key: string;
}

export interface CertManagerOptions {
  /** Path to CA certificate */
  caCertPath?: string;
  /** Path to CA private key */
  caKeyPath?: string;
  /** Auto-generate CA if not provided */
  autoGenerate?: boolean;
  /** Directory to cache generated certificates */
  cacheDir?: string;
}

export class CertManager {
  private caCert: forge.pki.Certificate | null = null;
  private caKey: forge.pki.rsa.PrivateKey | null = null;
  private readonly certCache: Map<string, CertificateInfo> = new Map();
  private readonly options: CertManagerOptions;

  constructor(options: CertManagerOptions = {}) {
    this.options = options;
  }

  /**
   * Initialize the certificate manager.
   */
  async initialize(): Promise<void> {
    if (this.options.caCertPath && this.options.caKeyPath) {
      // Load existing CA
      await this.loadCa();
    } else if (this.options.autoGenerate) {
      // Generate new CA
      this.generateCa();
    }
  }

  /**
   * Load CA certificate and key from files.
   */
  private async loadCa(): Promise<void> {
    if (!this.options.caCertPath || !this.options.caKeyPath) {
      throw new Error('CA certificate and key paths are required');
    }

    const certPem = fs.readFileSync(this.options.caCertPath, 'utf-8');
    const keyPem = fs.readFileSync(this.options.caKeyPath, 'utf-8');

    this.caCert = forge.pki.certificateFromPem(certPem);
    this.caKey = forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey;
  }

  /**
   * Generate a new CA certificate.
   */
  private generateCa(): void {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();

    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

    const attrs = [
      { name: 'commonName', value: 'Agent Network Proxy CA' },
      { name: 'organizationName', value: 'Agent Network Proxy' },
    ];

    cert.setSubject(attrs);
    cert.setIssuer(attrs);

    cert.setExtensions([
      { name: 'basicConstraints', cA: true },
      {
        name: 'keyUsage',
        keyCertSign: true,
        digitalSignature: true,
        cRLSign: true,
      },
    ]);

    cert.sign(keys.privateKey, forge.md.sha256.create());

    this.caCert = cert;
    this.caKey = keys.privateKey;
  }

  /**
   * Get CA certificate in PEM format.
   */
  getCaCertPem(): string {
    if (!this.caCert) {
      throw new Error('CA not initialized');
    }
    return forge.pki.certificateToPem(this.caCert);
  }

  /**
   * Get CA private key in PEM format.
   */
  getCaKeyPem(): string {
    if (!this.caKey) {
      throw new Error('CA not initialized');
    }
    return forge.pki.privateKeyToPem(this.caKey);
  }

  /**
   * Generate a certificate for a specific domain.
   */
  generateCertForDomain(domain: string): CertificateInfo {
    // Check cache first
    const cached = this.certCache.get(domain);
    if (cached) {
      return cached;
    }

    if (!this.caCert || !this.caKey) {
      throw new Error('CA not initialized');
    }

    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();

    cert.publicKey = keys.publicKey;
    cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

    const attrs = [{ name: 'commonName', value: domain }];

    cert.setSubject(attrs);
    cert.setIssuer(this.caCert.subject.attributes);

    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true,
      },
      {
        name: 'extKeyUsage',
        serverAuth: true,
      },
      {
        name: 'subjectAltName',
        altNames: [{ type: 2, value: domain }],
      },
    ]);

    cert.sign(this.caKey, forge.md.sha256.create());

    const certInfo: CertificateInfo = {
      cert: forge.pki.certificateToPem(cert),
      key: forge.pki.privateKeyToPem(keys.privateKey),
    };

    // Cache the certificate
    this.certCache.set(domain, certInfo);

    return certInfo;
  }

  /**
   * Clear the certificate cache.
   */
  clearCache(): void {
    this.certCache.clear();
  }

  /**
   * Check if the manager is initialized.
   */
  isInitialized(): boolean {
    return this.caCert !== null && this.caKey !== null;
  }
}

/**
 * Create a certificate manager.
 */
export function createCertManager(options: CertManagerOptions = {}): CertManager {
  return new CertManager(options);
}
