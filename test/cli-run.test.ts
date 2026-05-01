import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  resolveCaCacheDir,
  ensureCa,
  inspectCa,
  generateCa,
  caPaths,
} from '../src/cli/ca-cache.js';
import { buildChildEnv, runUnderProxy } from '../src/cli/run.js';

describe('CA cache', () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-ca-test-'));
  });

  afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it('reports missing when no files exist', () => {
    expect(inspectCa(caPaths(scratchDir))).toBe('missing');
  });

  it('generates a usable CA on demand', () => {
    const paths = ensureCa(caPaths(scratchDir));
    expect(fs.existsSync(paths.certPath)).toBe(true);
    expect(fs.existsSync(paths.keyPath)).toBe(true);
    expect(inspectCa(paths)).toBe('usable');
  });

  it('reuses an existing usable CA across calls', () => {
    ensureCa(caPaths(scratchDir));
    const certBefore = fs.readFileSync(caPaths(scratchDir).certPath, 'utf-8');
    ensureCa(caPaths(scratchDir));
    const certAfter = fs.readFileSync(caPaths(scratchDir).certPath, 'utf-8');
    expect(certAfter).toBe(certBefore);
  });

  it('reports invalid when the cert file is corrupt', () => {
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.writeFileSync(caPaths(scratchDir).certPath, 'not a real PEM');
    fs.writeFileSync(caPaths(scratchDir).keyPath, 'not a real PEM');
    expect(inspectCa(caPaths(scratchDir))).toBe('invalid');
  });

  it('regenerates on top of invalid material', () => {
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.writeFileSync(caPaths(scratchDir).certPath, 'corrupt');
    fs.writeFileSync(caPaths(scratchDir).keyPath, 'corrupt');
    ensureCa(caPaths(scratchDir));
    expect(inspectCa(caPaths(scratchDir))).toBe('usable');
  });

  it('places the directory under the user cache dir on Linux/macOS', () => {
    if (process.platform === 'win32') return;
    const dir = resolveCaCacheDir();
    expect(dir).toMatch(/ts-agent-proxy/);
    expect(dir).toContain(process.env.HOME ?? os.homedir());
  });
});

describe('buildChildEnv', () => {
  it('overrides HTTPS_PROXY/HTTP_PROXY/NO_PROXY and forwards parent vars', () => {
    const parent = { PATH: '/usr/bin', HOME: '/home/test' } as NodeJS.ProcessEnv;
    const env = buildChildEnv(parent, 'http://127.0.0.1:54321', '/tmp/ca.pem');
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:54321');
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:54321');
    expect(env.http_proxy).toBe('http://127.0.0.1:54321');
    expect(env.https_proxy).toBe('http://127.0.0.1:54321');
    expect(env.NO_PROXY).toBe('');
    expect(env.no_proxy).toBe('');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/tmp/ca.pem');
    expect(env.SSL_CERT_FILE).toBe('/tmp/ca.pem');
    expect(env.REQUESTS_CA_BUNDLE).toBe('/tmp/ca.pem');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/test');
  });
});

describe('runUnderProxy', () => {
  it('refuses to start without a child command', async () => {
    await expect(runUnderProxy({ profile: 'generic-agent', command: [] })).rejects.toThrow(
      /No child command/,
    );
  });

  it('rejects an unknown profile', async () => {
    await expect(runUnderProxy({ profile: 'made-up-profile', command: ['true'] })).rejects.toThrow(
      /Unknown profile/,
    );
  });

  it("propagates the child's exit code", async () => {
    const result = await runUnderProxy({
      profile: 'generic-agent',
      command: ['sh', '-c', 'exit 7'],
    });
    expect(result.exitCode).toBe(7);
  }, 30000);

  it('exits 0 when the child exits 0', async () => {
    const result = await runUnderProxy({
      profile: 'generic-agent',
      command: ['true'],
    });
    expect(result.exitCode).toBe(0);
  }, 30000);

  it('passes proxy env vars into the child shell', async () => {
    // Sanity-check that HTTPS_PROXY shows up. The child writes it to a temp
    // file that we read back.
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-run-out-'));
    const target = path.join(out, 'env.txt');
    try {
      const result = await runUnderProxy({
        profile: 'generic-agent',
        command: ['sh', '-c', `printf '%s' "$HTTPS_PROXY" > "${target}"`],
      });
      expect(result.exitCode).toBe(0);
      const recorded = fs.readFileSync(target, 'utf-8');
      expect(recorded).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 30000);
});

describe('generateCa', () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-ca-test-'));
  });

  afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it('writes ca.pem and ca-key.pem with restrictive key permissions', () => {
    generateCa(caPaths(scratchDir));
    const keyMode = fs.statSync(caPaths(scratchDir).keyPath).mode & 0o777;
    // Key should not be world-readable.
    expect(keyMode & 0o077).toBe(0);
  });
});
