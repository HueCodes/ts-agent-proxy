/**
 * Pidfile coordination between `run` (the producer) and `tail` (the consumer).
 *
 * The pidfile lives at $XDG_CACHE_HOME/ts-agent-proxy/run.pid (or the OS
 * equivalent) and records the proxy's pid + admin URL so a separate tail
 * invocation can find a running instance without configuration.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveCaCacheDir } from './ca-cache.js';

export interface PidfilePayload {
  pid: number;
  adminUrl: string;
  startedAt: string;
}

export function pidfilePath(dir: string = resolveCaCacheDir()): string {
  return path.join(dir, 'run.pid');
}

export function writePidfile(payload: PidfilePayload, file: string = pidfilePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Atomic write: tmp + rename so a concurrent reader never sees a torn JSON.
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Per-pid pidfile path. The shared run.pid points to whichever proxy
 * `tail` should attach to (the most recent one); the per-pid file lets
 * the owning process clean up only its own entry on shutdown.
 */
export function perPidFilePath(pid: number = process.pid, dir?: string): string {
  return path.join(path.dirname(pidfilePath(dir)), `run.${pid}.pid`);
}

/**
 * Refuse to start a second `run` if a live one already holds the
 * canonical pidfile. Returns the existing pid + admin URL when one is
 * found and alive; null otherwise.
 *
 * Stale pidfiles (process gone) are removed automatically.
 */
export function checkForLiveRun(file: string = pidfilePath()): PidfilePayload | null {
  const existing = readPidfile(file);
  if (!existing) return null;
  if (isProcessAlive(existing.pid)) return existing;
  // Stale: pid is gone, remove it so the next writer can claim the slot.
  removePidfile(file);
  return null;
}

export function readPidfile(file: string = pidfilePath()): PidfilePayload | null {
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as PidfilePayload;
    if (typeof data.pid !== 'number' || typeof data.adminUrl !== 'string') return null;
    return data;
  } catch {
    return null;
  }
}

export function removePidfile(file: string = pidfilePath()): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone.
  }
}

/**
 * Best-effort liveness check: if kill(0) fails with ESRCH, the pid is dead.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
