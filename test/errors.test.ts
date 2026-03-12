import { describe, it, expect } from 'vitest';
import {
  ProxyError,
  ConfigurationError,
  RateLimitExceededError,
  DomainNotAllowedError,
  PathNotAllowedError,
  MethodNotAllowedError,
  CertificateError,
  UpstreamConnectionError,
} from '../src/errors.js';

describe('ProxyError', () => {
  it('should construct with message and code', () => {
    const err = new ProxyError('test message', 'TEST_CODE');
    expect(err.message).toBe('test message');
    expect(err.code).toBe('TEST_CODE');
    expect(err.name).toBe('ProxyError');
  });

  it('should be an instance of Error', () => {
    const err = new ProxyError('msg', 'CODE');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ProxyError);
  });

  it('should have a stack trace', () => {
    const err = new ProxyError('msg', 'CODE');
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain('ProxyError');
  });

  it('should serialize to JSON', () => {
    const err = new ProxyError('test message', 'TEST_CODE');
    const json = err.toJSON();
    expect(json).toEqual({
      name: 'ProxyError',
      code: 'TEST_CODE',
      message: 'test message',
    });
  });

  it('should serialize with JSON.stringify', () => {
    const err = new ProxyError('msg', 'CODE');
    const parsed = JSON.parse(JSON.stringify(err));
    expect(parsed.name).toBe('ProxyError');
    expect(parsed.code).toBe('CODE');
    expect(parsed.message).toBe('msg');
  });
});

describe('ConfigurationError', () => {
  it('should construct with message only', () => {
    const err = new ConfigurationError('bad config');
    expect(err.message).toBe('bad config');
    expect(err.code).toBe('CONFIG_ERROR');
    expect(err.name).toBe('ConfigurationError');
    expect(err.path).toBeUndefined();
    expect(err.details).toBeUndefined();
  });

  it('should construct with path and details', () => {
    const details = [{ field: 'port', error: 'must be a number' }];
    const err = new ConfigurationError('invalid', '/etc/config.json', details);
    expect(err.path).toBe('/etc/config.json');
    expect(err.details).toEqual(details);
  });

  it('should inherit from ProxyError', () => {
    const err = new ConfigurationError('msg');
    expect(err).toBeInstanceOf(ProxyError);
    expect(err).toBeInstanceOf(Error);
  });

  it('should serialize to JSON with path and details', () => {
    const err = new ConfigurationError('bad', '/config.json', { key: 'value' });
    const json = err.toJSON();
    expect(json).toEqual({
      name: 'ConfigurationError',
      code: 'CONFIG_ERROR',
      message: 'bad',
      path: '/config.json',
      details: { key: 'value' },
    });
  });

  it('should serialize undefined path and details as undefined', () => {
    const err = new ConfigurationError('msg');
    const json = err.toJSON();
    expect(json.path).toBeUndefined();
    expect(json.details).toBeUndefined();
  });
});

describe('RateLimitExceededError', () => {
  it('should construct with ruleId and retryAfter', () => {
    const err = new RateLimitExceededError('api-rule', 30);
    expect(err.message).toBe("Rate limit exceeded for rule 'api-rule'");
    expect(err.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(err.name).toBe('RateLimitExceededError');
    expect(err.ruleId).toBe('api-rule');
    expect(err.retryAfter).toBe(30);
    expect(err.clientIp).toBeUndefined();
  });

  it('should construct with clientIp', () => {
    const err = new RateLimitExceededError('rule-1', 60, '192.168.1.1');
    expect(err.clientIp).toBe('192.168.1.1');
  });

  it('should inherit from ProxyError', () => {
    const err = new RateLimitExceededError('rule', 10);
    expect(err).toBeInstanceOf(ProxyError);
  });

  it('should serialize to JSON', () => {
    const err = new RateLimitExceededError('rule-1', 45, '10.0.0.1');
    const json = err.toJSON();
    expect(json).toEqual({
      name: 'RateLimitExceededError',
      code: 'RATE_LIMIT_EXCEEDED',
      message: "Rate limit exceeded for rule 'rule-1'",
      ruleId: 'rule-1',
      retryAfter: 45,
      clientIp: '10.0.0.1',
    });
  });
});

describe('DomainNotAllowedError', () => {
  it('should construct with domain', () => {
    const err = new DomainNotAllowedError('evil.com');
    expect(err.message).toBe("Domain 'evil.com' is not in the allowlist");
    expect(err.code).toBe('DOMAIN_NOT_ALLOWED');
    expect(err.name).toBe('DomainNotAllowedError');
    expect(err.domain).toBe('evil.com');
    expect(err.reason).toBeUndefined();
  });

  it('should construct with reason', () => {
    const err = new DomainNotAllowedError('blocked.com', 'blacklisted');
    expect(err.reason).toBe('blacklisted');
  });

  it('should inherit from ProxyError', () => {
    const err = new DomainNotAllowedError('x.com');
    expect(err).toBeInstanceOf(ProxyError);
  });

  it('should serialize to JSON', () => {
    const err = new DomainNotAllowedError('bad.com', 'not whitelisted');
    const json = err.toJSON();
    expect(json).toEqual({
      name: 'DomainNotAllowedError',
      code: 'DOMAIN_NOT_ALLOWED',
      message: "Domain 'bad.com' is not in the allowlist",
      domain: 'bad.com',
      reason: 'not whitelisted',
    });
  });
});

describe('PathNotAllowedError', () => {
  it('should construct with domain and path', () => {
    const err = new PathNotAllowedError('api.example.com', '/admin');
    expect(err.message).toBe("Path '/admin' on 'api.example.com' is not allowed");
    expect(err.code).toBe('PATH_NOT_ALLOWED');
    expect(err.name).toBe('PathNotAllowedError');
    expect(err.domain).toBe('api.example.com');
    expect(err.path).toBe('/admin');
    expect(err.method).toBeUndefined();
  });

  it('should construct with method', () => {
    const err = new PathNotAllowedError('api.com', '/secret', 'DELETE');
    expect(err.method).toBe('DELETE');
  });

  it('should inherit from ProxyError', () => {
    const err = new PathNotAllowedError('x.com', '/');
    expect(err).toBeInstanceOf(ProxyError);
  });

  it('should serialize to JSON', () => {
    const err = new PathNotAllowedError('api.com', '/admin', 'POST');
    const json = err.toJSON();
    expect(json).toEqual({
      name: 'PathNotAllowedError',
      code: 'PATH_NOT_ALLOWED',
      message: "Path '/admin' on 'api.com' is not allowed",
      domain: 'api.com',
      path: '/admin',
      method: 'POST',
    });
  });
});

describe('MethodNotAllowedError', () => {
  it('should construct with method and allowedMethods', () => {
    const err = new MethodNotAllowedError('DELETE', ['GET', 'POST']);
    expect(err.message).toBe("Method 'DELETE' is not allowed");
    expect(err.code).toBe('METHOD_NOT_ALLOWED');
    expect(err.name).toBe('MethodNotAllowedError');
    expect(err.method).toBe('DELETE');
    expect(err.allowedMethods).toEqual(['GET', 'POST']);
  });

  it('should inherit from ProxyError', () => {
    const err = new MethodNotAllowedError('PUT', ['GET']);
    expect(err).toBeInstanceOf(ProxyError);
  });

  it('should serialize to JSON', () => {
    const err = new MethodNotAllowedError('PATCH', ['GET', 'POST', 'PUT']);
    const json = err.toJSON();
    expect(json).toEqual({
      name: 'MethodNotAllowedError',
      code: 'METHOD_NOT_ALLOWED',
      message: "Method 'PATCH' is not allowed",
      method: 'PATCH',
      allowedMethods: ['GET', 'POST', 'PUT'],
    });
  });
});

describe('CertificateError', () => {
  it('should construct with message only', () => {
    const err = new CertificateError('cert generation failed');
    expect(err.message).toBe('cert generation failed');
    expect(err.code).toBe('CERTIFICATE_ERROR');
    expect(err.name).toBe('CertificateError');
    expect(err.domain).toBeUndefined();
  });

  it('should construct with domain', () => {
    const err = new CertificateError('failed', 'example.com');
    expect(err.domain).toBe('example.com');
  });

  it('should inherit from ProxyError', () => {
    const err = new CertificateError('err');
    expect(err).toBeInstanceOf(ProxyError);
  });

  it('should serialize to JSON', () => {
    const err = new CertificateError('cert error', 'test.com');
    const json = err.toJSON();
    expect(json).toEqual({
      name: 'CertificateError',
      code: 'CERTIFICATE_ERROR',
      message: 'cert error',
      domain: 'test.com',
    });
  });
});

describe('UpstreamConnectionError', () => {
  it('should construct with host and port', () => {
    const err = new UpstreamConnectionError('api.example.com', 443);
    expect(err.message).toBe('Failed to connect to api.example.com:443');
    expect(err.code).toBe('UPSTREAM_CONNECTION_ERROR');
    expect(err.name).toBe('UpstreamConnectionError');
    expect(err.host).toBe('api.example.com');
    expect(err.port).toBe(443);
    expect(err.cause).toBeUndefined();
  });

  it('should construct with cause error', () => {
    const cause = new Error('ECONNREFUSED');
    const err = new UpstreamConnectionError('localhost', 8080, cause);
    expect(err.cause).toBe(cause);
  });

  it('should inherit from ProxyError', () => {
    const err = new UpstreamConnectionError('host', 80);
    expect(err).toBeInstanceOf(ProxyError);
  });

  it('should serialize to JSON with cause message', () => {
    const cause = new Error('connection refused');
    const err = new UpstreamConnectionError('example.com', 443, cause);
    const json = err.toJSON();
    expect(json).toEqual({
      name: 'UpstreamConnectionError',
      code: 'UPSTREAM_CONNECTION_ERROR',
      message: 'Failed to connect to example.com:443',
      host: 'example.com',
      port: 443,
      cause: 'connection refused',
    });
  });

  it('should serialize to JSON without cause', () => {
    const err = new UpstreamConnectionError('host', 80);
    const json = err.toJSON();
    expect(json.cause).toBeUndefined();
  });
});
