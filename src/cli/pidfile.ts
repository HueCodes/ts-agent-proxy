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
  fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
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
