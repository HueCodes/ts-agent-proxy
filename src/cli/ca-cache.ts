/**
 * Persistent on-disk cache for the proxy's CA certificate + key.
 *
 * The CA is generated once and reused across `ts-agent-proxy run` invocations
 * so the user only has to deal with the cert once (or, ideally, never — the
 * `run` flow injects the CA into the child via env vars without touching the
 * system trust store). The CA is regenerated if it's missing, unparseable,
 * or expiring within 30 days.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import forge from 'node-forge';

const RENEW_WITHIN_DAYS = 30;

export interface CaPaths {
  /** Directory the CA materials live in. */
  dir: string;
  /** Path to the CA certificate (PEM). */
  certPath: string;
  /** Path to the CA private key (PEM). */
  keyPath: string;
}

/**
 * Resolve the user-scoped cache directory used to hold the CA materials.
 *
 * Linux/macOS: $XDG_CACHE_HOME/ts-agent-proxy/ or ~/.cache/ts-agent-proxy/.
 * Windows: %LOCALAPPDATA%\ts-agent-proxy\ falling back to USERPROFILE.
 */
export function resolveCaCacheDir(): string {
  if (process.platform === 'win32') {
    const base =
      process.env.LOCALAPPDATA ??
      path.join(process.env.USERPROFILE ?? os.homedir(), 'AppData', 'Local');
    return path.join(base, 'ts-agent-proxy');
  }
  const base = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
  return path.join(base, 'ts-agent-proxy');
}

export function caPaths(dir: string = resolveCaCacheDir()): CaPaths {
  return {
    dir,
    certPath: path.join(dir, 'ca.pem'),
    keyPath: path.join(dir, 'ca-key.pem'),
  };
}

/**
 * Inspect the cached CA. Returns:
 *   - 'usable' if the cert is present, parseable, and not expiring soon.
 *   - 'missing' if either file is absent.
 *   - 'invalid' if the files exist but the cert can't be parsed.
 *   - 'expiring' if the cert expires within RENEW_WITHIN_DAYS days.
 */
export function inspectCa(
  paths: CaPaths = caPaths(),
): 'usable' | 'missing' | 'invalid' | 'expiring' {
  if (!fs.existsSync(paths.certPath) || !fs.existsSync(paths.keyPath)) {
    return 'missing';
  }
  let cert: forge.pki.Certificate;
  try {
    cert = forge.pki.certificateFromPem(fs.readFileSync(paths.certPath, 'utf-8'));
  } catch {
    return 'invalid';
  }
  const renewBoundary = new Date();
  renewBoundary.setDate(renewBoundary.getDate() + RENEW_WITHIN_DAYS);
  if (cert.validity.notAfter <= renewBoundary) {
    return 'expiring';
  }
  return 'usable';
}

/**
 * Generate a fresh CA pair and write it to the cache dir.
 *
 * Writes are atomic: each output is written to a `.tmp.<pid>` sibling and
 * then `rename`d into place, so a concurrent reader (a second `run`
 * invocation that just loaded the previous CA) never sees a torn file.
 */
export function generateCa(paths: CaPaths = caPaths()): void {
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  const attrs = [
    { name: 'commonName', value: 'ts-agent-proxy local CA' },
    { name: 'organizationName', value: 'ts-agent-proxy' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true, cRLSign: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  atomicWriteFile(paths.certPath, forge.pki.certificateToPem(cert), 0o644);
  atomicWriteFile(paths.keyPath, forge.pki.privateKeyToPem(keys.privateKey), 0o600);
}

function atomicWriteFile(target: string, contents: string, mode: number): void {
  const tmp = `${target}.tmp.${process.pid}`;
  // The `mode` arg sets POSIX permissions; on Windows, Node largely ignores
  // it and the inherited NTFS ACL applies. The cache lives under the
  // per-user %LOCALAPPDATA%, so exposure is limited to processes running
  // as the same user — but operators on shared workstations should be aware
  // that the key file is not 0o600 there.
  fs.writeFileSync(tmp, contents, { mode });
  fs.renameSync(tmp, target);
}

/**
 * Lockfile-coordinated CA provisioning. Two concurrent `run` invocations
 * arriving at an empty cache would otherwise both run `generateCa` and
 * race on the file writes; the second writer would clobber the cert the
 * first proxy had already loaded into memory.
 *
 * The lock is taken with `O_EXCL`. If we can't get it, we wait for the
 * other writer to finish and re-inspect — by which point the CA is
 * usually `usable`.
 */
export function ensureCa(paths: CaPaths = caPaths()): CaPaths {
  if (inspectCa(paths) === 'usable') return paths;

  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const lockPath = `${paths.certPath}.lock`;

  let lockFd: number | undefined;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      lockFd = fs.openSync(lockPath, 'wx');
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      // Stale-lock heuristic: if it's older than 60s, steal it.
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > 60_000) fs.unlinkSync(lockPath);
      } catch {
        // Lock vanished between stat and unlink — fine.
      }
      // Brief wait before retrying.
      const deadline = Date.now() + 100;
      while (Date.now() < deadline) {
        // Busy-wait is acceptable here: total wait capped at ~5s, and
        // ensureCa runs once per process startup.
      }
      // Another writer may have finished in the meantime.
      if (inspectCa(paths) === 'usable') return paths;
    }
  }

  if (lockFd === undefined) {
    throw new Error(
      `Could not acquire CA lockfile at ${lockPath} after retries; remove it manually if stale.`,
    );
  }

  try {
    // Re-check under the lock — another process may have written between
    // our pre-lock inspect and now.
    if (inspectCa(paths) !== 'usable') {
      generateCa(paths);
    }
  } finally {
    fs.closeSync(lockFd);
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Already gone.
    }
  }

  return paths;
}
