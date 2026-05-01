/**
 * `ts-agent-proxy tail` subcommand.
 *
 * Connects to a running proxy's admin SSE stream at /api/audit/stream and
 * formats events for a terminal. Auto-discovers a local proxy via the
 * pidfile written by `run`; falls back to --admin-url for remote/embedded
 * setups.
 */

import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { readPidfile, isProcessAlive } from './pidfile.js';
import type { AuditLogEntry } from '../logging/audit-logger.js';

export interface TailOptions {
  /** Override the admin URL (otherwise read from pidfile). */
  adminUrl?: string | undefined;
  /** Print only blocked / rate-limited entries. */
  blocksOnly?: boolean | undefined;
  /** Print one JSON object per line instead of the columnar view. */
  json?: boolean | undefined;
  /** Replay the last N (e.g. "5m", "30s") on connect. */
  since?: string | undefined;
  /** Output stream (defaults to process.stdout — overridable for tests). */
  stdout?: NodeJS.WritableStream;
  /** Max events before exiting (mainly for tests). */
  maxEvents?: number | undefined;
}

/**
 * Resolve the admin URL: prefer the explicit override, then the pidfile.
 */
export function resolveAdminUrl(opts: TailOptions): string {
  if (opts.adminUrl) return opts.adminUrl;
  const pidfile = readPidfile();
  if (!pidfile) {
    throw new Error(
      'No running ts-agent-proxy found. Start one with `ts-agent-proxy run -- ...` ' +
        'or pass --admin-url=http://host:port.',
    );
  }
  if (!isProcessAlive(pidfile.pid)) {
    throw new Error(
      `Stale pidfile (pid ${pidfile.pid} is not running). Restart the proxy ` +
        'or pass --admin-url=http://host:port.',
    );
  }
  return pidfile.adminUrl;
}

export interface FormatOptions {
  blocksOnly?: boolean | undefined;
  json?: boolean | undefined;
}

/**
 * Render a single audit entry as a single output line.
 */
export function formatEntry(entry: AuditLogEntry, opts: FormatOptions = {}): string | null {
  if (opts.blocksOnly && entry.decision === 'allowed') return null;
  if (opts.json) return JSON.stringify(entry);

  const time = entry.timestamp.slice(11, 19); // HH:MM:SS
  const verdict =
    entry.decision === 'allowed' ? 'ALLOW' : entry.decision === 'rate_limited' ? 'LIMIT' : 'BLOCK';
  const method = (entry.request.method ?? 'CONNECT').padEnd(6).slice(0, 6);
  const host = (entry.request.host ?? '').padEnd(32).slice(0, 32);
  const reqPath = (entry.request.path ?? '').padEnd(24).slice(0, 24);
  const reason =
    entry.denialReason?.message ??
    entry.matchResult?.matchedRule?.id ??
    entry.matchResult?.reason ??
    '';
  return `${time}  ${verdict.padEnd(5)}  ${method}  ${host}  ${reqPath}  ${reason}`;
}

export function formatHeader(): string {
  return ['TIME    ', 'VERDICT', 'METHOD', 'HOST'.padEnd(32), 'PATH'.padEnd(24), 'REASON'].join(
    '  ',
  );
}

/**
 * Open the SSE stream and feed events to the formatter.
 *
 * Returns once the connection is closed by the server or the maxEvents cap
 * is reached. Reconnect/backoff is intentionally not implemented in v0.2 —
 * the typical tail session is short-lived and a one-shot reconnect would
 * mask the underlying failure.
 */
export async function tail(opts: TailOptions): Promise<void> {
  const stdout = opts.stdout ?? process.stdout;
  const adminUrl = resolveAdminUrl(opts);
  const url = new URL('/api/audit/stream', adminUrl);
  if (opts.blocksOnly) url.searchParams.set('include', 'blocks-only');
  if (opts.since) url.searchParams.set('since', opts.since);

  if (!opts.json) {
    stdout.write(formatHeader() + '\n');
  }

  // Pick the right transport based on the URL scheme. Defaults to http
  // because the run subcommand binds the admin server on plain HTTP locally,
  // but operators pointing tail at a remote admin URL behind TLS need https.
  const transport = url.protocol === 'https:' ? https : http;

  await new Promise<void>((resolve, reject) => {
    let count = 0;
    const req = transport.get(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: { Accept: 'text/event-stream' },
      },
      (res: IncomingMessage) => {
        if (res.statusCode !== 200) {
          reject(new Error(`admin stream returned status ${res.statusCode}`));
          return;
        }

        // SSE framing: events are separated by a blank line; within an
        // event, multiple `data:` lines are concatenated with '\n' before
        // parsing. Earlier code parsed each `data:` line as standalone
        // JSON, which silently dropped any payload that contained a newline
        // (stack traces, multi-line denial reasons).
        let buffer = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          // Normalize CRLF so spec-compliant servers using \r\n\r\n event
          // delimiters parse the same way as \n\n ones.
          buffer += chunk.replace(/\r\n/g, '\n');
          const events = buffer.split('\n\n');
          buffer = events.pop() ?? '';
          for (const evt of events) {
            const dataLines: string[] = [];
            for (const line of evt.split('\n')) {
              // SSE allows `data:foo` and `data: foo`; both strip exactly
              // one leading space if present.
              if (line.startsWith('data:')) {
                const value = line.slice(5).startsWith(' ') ? line.slice(6) : line.slice(5);
                dataLines.push(value);
              }
            }
            if (dataLines.length === 0) continue;
            const json = dataLines.join('\n').trim();
            if (!json) continue;
            try {
              const entry = JSON.parse(json) as AuditLogEntry;
              const formatted = formatEntry(entry, opts);
              if (formatted !== null) stdout.write(formatted + '\n');
              count++;
              if (opts.maxEvents !== undefined && count >= opts.maxEvents) {
                res.destroy();
                resolve();
                return;
              }
            } catch {
              // Drop malformed payloads silently — keeps the stream alive.
            }
          }
        });
        res.on('end', () => resolve());
        res.on('error', reject);
      },
    );
    req.on('error', reject);
  });
}
