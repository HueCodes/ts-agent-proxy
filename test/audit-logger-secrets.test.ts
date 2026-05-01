import { describe, it, expect } from 'vitest';
import { AuditLogger } from '../src/logging/audit-logger.js';

describe('AuditLogger secret scrubbing', () => {
  it('redacts secret material in request bodies before logging', () => {
    const captured: string[] = [];
    const logger = new AuditLogger({
      loggingLevel: 'full',
      destinations: [
        {
          name: 'capture',
          write: (line) => captured.push(line),
        },
      ],
    });

    const secret = `sk-ant-api03-${'a'.repeat(80)}`;
    logger.logRequest(
      { host: 'evil.example.com', port: 443, method: 'POST', path: '/exfil' },
      { allowed: false, reason: 'no rule' },
      { body: `payload=${secret}`, headers: { authorization: `Bearer ${secret}` } },
    );

    const entry = JSON.parse(captured[0]!);
    expect(JSON.stringify(entry)).not.toContain(secret);
    expect(JSON.stringify(entry)).toContain('[REDACTED:anthropic-key]');
  });

  it('redacts secrets in custom headers even when sensitive header redaction misses', () => {
    const captured: string[] = [];
    const logger = new AuditLogger({
      loggingLevel: 'headers',
      destinations: [{ name: 'capture', write: (line) => captured.push(line) }],
    });

    const secret = `sk-ant-api03-${'b'.repeat(80)}`;
    logger.logRequest(
      { host: 'api.anthropic.com', port: 443, method: 'POST', path: '/v1/messages' },
      { allowed: true, reason: 'ok' },
      { headers: { 'x-custom-header': `${secret}` } },
    );

    const entry = JSON.parse(captured[0]!);
    const headerJson = JSON.stringify(entry.headers ?? {});
    expect(headerJson).not.toContain(secret);
    expect(headerJson).toContain('[REDACTED:anthropic-key]');
  });

  it('passes through entries with no detected secrets unchanged', () => {
    const captured: string[] = [];
    const logger = new AuditLogger({
      loggingLevel: 'full',
      destinations: [{ name: 'capture', write: (line) => captured.push(line) }],
    });

    logger.logRequest(
      { host: 'api.anthropic.com', port: 443, method: 'POST', path: '/v1/messages' },
      { allowed: true, reason: 'ok' },
      { body: '{"prompt":"hello"}' },
    );

    const entry = JSON.parse(captured[0]!);
    expect(entry.body).toBe('{"prompt":"hello"}');
  });

  it('can be disabled via scrubSecrets: false', () => {
    const captured: string[] = [];
    const logger = new AuditLogger({
      loggingLevel: 'full',
      scrubSecrets: false,
      destinations: [{ name: 'capture', write: (line) => captured.push(line) }],
    });

    const secret = `sk-ant-api03-${'c'.repeat(80)}`;
    logger.logRequest(
      { host: 'api.anthropic.com', port: 443, method: 'POST', path: '/v1/messages' },
      { allowed: true, reason: 'ok' },
      { body: `key=${secret}` },
    );

    const entry = JSON.parse(captured[0]!);
    expect(entry.body).toContain(secret);
  });
});
