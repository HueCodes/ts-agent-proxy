import { describe, it, expect } from 'vitest';
import {
  transformHeaders,
  getHeader,
  deleteHeader,
  substituteVariables,
  createTransformContext,
  applyRequestTransform,
  applyResponseTransform,
} from '../src/transform/header-transformer.js';

describe('getHeader', () => {
  it('should get header case-insensitively', () => {
    const headers = { 'Content-Type': 'application/json', 'X-Custom': 'value' };
    expect(getHeader(headers, 'content-type')).toBe('application/json');
    expect(getHeader(headers, 'CONTENT-TYPE')).toBe('application/json');
    expect(getHeader(headers, 'Content-Type')).toBe('application/json');
  });

  it('should return undefined for missing header', () => {
    const headers = { 'X-Exists': 'yes' };
    expect(getHeader(headers, 'X-Missing')).toBeUndefined();
  });

  it('should handle array values', () => {
    const headers: Record<string, string | string[]> = { 'Set-Cookie': ['a=1', 'b=2'] };
    expect(getHeader(headers, 'set-cookie')).toEqual(['a=1', 'b=2']);
  });

  it('should handle empty headers object', () => {
    expect(getHeader({}, 'anything')).toBeUndefined();
  });
});

describe('deleteHeader', () => {
  it('should delete header case-insensitively', () => {
    const headers: Record<string, string> = { 'Content-Type': 'text/html', 'X-Custom': 'val' };
    const result = deleteHeader(headers, 'content-type');
    expect(result).toBe(true);
    expect(headers['Content-Type']).toBeUndefined();
    expect(headers['X-Custom']).toBe('val');
  });

  it('should return false when header does not exist', () => {
    const headers = { 'X-Exists': 'yes' };
    expect(deleteHeader(headers, 'X-Missing')).toBe(false);
  });

  it('should handle empty headers object', () => {
    expect(deleteHeader({}, 'anything')).toBe(false);
  });
});

describe('substituteVariables', () => {
  it('should substitute known variables', () => {
    const context = {
      clientIp: '10.0.0.1',
      ruleId: 'api-rule',
      timestamp: '2024-01-01T00:00:00Z',
      requestId: 'req-123',
      host: 'api.example.com',
      path: '/v1/users',
      method: 'GET',
    };
    expect(substituteVariables('IP: ${clientIp}', context)).toBe('IP: 10.0.0.1');
    expect(substituteVariables('Rule: ${ruleId}', context)).toBe('Rule: api-rule');
    expect(substituteVariables('At: ${timestamp}', context)).toBe('At: 2024-01-01T00:00:00Z');
    expect(substituteVariables('ID: ${requestId}', context)).toBe('ID: req-123');
    expect(substituteVariables('Host: ${host}', context)).toBe('Host: api.example.com');
    expect(substituteVariables('Path: ${path}', context)).toBe('Path: /v1/users');
    expect(substituteVariables('Method: ${method}', context)).toBe('Method: GET');
  });

  it('should return original string when no context provided', () => {
    expect(substituteVariables('${clientIp}')).toBe('${clientIp}');
  });

  it('should leave unknown variables as-is', () => {
    expect(substituteVariables('${unknown}', {})).toBe('${unknown}');
  });

  it('should replace missing context values with empty string', () => {
    expect(substituteVariables('${clientIp}', {})).toBe('');
    expect(substituteVariables('${ruleId}', {})).toBe('');
  });

  it('should handle multiple variables in one string', () => {
    const context = { clientIp: '1.2.3.4', method: 'POST' };
    expect(substituteVariables('${method} from ${clientIp}', context)).toBe('POST from 1.2.3.4');
  });

  it('should handle string with no variables', () => {
    expect(substituteVariables('no variables here', { clientIp: '1.2.3.4' })).toBe(
      'no variables here',
    );
  });

  it('should use current timestamp when timestamp is undefined in context', () => {
    const result = substituteVariables('${timestamp}', { clientIp: '1.2.3.4' });
    // Should be a valid ISO string
    expect(() => new Date(result)).not.toThrow();
    expect(new Date(result).getTime()).not.toBeNaN();
  });
});

describe('transformHeaders', () => {
  it('should set headers', () => {
    const headers: Record<string, string> = { Existing: 'value' };
    transformHeaders(headers, { set: { 'X-New': 'new-value' } });
    expect(headers['X-New']).toBe('new-value');
    expect(headers['Existing']).toBe('value');
  });

  it('should overwrite existing headers via set', () => {
    const headers: Record<string, string> = { 'X-Custom': 'old' };
    transformHeaders(headers, { set: { 'X-Custom': 'new' } });
    expect(headers['X-Custom']).toBe('new');
  });

  it('should remove headers', () => {
    const headers: Record<string, string> = {
      Authorization: 'Bearer token',
      'Content-Type': 'application/json',
    };
    transformHeaders(headers, { remove: ['Authorization'] });
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('should remove headers case-insensitively', () => {
    const headers: Record<string, string> = { 'X-Custom-Header': 'value' };
    transformHeaders(headers, { remove: ['x-custom-header'] });
    expect(headers['X-Custom-Header']).toBeUndefined();
  });

  it('should rename headers', () => {
    const headers: Record<string, string> = { 'X-Old-Name': 'value' };
    transformHeaders(headers, { rename: { 'X-Old-Name': 'X-New-Name' } });
    expect(headers['X-Old-Name']).toBeUndefined();
    expect(headers['X-New-Name']).toBe('value');
  });

  it('should rename headers case-insensitively', () => {
    const headers: Record<string, string> = { 'X-Old-Name': 'value' };
    transformHeaders(headers, { rename: { 'x-old-name': 'X-New-Name' } });
    expect(headers['X-Old-Name']).toBeUndefined();
    expect(headers['X-New-Name']).toBe('value');
  });

  it('should skip renaming when source header does not exist', () => {
    const headers: Record<string, string> = { 'X-Existing': 'value' };
    transformHeaders(headers, { rename: { 'X-Missing': 'X-New' } });
    expect(headers['X-Existing']).toBe('value');
    expect(headers['X-New']).toBeUndefined();
  });

  it('should apply operations in order: rename, remove, set', () => {
    const headers: Record<string, string> = {
      'X-Old': 'old-value',
      'X-Remove-Me': 'bye',
    };
    transformHeaders(headers, {
      rename: { 'X-Old': 'X-Renamed' },
      remove: ['X-Remove-Me'],
      set: { 'X-Added': 'new' },
    });
    expect(headers['X-Old']).toBeUndefined();
    expect(headers['X-Renamed']).toBe('old-value');
    expect(headers['X-Remove-Me']).toBeUndefined();
    expect(headers['X-Added']).toBe('new');
  });

  it('should perform variable substitution in set values', () => {
    const headers: Record<string, string> = {};
    transformHeaders(
      headers,
      { set: { 'X-Forwarded-For': '${clientIp}' } },
      { clientIp: '192.168.1.1' },
    );
    expect(headers['X-Forwarded-For']).toBe('192.168.1.1');
  });

  it('should handle multiple transformations', () => {
    const headers: Record<string, string> = {
      Host: 'old.example.com',
      'User-Agent': 'Bot/1.0',
      Accept: '*/*',
    };
    transformHeaders(headers, {
      remove: ['User-Agent'],
      set: {
        Host: 'new.example.com',
        'X-Proxy': 'ts-agent-proxy',
      },
    });
    expect(headers['User-Agent']).toBeUndefined();
    expect(headers['Host']).toBe('new.example.com');
    expect(headers['X-Proxy']).toBe('ts-agent-proxy');
    expect(headers['Accept']).toBe('*/*');
  });

  it('should handle empty transform', () => {
    const headers: Record<string, string> = { 'X-Keep': 'value' };
    const result = transformHeaders(headers, {});
    expect(result).toEqual({ 'X-Keep': 'value' });
  });

  it('should return the same headers object (modified in place)', () => {
    const headers: Record<string, string> = {};
    const result = transformHeaders(headers, { set: { 'X-New': 'val' } });
    expect(result).toBe(headers);
  });
});

describe('createTransformContext', () => {
  it('should create context from request info', () => {
    const ctx = createTransformContext({
      clientIp: '10.0.0.1',
      ruleId: 'rule-1',
      host: 'api.com',
      path: '/v1',
      method: 'POST',
      requestId: 'req-abc',
    });
    expect(ctx.clientIp).toBe('10.0.0.1');
    expect(ctx.ruleId).toBe('rule-1');
    expect(ctx.host).toBe('api.com');
    expect(ctx.path).toBe('/v1');
    expect(ctx.method).toBe('POST');
    expect(ctx.requestId).toBe('req-abc');
    expect(ctx.timestamp).toBeDefined();
  });

  it('should generate requestId when not provided', () => {
    const ctx = createTransformContext({});
    expect(ctx.requestId).toBeDefined();
    expect(typeof ctx.requestId).toBe('string');
    expect(ctx.requestId!.length).toBeGreaterThan(0);
  });

  it('should generate a timestamp', () => {
    const ctx = createTransformContext({});
    expect(ctx.timestamp).toBeDefined();
    expect(() => new Date(ctx.timestamp!)).not.toThrow();
  });
});

describe('applyRequestTransform', () => {
  it('should return headers unchanged when no transform provided', () => {
    const headers: Record<string, string> = { 'X-Keep': 'value' };
    const result = applyRequestTransform(headers);
    expect(result).toBe(headers);
    expect(result['X-Keep']).toBe('value');
  });

  it('should return headers unchanged when transform is undefined', () => {
    const headers: Record<string, string> = { 'X-Keep': 'value' };
    const result = applyRequestTransform(headers, undefined);
    expect(result).toBe(headers);
  });

  it('should apply transform when provided', () => {
    const headers: Record<string, string> = { 'X-Old': 'value' };
    const result = applyRequestTransform(headers, { set: { 'X-New': 'added' } });
    expect(result['X-New']).toBe('added');
    expect(result['X-Old']).toBe('value');
  });
});

describe('applyResponseTransform', () => {
  it('should return headers unchanged when no transform provided', () => {
    const headers: Record<string, string> = { Server: 'nginx' };
    const result = applyResponseTransform(headers);
    expect(result).toBe(headers);
  });

  it('should apply transform when provided', () => {
    const headers: Record<string, string> = { Server: 'nginx' };
    const result = applyResponseTransform(headers, { remove: ['Server'] });
    expect(result['Server']).toBeUndefined();
  });
});
