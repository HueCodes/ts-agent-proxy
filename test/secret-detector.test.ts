import { describe, it, expect } from 'vitest';
import { detectSecrets, redact } from '../src/filter/secret-detector.js';

describe('detectSecrets', () => {
  it('catches Anthropic API keys in body', () => {
    const body = `{"key": "sk-ant-api03-${'a'.repeat(80)}"}`;
    const detections = detectSecrets(body);
    expect(detections.some((d) => d.pattern === 'anthropic-key')).toBe(true);
  });

  it('catches OpenAI keys in body', () => {
    const body = `OPENAI_API_KEY=sk-proj-${'X'.repeat(48)}`;
    const detections = detectSecrets(body);
    expect(detections.some((d) => d.pattern === 'openai-key')).toBe(true);
  });

  it('catches GitHub PAT in headers', () => {
    const detections = detectSecrets(null, {
      authorization: `Bearer ghp_${'A'.repeat(40)}`,
    });
    expect(detections.some((d) => d.pattern === 'github-token')).toBe(true);
  });

  it('catches AWS access keys', () => {
    const body = 'AKIAIOSFODNN7EXAMPLE';
    const detections = detectSecrets(body);
    expect(detections.some((d) => d.pattern === 'aws-access-key')).toBe(true);
  });

  it('catches Slack tokens', () => {
    const body = `xoxb-${'1'.repeat(20)}-${'A'.repeat(20)}`;
    const detections = detectSecrets(body);
    expect(detections.some((d) => d.pattern === 'slack-token')).toBe(true);
  });

  it('does not flag a bare git commit SHA in JSON', () => {
    const sha = '5f3aaa1b9e2c6d4f0a8b7c5e3d2f1a9b8c7d6e5f';
    const body = `{"commit": "${sha}"}`;
    const detections = detectSecrets(body);
    expect(detections.find((d) => d.pattern === 'github-classic-token')).toBeUndefined();
  });

  it('flags a 40-char hex with explicit token context', () => {
    const sha = '5f3aaa1b9e2c6d4f0a8b7c5e3d2f1a9b8c7d6e5f';
    const detections = detectSecrets(`Authorization: token ${sha}`);
    expect(detections.some((d) => d.pattern === 'github-classic-token')).toBe(true);
  });

  it('honours a custom maxBytes cap', () => {
    const tail = `sk-ant-api03-${'B'.repeat(80)}`;
    const filler = 'x'.repeat(70_000);
    const body = filler + tail;
    const detections = detectSecrets(body, {}, { maxBytes: 1024 });
    expect(detections.some((d) => d.pattern === 'anthropic-key')).toBe(false);
  });

  it('detects the same secret across body+headers', () => {
    const detections = detectSecrets('hello', {
      'x-anthropic-key': `sk-ant-api03-${'C'.repeat(80)}`,
    });
    expect(detections.some((d) => d.pattern === 'anthropic-key')).toBe(true);
  });

  it('catches Stripe live keys', () => {
    const body = `STRIPE_KEY=sk_live_${'a'.repeat(40)}`;
    const detections = detectSecrets(body);
    expect(detections.some((d) => d.pattern === 'stripe-live-key')).toBe(true);
  });

  it('catches npm tokens', () => {
    const detections = detectSecrets(`//registry.npmjs.org/:_authToken=npm_${'a'.repeat(36)}`);
    expect(detections.some((d) => d.pattern === 'npm-token')).toBe(true);
  });

  it('catches Hugging Face tokens', () => {
    const detections = detectSecrets(`HF_TOKEN=hf_${'A'.repeat(40)}`);
    expect(detections.some((d) => d.pattern === 'huggingface-token')).toBe(true);
  });

  it('catches Vercel tokens', () => {
    const detections = detectSecrets(`vercel_${'a'.repeat(28)}`);
    expect(detections.some((d) => d.pattern === 'vercel-token')).toBe(true);
  });

  it('catches OpenAI service-account keys (sk-svcacct-)', () => {
    const detections = detectSecrets(`OPENAI_KEY=sk-svcacct-${'A'.repeat(48)}`);
    expect(detections.some((d) => d.pattern === 'openai-key')).toBe(true);
  });

  it('catches a JWT only with explicit auth/bearer context', () => {
    const jwt = `eyJ${'A'.repeat(20)}.eyJ${'B'.repeat(20)}.${'C'.repeat(20)}`;
    // Plain occurrence — not flagged.
    expect(detectSecrets(`token: ${jwt}`).some((d) => d.pattern === 'jwt')).toBe(false);
    // With Authorization context — flagged.
    expect(
      detectSecrets(null, { authorization: `Bearer ${jwt}` }).some((d) => d.pattern === 'jwt'),
    ).toBe(true);
  });

  it('does not flag a 40-char base64 blob just because the word "aws" is nearby', () => {
    // Reproduces the medium-severity false positive: a 40-char base64-ish
    // string with the bare keyword "aws" anywhere in a 128-byte window
    // used to be flagged as aws-secret-key.
    const body = `region: aws-us-east-1, etag: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN"`;
    expect(detectSecrets(body).some((d) => d.pattern === 'aws-secret-key')).toBe(false);
  });

  it('still catches AWS secret keys when paired with AKIA in the window', () => {
    const body = `AKIAIOSFODNN7EXAMPLE\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`;
    expect(detectSecrets(body).some((d) => d.pattern === 'aws-secret-key')).toBe(true);
  });

  it('does not flag a sha-40 inside ?token=… now that the weak context is gone', () => {
    const sha = '1234567890abcdef1234567890abcdef12345678';
    const body = `https://example.com/page?token=session_id&commit=${sha}`;
    expect(detectSecrets(body).some((d) => d.pattern === 'github-classic-token')).toBe(false);
  });

  it('survives a custom pattern supplied without /g (no infinite loop)', () => {
    // A regex without /g would cause `regex.exec(...)` in a loop to match
    // the same offset forever. detectSecrets clones the regex with /g
    // forced on, so the call returns rather than hangs.
    const start = Date.now();
    detectSecrets(
      'hello world hello world',
      {},
      {
        patterns: [{ name: 'no-g', regex: /hello/ }],
      },
    );
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('finishes a 64KB scan in well under 10ms', () => {
    const body = `${'.'.repeat(64 * 1024 - 80)}sk-ant-api03-${'D'.repeat(80)}`;
    const start = performance.now();
    detectSecrets(body);
    const duration = performance.now() - start;
    expect(duration).toBeLessThan(10);
  });
});

describe('redact', () => {
  it('replaces detected ranges with [REDACTED:<name>]', () => {
    const body = `{"key": "sk-ant-api03-${'a'.repeat(80)}"}`;
    const detections = detectSecrets(body);
    const out = redact(body, detections);
    expect(out).not.toContain('sk-ant-api03-');
    expect(out).toContain('[REDACTED:anthropic-key]');
  });

  it('is a no-op when there are no detections', () => {
    expect(redact('hello world', [])).toBe('hello world');
  });

  it('handles overlapping detections by replacing right-to-left', () => {
    // Two patterns that share a starting offset: redaction should be stable.
    const body = `key: sk-ant-api03-${'e'.repeat(80)}`;
    const detections = detectSecrets(body);
    const out = redact(body, detections);
    expect(out.indexOf('[REDACTED:')).toBeGreaterThan(-1);
    // Should still be a valid string with no leftover key bytes.
    expect(out).not.toMatch(/sk-ant-api03-[A-Za-z0-9]{10}/);
  });
});
