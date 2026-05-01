import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Writable } from 'node:stream';
import { writePidfile, readPidfile, removePidfile, isProcessAlive } from '../src/cli/pidfile.js';
import { formatEntry, formatHeader, resolveAdminUrl, tail } from '../src/cli/tail.js';
import { createProxyServer, type ProxyServer } from '../src/server.js';
import type { ProxyConfig } from '../src/types/config.js';
import { applySafeDefaults } from '../src/profiles/safe-defaults.js';

class CapturingStream extends Writable {
  chunks: string[] = [];
  override _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }
}

describe('Pidfile', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-pidfile-'));
    file = path.join(dir, 'run.pid');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('write -> read roundtrip', () => {
    writePidfile(
      { pid: 1234, adminUrl: 'http://127.0.0.1:9999', startedAt: new Date().toISOString() },
      file,
    );
    const got = readPidfile(file);
    expect(got?.pid).toBe(1234);
    expect(got?.adminUrl).toBe('http://127.0.0.1:9999');
  });

  it('returns null when file missing', () => {
    expect(readPidfile(file)).toBeNull();
  });

  it('returns null when file is junk', () => {
    fs.writeFileSync(file, 'not-json');
    expect(readPidfile(file)).toBeNull();
  });

  it('removePidfile is idempotent', () => {
    expect(() => removePidfile(file)).not.toThrow();
    writePidfile({ pid: 1, adminUrl: 'x', startedAt: 'y' }, file);
    removePidfile(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('reports the current process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('reports an obviously-dead pid as not alive', () => {
    expect(isProcessAlive(2 ** 30)).toBe(false);
  });
});

describe('formatEntry', () => {
  it('renders allowed entries in columnar form by default', () => {
    const entry = {
      requestId: 'r1',
      timestamp: '2026-04-30T14:02:11.000Z',
      eventType: 'request' as const,
      decision: 'allowed' as const,
      request: { host: 'api.anthropic.com', port: 443, method: 'POST', path: '/v1/messages' },
      matchResult: {
        allowed: true,
        reason: 'ok',
        matchedRule: { id: 'profile:claude-code', domain: 'api.anthropic.com' },
      },
    };
    const out = formatEntry(entry);
    expect(out).toMatch(/14:02:11/);
    expect(out).toMatch(/ALLOW/);
    expect(out).toMatch(/api\.anthropic\.com/);
  });

  it('renders denied entries with the reason', () => {
    const entry = {
      requestId: 'r2',
      timestamp: '2026-04-30T14:02:14.000Z',
      eventType: 'request' as const,
      decision: 'denied' as const,
      request: { host: '169.254.169.254', port: 80, method: 'GET', path: '/' },
      matchResult: { allowed: false, reason: 'safe-default IMDS' },
      denialReason: { code: 'NO_MATCHING_RULE' as const, message: 'safe-default IMDS' },
    };
    const out = formatEntry(entry);
    expect(out).toMatch(/BLOCK/);
    expect(out).toMatch(/safe-default IMDS/);
  });

  it('drops allows when blocksOnly is set', () => {
    const entry = {
      requestId: 'r1',
      timestamp: '2026-04-30T14:02:11.000Z',
      eventType: 'request' as const,
      decision: 'allowed' as const,
      request: { host: 'api.anthropic.com', port: 443 },
      matchResult: { allowed: true, reason: 'ok' },
    };
    expect(formatEntry(entry, { blocksOnly: true })).toBeNull();
  });

  it('emits raw JSON when json is set', () => {
    const entry = {
      requestId: 'r1',
      timestamp: '2026-04-30T14:02:11.000Z',
      eventType: 'request' as const,
      decision: 'denied' as const,
      request: { host: 'evil.com', port: 443 },
      matchResult: { allowed: false, reason: 'no rule' },
    };
    const out = formatEntry(entry, { json: true });
    expect(out).toBeTruthy();
    expect(JSON.parse(out!)).toMatchObject({ decision: 'denied' });
  });
});

describe('formatHeader', () => {
  it('renders a header line', () => {
    expect(formatHeader()).toMatch(/TIME.*VERDICT.*METHOD.*HOST.*PATH.*REASON/);
  });
});

describe('resolveAdminUrl', () => {
  it('returns the explicit override unchanged', () => {
    expect(resolveAdminUrl({ adminUrl: 'http://example.com:1234' })).toBe(
      'http://example.com:1234',
    );
  });

  it('throws when no pidfile and no override', () => {
    // Use a unique tmp pidfile path that won't collide with reality.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-no-pid-'));
    try {
      // Override XDG_CACHE_HOME to point at our empty tmp dir.
      const prev = process.env.XDG_CACHE_HOME;
      process.env.XDG_CACHE_HOME = tmp;
      try {
        expect(() => resolveAdminUrl({})).toThrow(/No running ts-agent-proxy/);
      } finally {
        if (prev === undefined) delete process.env.XDG_CACHE_HOME;
        else process.env.XDG_CACHE_HOME = prev;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('tail end-to-end against a live admin server', () => {
  let server: ProxyServer;
  let adminPort: number;

  beforeEach(async () => {
    const config: ProxyConfig = {
      server: {
        host: '127.0.0.1',
        port: 0,
        mode: 'tunnel',
        logging: { level: 'error', console: false },
        admin: { enabled: true, host: '127.0.0.1', port: 0 },
      },
      allowlist: applySafeDefaults({
        mode: 'strict',
        defaultAction: 'deny',
        rules: [{ id: 'allow', domain: 'allowed.example.com' }],
      }),
    };
    server = createProxyServer({ config });
    await server.start();
    // Discover admin port from the embedded admin server. We don't expose it
    // directly, so fish the address out of the underlying http server.
    const adminHttpServer: { address(): { port: number } | null } | undefined = (
      server as unknown as { adminServer?: { server?: { address(): { port: number } | null } } }
    ).adminServer?.server;
    const addr = adminHttpServer?.address();
    if (!addr) throw new Error('admin server did not expose an address');
    adminPort = addr.port;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('streams a denied request through the SSE endpoint', async () => {
    const stdout = new CapturingStream();

    // Drive a denied request through the proxy on a delay so the tail subscriber
    // is in place when the audit event fires.
    setTimeout(() => {
      // Push a synthetic audit event via the proxy's match -> auditLogger path.
      // Easier: directly call the audit logger.
      const auditLogger = (server as unknown as { auditLogger: { logRequest: Function } })
        .auditLogger;
      auditLogger.logRequest(
        { host: '169.254.169.254', port: 80, method: 'GET', path: '/' },
        { allowed: false, reason: 'safe-default IMDS' },
        { durationMs: 1 },
      );
    }, 50);

    await tail({
      adminUrl: `http://127.0.0.1:${adminPort}`,
      blocksOnly: true,
      maxEvents: 1,
      stdout,
    });

    const body = stdout.chunks.join('');
    expect(body).toMatch(/BLOCK/);
    expect(body).toMatch(/169\.254\.169\.254/);
  }, 15000);
});
