/**
 * `ts-agent-proxy run -- <child-command>` subcommand.
 *
 * Compress the first 60 seconds: pick a port, generate or load a cached CA,
 * boot the proxy in MITM mode, then spawn the child with HTTPS_PROXY,
 * NODE_EXTRA_CA_CERTS, SSL_CERT_FILE etc. wired in. Forward signals; exit
 * with the child's code; print one block line per denied request.
 */

import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { createProxyServer, type ProxyServer } from '../server.js';
import { createDefaultConfig, type ProxyConfig } from '../types/config.js';
import { createLogger } from '../logging/logger.js';
import { applySafeDefaults } from '../profiles/safe-defaults.js';
import { getProfile, mergeProfile } from '../profiles/index.js';
import { ensureCa, type CaPaths } from './ca-cache.js';
import { writePidfile, removePidfile } from './pidfile.js';

export interface RunOptions {
  /** Profile name (e.g., 'claude-code'). Default: 'generic-agent'. */
  profile: string;
  /** Child command and args (everything after `--`). */
  command: string[];
  /** Optional explicit port; default 0 (assign random). */
  port?: number | undefined;
  /** Disable safe defaults. Loud at startup. */
  unsafeDisableDefaults?: boolean | undefined;
  /** Additional --allow-domain= entries. */
  allowDomains?: string[] | undefined;
  /** Additional --block-domain= entries. */
  blockDomains?: string[] | undefined;
  /** Additional --block-ip-range= entries. */
  blockIpRanges?: string[] | undefined;
}

export interface RunResult {
  /** Exit code propagated from the child. */
  exitCode: number;
  /** The address the proxy bound to. */
  address: { host: string; port: number };
  /** CA materials handed to the child. */
  caPaths: CaPaths;
}

/**
 * Bind a TCP socket to port 0 to discover an unused port. Cheap, races on
 * very heavily loaded systems but acceptable for a local devtool.
 */
async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('Failed to acquire local port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Build a proxy config in MITM mode wired to the cached CA + selected profile.
 */
function buildConfig(
  opts: RunOptions,
  caPaths: CaPaths,
  port: number,
  adminPort: number,
): ProxyConfig {
  const config = createDefaultConfig();
  config.server.host = '127.0.0.1';
  config.server.port = port;
  config.server.mode = 'mitm';
  config.server.tls = {
    caCertPath: caPaths.certPath,
    caKeyPath: caPaths.keyPath,
    autoGenerateCa: false,
  };
  config.server.logging = { ...config.server.logging, level: 'info' };
  // Admin server hosts the audit SSE stream that `tail` consumes.
  config.server.admin = {
    enabled: true,
    host: '127.0.0.1',
    port: adminPort,
  };

  // Apply --profile
  const profileName = opts.profile;
  const profile = getProfile(profileName);
  if (!profile) {
    throw new Error(`Unknown profile "${profileName}".`);
  }
  config.allowlist = mergeProfile(config.allowlist, profile);

  // --allow-domain entries
  for (const domain of opts.allowDomains ?? []) {
    config.allowlist.rules.push({ id: `cli-allow-${config.allowlist.rules.length}`, domain });
  }

  // Safe-defaults + user-block lists
  config.allowlist = applySafeDefaults(config.allowlist, {
    disabled: opts.unsafeDisableDefaults,
    extraBlockDomains: opts.blockDomains,
    extraBlockIpRanges: opts.blockIpRanges,
  });

  return config;
}

/**
 * Build the env vars handed to the child process.
 */
export function buildChildEnv(
  parent: NodeJS.ProcessEnv,
  proxyUrl: string,
  caCertPath: string,
): NodeJS.ProcessEnv {
  return {
    ...parent,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: '',
    no_proxy: '',
    // Make Node-based agents trust the proxy CA without changing the system store.
    NODE_EXTRA_CA_CERTS: caCertPath,
    // curl (libcurl-using tools) and Python requests use this.
    SSL_CERT_FILE: caCertPath,
    REQUESTS_CA_BUNDLE: caCertPath,
  };
}

/**
 * Run the subcommand. Returns once the child has exited.
 */
export async function runUnderProxy(opts: RunOptions): Promise<RunResult> {
  const logger = createLogger({ level: 'info', pretty: true });

  if (opts.command.length === 0) {
    throw new Error('No child command provided. Usage: ts-agent-proxy run -- <command> [args...]');
  }

  const caPaths = ensureCa();
  const port = opts.port ?? (await pickFreePort());
  const adminPort = await pickFreePort();
  const config = buildConfig(opts, caPaths, port, adminPort);
  const proxyUrl = `http://127.0.0.1:${port}`;
  const adminUrl = `http://127.0.0.1:${adminPort}`;

  const server: ProxyServer = createProxyServer({ config, logger });
  await server.start();

  // Pidfile lets `ts-agent-proxy tail` discover this run automatically.
  writePidfile({
    pid: process.pid,
    adminUrl,
    startedAt: new Date().toISOString(),
  });

  logger.info(
    { proxyUrl, adminUrl, profile: opts.profile, command: opts.command.join(' ') },
    `proxy listening on ${proxyUrl} — running: ${opts.command[0]}`,
  );

  const childEnv = buildChildEnv(process.env, proxyUrl, caPaths.certPath);
  const child: ChildProcess = spawn(opts.command[0]!, opts.command.slice(1), {
    env: childEnv,
    stdio: 'inherit',
  });

  let exitCode: number;
  try {
    exitCode = await orchestrateLifecycle(child, server);
  } finally {
    removePidfile();
  }

  return {
    exitCode,
    address: { host: '127.0.0.1', port },
    caPaths,
  };
}

const SHUTDOWN_GRACE_MS = 10_000;

/**
 * Wire up signal forwarding and shutdown sequencing. Returns the child's
 * exit code (or a synthetic code on signal-only termination).
 */
async function orchestrateLifecycle(child: ChildProcess, server: ProxyServer): Promise<number> {
  let shuttingDown = false;

  return new Promise<number>((resolve) => {
    const finalize = async (code: number) => {
      if (shuttingDown) return;
      shuttingDown = true;
      try {
        await server.stop();
      } catch {
        // Best-effort: child already gone, swallow shutdown errors.
      }
      resolve(code);
    };

    child.on('exit', (code, signal) => {
      // Convention: signal-killed children produce 128+signum (POSIX-ish).
      const exitCode = code ?? (signal ? 128 + (signalNum(signal) ?? 0) : 0);
      void finalize(exitCode);
    });
    child.on('error', () => void finalize(1));

    const forward = (sig: NodeJS.Signals) => {
      if (!child.killed && child.pid) {
        try {
          process.kill(child.pid, sig);
        } catch {
          // Child may have already exited.
        }
      }
      // Last-resort kill if child does not exit within the grace window.
      setTimeout(() => {
        if (!child.killed && child.pid) {
          try {
            process.kill(child.pid, 'SIGKILL');
          } catch {
            // Ignore.
          }
        }
      }, SHUTDOWN_GRACE_MS).unref();
    };

    process.on('SIGINT', () => forward('SIGINT'));
    process.on('SIGTERM', () => forward('SIGTERM'));
  });
}

const SIGNAL_NUMS: Record<string, number> = {
  SIGINT: 2,
  SIGQUIT: 3,
  SIGTERM: 15,
  SIGKILL: 9,
};

function signalNum(sig: NodeJS.Signals): number | undefined {
  return SIGNAL_NUMS[sig];
}
