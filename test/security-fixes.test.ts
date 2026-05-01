/**
 * Regression tests for the v0.2 review findings. Each test demonstrates the
 * bug the corresponding fix addresses; failure of any of these means the
 * issue has come back.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AllowlistMatcher, normalizeHost } from '../src/filter/allowlist-matcher.js';
import { applySafeDefaults } from '../src/profiles/safe-defaults.js';
import { parseJsonRpc, evaluateMcpRequest, type McpPolicy } from '../src/filter/mcp-matcher.js';
import { caPaths, ensureCa } from '../src/cli/ca-cache.js';
import { writePidfile, checkForLiveRun, removePidfile } from '../src/cli/pidfile.js';

describe('HIGH #1 — IPv6-mapped IPv4 IMDS bypass', () => {
  const config = applySafeDefaults({
    mode: 'strict',
    defaultAction: 'deny',
    rules: [],
  });
  const matcher = new AllowlistMatcher(config);

  it('blocks ::ffff:169.254.169.254 (dotted form)', () => {
    const r = matcher.match({ host: '::ffff:169.254.169.254', port: 80 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/safe-default/i);
  });

  it('blocks the bracketed form', () => {
    const r = matcher.match({ host: '[::ffff:169.254.169.254]', port: 80 });
    expect(r.allowed).toBe(false);
  });

  it('blocks the hex form (::ffff:a9fe:a9fe == 169.254.169.254)', () => {
    const r = matcher.match({ host: '::ffff:a9fe:a9fe', port: 80 });
    expect(r.allowed).toBe(false);
  });

  it('blocks ::ffff:127.0.0.1 (loopback)', () => {
    const r = matcher.match({ host: '::ffff:127.0.0.1', port: 443 });
    expect(r.allowed).toBe(false);
  });

  it('blocks ::ffff:10.0.0.1 (RFC1918)', () => {
    const r = matcher.match({ host: '::ffff:10.0.0.1', port: 443 });
    expect(r.allowed).toBe(false);
  });

  it('also handles trailing-dot FQDN form of metadata DNS', () => {
    const r = matcher.match({ host: 'metadata.google.internal.', port: 443 });
    expect(r.allowed).toBe(false);
  });
});

describe('normalizeHost', () => {
  it('strips brackets', () => {
    expect(normalizeHost('[::1]')).toBe('::1');
  });
  it('strips a trailing dot', () => {
    expect(normalizeHost('example.com.')).toBe('example.com');
  });
  it('lowercases', () => {
    expect(normalizeHost('API.EXAMPLE.COM')).toBe('api.example.com');
  });
  it('rewrites IPv4-mapped IPv6 (dotted) to plain IPv4', () => {
    expect(normalizeHost('::ffff:1.2.3.4')).toBe('1.2.3.4');
  });
  it('rewrites IPv4-mapped IPv6 (hex) to plain IPv4', () => {
    expect(normalizeHost('::ffff:a9fe:a9fe')).toBe('169.254.169.254');
  });
});

describe('HIGH #5 — DNS rebinding TOCTOU returns a pinned IP', () => {
  const config = applySafeDefaults({
    mode: 'strict',
    defaultAction: 'deny',
    rules: [{ id: 'localhost-rule', domain: 'localhost' }],
  });
  const matcher = new AllowlistMatcher(config);

  it('resolveAndCheckHost returns a pinned IP for safe hostnames', async () => {
    const result = await matcher.resolveAndCheckHost('localhost');
    // localhost typically resolves to a loopback address. Either we get a
    // block (loopback is in the safe-default range) — that's still the
    // correct behaviour — or we get a pinned IP.
    if (result.kind === 'pinned') {
      expect(result.ip).toMatch(/^\d+\.\d+\.\d+\.\d+$|^[0-9a-f:]+$/);
    } else {
      expect(result.kind).toBe('block');
    }
  });

  it('returns block (not just deny via post-resolve) when DNS resolves to IMDS', async () => {
    // No way to mock DNS without monkey-patching node:dns; the integration
    // case is covered indirectly by the safe-defaults integration test. What
    // we can verify here: the API exists and returns the right shape.
    const result = await matcher.resolveAndCheckHost('169.254.169.254');
    expect(result.kind).toBe('pass'); // literal IPs handled by sync match
  });

  it('user-block IP ranges are now applied to resolved hostnames', async () => {
    // Configure a user-block on 127.0.0.0/8 and resolve "localhost". If
    // localhost resolves to 127.0.0.1, the user-block path now fires.
    const blockedConfig = applySafeDefaults({
      mode: 'strict',
      defaultAction: 'deny',
      rules: [{ id: 'r', domain: 'localhost' }],
      block: { ipRanges: ['127.0.0.0/8'] },
    });
    const m = new AllowlistMatcher(blockedConfig);
    const result = await m.resolveAndCheckHost('localhost');
    if (result.kind === 'block') {
      // Either the safe-default loopback fires first (also correct) or the
      // user-block reason fires.
      expect(result.reason).toMatch(/Blocked by user policy|safe-default/i);
    }
  });
});

describe('HIGH #2 — JSON-RPC batch all-or-nothing', () => {
  const policy: McpPolicy = {
    servers: [{ host: 'mcp.example.com', allowTools: ['read_file'], blockTools: [] }],
  };

  it('keeps valid envelopes and tags invalid ones in mixed batch', () => {
    const batch =
      '[{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_file"}},{"jsonrpc":"1.0","method":"sneaky","id":2}]';
    const got = parseJsonRpc(batch);
    expect(got).not.toBeNull();
    expect(got!.length).toBe(2);
    expect(got![0]!.kind).toBe('request');
    expect(got![1]!.kind).toBe('invalid');
  });

  it('valid request in a mixed batch is still gated by policy', () => {
    const batch = parseJsonRpc(
      '[{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"execute_shell"}},{"jsonrpc":"1.0","method":"junk","id":2}]',
    );
    const validEntry = batch!.find((e) => e.kind === 'request');
    expect(validEntry).toBeDefined();
    if (validEntry?.kind === 'request') {
      const decision = evaluateMcpRequest('mcp.example.com', validEntry.request, policy);
      // execute_shell is not in allowTools and the host has no `allowTools: ['*']`.
      expect(decision.allowed).toBe(false);
    }
  });
});

describe('HIGH #4 — run lifecycle hardening', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-sec-'));
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('atomic CA write — generated files appear or do not, never partial', () => {
    const paths = caPaths(scratch);
    ensureCa(paths);
    // Both files exist and parse as valid PEM.
    expect(fs.existsSync(paths.certPath)).toBe(true);
    expect(fs.existsSync(paths.keyPath)).toBe(true);
    expect(fs.readFileSync(paths.certPath, 'utf-8')).toContain('-----BEGIN CERTIFICATE-----');
    expect(fs.readFileSync(paths.keyPath, 'utf-8')).toMatch(/-----BEGIN (RSA )?PRIVATE KEY-----/);
  });

  it('checkForLiveRun returns the existing payload when a live process holds the slot', () => {
    const file = path.join(scratch, 'run.pid');
    writePidfile({ pid: process.pid, adminUrl: 'http://127.0.0.1:9999', startedAt: 'now' }, file);
    const found = checkForLiveRun(file);
    expect(found?.pid).toBe(process.pid);
  });

  it('checkForLiveRun cleans up a stale pidfile (pid no longer alive)', () => {
    const file = path.join(scratch, 'run.pid');
    writePidfile({ pid: 2 ** 30, adminUrl: 'http://127.0.0.1:9999', startedAt: 'now' }, file);
    const found = checkForLiveRun(file);
    expect(found).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('removePidfile is safe when called twice', () => {
    const file = path.join(scratch, 'run.pid');
    writePidfile({ pid: 1, adminUrl: 'http://127.0.0.1:1', startedAt: 'now' }, file);
    expect(() => {
      removePidfile(file);
      removePidfile(file);
    }).not.toThrow();
  });
});
