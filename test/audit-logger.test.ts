import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import {
  AuditLogger,
  createAuditLogger,
  DenialReasonCode,
  DEFAULT_PII_PATTERNS,
} from '../src/logging/audit-logger.js';
import type { RequestInfo, MatchResult } from '../src/types/allowlist.js';

describe('AuditLogger', () => {
  const testLogPath = '/tmp/audit-test.log';

  afterEach(() => {
    if (fs.existsSync(testLogPath)) {
      fs.unlinkSync(testLogPath);
    }
  });

  describe('basic logging', () => {
    it('should log allowed requests', async () => {
      const logger = new AuditLogger({ filePath: testLogPath, logToMain: false });

      const request: RequestInfo = { host: 'api.example.com', port: 443, method: 'GET', path: '/users' };
      const matchResult: MatchResult = { allowed: true, reason: 'Matched rule', matchedRule: { id: 'test', domain: 'api.example.com' } };

      logger.logRequest(request, matchResult);
      await logger.close();

      const content = fs.readFileSync(testLogPath, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.decision).toBe('allowed');
      expect(entry.request.host).toBe('api.example.com');
      expect(entry.matchResult.matchedRule.id).toBe('test');
    });

    it('should log denied requests', async () => {
      const logger = new AuditLogger({ filePath: testLogPath, logToMain: false });

      const request: RequestInfo = { host: 'blocked.com', port: 443 };
      const matchResult: MatchResult = { allowed: false, reason: 'No matching rule' };

      logger.logRequest(request, matchResult);
      await logger.close();

      const content = fs.readFileSync(testLogPath, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.decision).toBe('denied');
      expect(entry.denialReason).toBeDefined();
      expect(entry.denialReason.code).toBe(DenialReasonCode.NO_MATCHING_RULE);
    });

    it('should include response info', async () => {
      const logger = new AuditLogger({ filePath: testLogPath, logToMain: false });

      const request: RequestInfo = { host: 'api.example.com', port: 443 };
      const matchResult: MatchResult = { allowed: true, reason: 'Matched' };

      logger.logRequest(request, matchResult, {
        response: { statusCode: 200, statusMessage: 'OK', contentLength: 1024 },
        durationMs: 150,
      });
      await logger.close();

      const content = fs.readFileSync(testLogPath, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.response.statusCode).toBe(200);
      expect(entry.durationMs).toBe(150);
    });

    it('should include trace IDs', async () => {
      const logger = new AuditLogger({ filePath: testLogPath, logToMain: false });

      const request: RequestInfo = { host: 'api.example.com', port: 443 };
      const matchResult: MatchResult = { allowed: true, reason: 'Matched' };

      logger.logRequest(request, matchResult, {
        traceId: 'abc123',
        spanId: 'def456',
      });
      await logger.close();

      const content = fs.readFileSync(testLogPath, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.traceId).toBe('abc123');
      expect(entry.spanId).toBe('def456');
    });
  });

  describe('logging levels', () => {
    it('should not log headers at minimal level', async () => {
      const logger = new AuditLogger({
        filePath: testLogPath,
        logToMain: false,
        loggingLevel: 'minimal',
      });

      const request: RequestInfo = { host: 'api.example.com', port: 443 };
      const matchResult: MatchResult = { allowed: true, reason: 'Matched' };

      logger.logRequest(request, matchResult, {
        headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
      });
      await logger.close();

      const content = fs.readFileSync(testLogPath, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.headers).toBeUndefined();
    });

    it('should log headers at headers level', async () => {
      const logger = new AuditLogger({
        filePath: testLogPath,
        logToMain: false,
        loggingLevel: 'headers',
      });

      const request: RequestInfo = { host: 'api.example.com', port: 443 };
      const matchResult: MatchResult = { allowed: true, reason: 'Matched' };

      logger.logRequest(request, matchResult, {
        headers: { 'content-type': 'application/json' },
      });
      await logger.close();

      const content = fs.readFileSync(testLogPath, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.headers).toBeDefined();
      expect(entry.headers['content-type']).toBe('application/json');
    });

    it('should log body at full level', async () => {
      const logger = new AuditLogger({
        filePath: testLogPath,
        logToMain: false,
        loggingLevel: 'full',
      });

      const request: RequestInfo = { host: 'api.example.com', port: 443 };
      const matchResult: MatchResult = { allowed: true, reason: 'Matched' };

      logger.logRequest(request, matchResult, {
        body: '{"test": true}',
      });
      await logger.close();

      const content = fs.readFileSync(testLogPath, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.body).toBe('{"test": true}');
    });

    it('should not log at none level', async () => {
      const logger = new AuditLogger({
        filePath: testLogPath,
        logToMain: false,
        loggingLevel: 'none',
      });

      const request: RequestInfo = { host: 'api.example.com', port: 443 };
      const matchResult: MatchResult = { allowed: true, reason: 'Matched' };

      logger.logRequest(request, matchResult, {
        headers: { 'content-type': 'application/json' },
        body: '{"test": true}',
      });
      await logger.close();

      const content = fs.readFileSync(testLogPath, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.headers).toBeUndefined();
      expect(entry.body).toBeUndefined();
    });
  });

  describe('header redaction', () => {
    it('should redact sensitive headers', async () => {
      const logger = new AuditLogger({
        filePath: testLogPath,
        logToMain: false,
        loggingLevel: 'headers',
      });

      const request: RequestInfo = { host: 'api.example.com', port: 443 };
      const matchResult: MatchResult = { allowed: true, reason: 'Matched' };

      logger.logRequest(request, matchResult, {
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer secret-token',
          'x-api-key': 'my-secret-key',
          cookie: 'session=abc123',
        },
      });
      await logger.close();

      const content = fs.readFileSync(testLogPath, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.headers['content-type']).toBe('application/json');
      expect(entry.headers.authorization).toBe('[REDACTED]');
      expect(entry.headers['x-api-key']).toBe('[REDACTED]');
      expect(entry.headers.cookie).toBe('[REDACTED]');
    });
  });

  describe('PII scrubbing', () => {
    it('should scrub credit card numbers', async () => {
      const logger = new AuditLogger({
        filePath: testLogPath,
        logToMain: false,
        loggingLevel: 'full',
        piiScrubbing: { enabled: true },
      });

      const request: RequestInfo = { host: 'api.example.com', port: 443 };
      const matchResult: MatchResult = { allowed: true, reason: 'Matched' };

      logger.logRequest(request, matchResult, {
        body: '{"card": "4111-1111-1111-1111", "name": "John"}',
      });
      await logger.close();

      const content = fs.readFileSync(testLogPath, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.body).toContain('[REDACTED]');
      expect(entry.body).not.toContain('4111-1111-1111-1111');
    });

    it('should scrub email addresses', async () => {
      const logger = new AuditLogger({
        filePath: testLogPath,
        logToMain: false,
        loggingLevel: 'full',
        piiScrubbing: { enabled: true },
      });

      const request: RequestInfo = { host: 'api.example.com', port: 443 };
      const matchResult: MatchResult = { allowed: true, reason: 'Matched' };

      logger.logRequest(request, matchResult, {
        body: '{"email": "user@example.com"}',
      });
      await logger.close();

      const content = fs.readFileSync(testLogPath, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.body).toContain('[REDACTED]');
      expect(entry.body).not.toContain('user@example.com');
    });

    it('should use custom replacement text', async () => {
      const logger = new AuditLogger({
        filePath: testLogPath,
        logToMain: false,
        loggingLevel: 'full',
        piiScrubbing: { enabled: true, replacement: '***SCRUBBED***' },
      });

      const request: RequestInfo = { host: 'api.example.com', port: 443 };
      const matchResult: MatchResult = { allowed: true, reason: 'Matched' };

      logger.logRequest(request, matchResult, {
        body: '{"email": "user@example.com"}',
      });
      await logger.close();

      const content = fs.readFileSync(testLogPath, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.body).toContain('***SCRUBBED***');
    });
  });

  describe('sampling', () => {
    it('should respect sampling rate', async () => {
      const logger = new AuditLogger({
        filePath: testLogPath,
        logToMain: false,
        samplingRate: 0,
      });

      const request: RequestInfo = { host: 'api.example.com', port: 443 };
      const matchResult: MatchResult = { allowed: true, reason: 'Matched' };

      // With 0 sampling rate, nothing should be logged
      for (let i = 0; i < 10; i++) {
        logger.logRequest(request, matchResult);
      }
      await logger.close();

      const content = fs.readFileSync(testLogPath, 'utf-8');
      expect(content.trim()).toBe('');
    });

    it('should log all with sampling rate 1.0', async () => {
      const logger = new AuditLogger({
        filePath: testLogPath,
        logToMain: false,
        samplingRate: 1.0,
      });

      const request: RequestInfo = { host: 'api.example.com', port: 443 };
      const matchResult: MatchResult = { allowed: true, reason: 'Matched' };

      for (let i = 0; i < 3; i++) {
        logger.logRequest(request, matchResult);
      }
      await logger.close();

      const content = fs.readFileSync(testLogPath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBe(3);
    });
  });

  describe('status code filtering', () => {
    it('should only log specified status codes', async () => {
      const logger = new AuditLogger({
        filePath: testLogPath,
        logToMain: false,
        logStatusCodes: [500, 502, 503],
      });

      const request: RequestInfo = { host: 'api.example.com', port: 443 };
      const matchResult: MatchResult = { allowed: true, reason: 'Matched' };

      logger.logRequest(request, matchResult, { response: { statusCode: 200 } });
      logger.logRequest(request, matchResult, { response: { statusCode: 500 } });
      logger.logRequest(request, matchResult, { response: { statusCode: 502 } });
      await logger.close();

      const content = fs.readFileSync(testLogPath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBe(2);
    });
  });

  describe('rate limit logging', () => {
    it('should log rate limit events', async () => {
      const logger = new AuditLogger({ filePath: testLogPath, logToMain: false });

      const request: RequestInfo = { host: 'api.example.com', port: 443 };

      logger.logRateLimit(request, {
        allowed: false,
        remaining: 0,
        resetMs: 60000,
        limit: 100,
        headers: {
          'X-RateLimit-Limit': '100',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': '12345',
        },
      });
      await logger.close();

      const content = fs.readFileSync(testLogPath, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.eventType).toBe('rate_limit');
      expect(entry.decision).toBe('rate_limited');
      expect(entry.rateLimitResult.remaining).toBe(0);
    });
  });

  describe('error logging', () => {
    it('should log error events', async () => {
      const logger = new AuditLogger({ filePath: testLogPath, logToMain: false });

      const request: RequestInfo = { host: 'api.example.com', port: 443 };

      logger.logError(request, new Error('Connection timeout'));
      await logger.close();

      const content = fs.readFileSync(testLogPath, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.eventType).toBe('error');
      expect(entry.decision).toBe('denied');
      expect(entry.errorMessage).toBe('Connection timeout');
    });
  });

  describe('multiple destinations', () => {
    it('should write to multiple destinations', async () => {
      const mockDest = { name: 'mock', write: vi.fn(), flush: vi.fn(), close: vi.fn() };

      const logger = new AuditLogger({
        filePath: testLogPath,
        logToMain: false,
        destinations: [mockDest],
      });

      const request: RequestInfo = { host: 'api.example.com', port: 443 };
      const matchResult: MatchResult = { allowed: true, reason: 'Matched' };

      logger.logRequest(request, matchResult);
      await logger.close();

      expect(mockDest.write).toHaveBeenCalled();
      expect(mockDest.close).toHaveBeenCalled();
    });
  });

  describe('logging level control', () => {
    it('should get logging level', () => {
      const logger = new AuditLogger({ loggingLevel: 'headers' });
      expect(logger.getLoggingLevel()).toBe('headers');
    });

    it('should set logging level', () => {
      const logger = new AuditLogger({ loggingLevel: 'minimal' });
      logger.setLoggingLevel('full');
      expect(logger.getLoggingLevel()).toBe('full');
    });

    it('should set sampling rate', async () => {
      const logger = new AuditLogger({
        filePath: testLogPath,
        logToMain: false,
        samplingRate: 1.0,
      });

      logger.setSamplingRate(0);

      const request: RequestInfo = { host: 'api.example.com', port: 443 };
      const matchResult: MatchResult = { allowed: true, reason: 'Matched' };

      logger.logRequest(request, matchResult);
      await logger.close();

      const content = fs.readFileSync(testLogPath, 'utf-8');
      expect(content.trim()).toBe('');
    });
  });
});

describe('createAuditLogger', () => {
  it('should create an AuditLogger', () => {
    const logger = createAuditLogger();
    expect(logger).toBeInstanceOf(AuditLogger);
  });
});
