import { describe, it, expect } from 'vitest';
import {
  validateAllowlistConfig,
  validateServerConfig,
  validateProxyConfig,
  parseAllowlistConfigJson,
  parseProxyConfigJson,
} from '../src/validation/validator.js';
import { ConfigurationError } from '../src/errors.js';

describe('validateAllowlistConfig', () => {
  const validConfig = {
    mode: 'strict',
    defaultAction: 'deny',
    rules: [{ id: 'rule-1', domain: 'api.example.com' }],
  };

  it('should return validated config for valid input', () => {
    const result = validateAllowlistConfig(validConfig);
    expect(result.mode).toBe('strict');
    expect(result.defaultAction).toBe('deny');
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].enabled).toBe(true); // default applied
  });

  it('should throw ConfigurationError for invalid input', () => {
    expect(() => validateAllowlistConfig({})).toThrow(ConfigurationError);
  });

  it('should include path in error when provided', () => {
    try {
      validateAllowlistConfig({}, '/etc/config.json');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigurationError);
      expect((err as ConfigurationError).path).toBe('/etc/config.json');
    }
  });

  it('should include validation details in error', () => {
    try {
      validateAllowlistConfig({ mode: 'invalid' });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigurationError);
      expect((err as ConfigurationError).details).toBeDefined();
      expect(Array.isArray((err as ConfigurationError).details)).toBe(true);
    }
  });

  it('should produce human-readable error messages', () => {
    try {
      validateAllowlistConfig({});
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as ConfigurationError).message).toContain('Validation failed');
    }
  });

  it('should reject duplicate rule IDs', () => {
    const config = {
      mode: 'strict',
      defaultAction: 'deny',
      rules: [
        { id: 'dup', domain: 'a.com' },
        { id: 'dup', domain: 'b.com' },
      ],
    };
    expect(() => validateAllowlistConfig(config)).toThrow(ConfigurationError);
  });

  it('should accept config with empty rules', () => {
    const result = validateAllowlistConfig({
      mode: 'permissive',
      defaultAction: 'allow',
      rules: [],
    });
    expect(result.rules).toEqual([]);
  });
});

describe('validateServerConfig', () => {
  it('should return config with defaults for empty input', () => {
    const result = validateServerConfig({});
    expect(result.host).toBe('127.0.0.1');
    expect(result.port).toBe(8080);
    expect(result.mode).toBe('tunnel');
  });

  it('should accept custom values', () => {
    const result = validateServerConfig({
      host: '0.0.0.0',
      port: 3128,
      mode: 'mitm',
    });
    expect(result.host).toBe('0.0.0.0');
    expect(result.port).toBe(3128);
    expect(result.mode).toBe('mitm');
  });

  it('should throw ConfigurationError for invalid port', () => {
    expect(() => validateServerConfig({ port: 0 })).toThrow(ConfigurationError);
    expect(() => validateServerConfig({ port: 99999 })).toThrow(ConfigurationError);
  });

  it('should throw ConfigurationError for invalid mode', () => {
    expect(() => validateServerConfig({ mode: 'invalid' })).toThrow(ConfigurationError);
  });
});

describe('validateProxyConfig', () => {
  const validConfig = {
    server: { host: '127.0.0.1', port: 8080, mode: 'tunnel' },
    allowlist: {
      mode: 'strict',
      defaultAction: 'deny',
      rules: [],
    },
  };

  it('should return validated config', () => {
    const result = validateProxyConfig(validConfig);
    expect(result.server.port).toBe(8080);
    expect(result.allowlist.mode).toBe('strict');
  });

  it('should throw ConfigurationError when server is missing', () => {
    expect(() => validateProxyConfig({ allowlist: validConfig.allowlist })).toThrow(
      ConfigurationError,
    );
  });

  it('should throw ConfigurationError when allowlist is missing', () => {
    expect(() => validateProxyConfig({ server: validConfig.server })).toThrow(ConfigurationError);
  });
});

describe('parseAllowlistConfigJson', () => {
  it('should parse valid JSON and validate', () => {
    const json = JSON.stringify({
      mode: 'strict',
      defaultAction: 'deny',
      rules: [{ id: 'r1', domain: 'x.com' }],
    });
    const result = parseAllowlistConfigJson(json);
    expect(result.mode).toBe('strict');
    expect(result.rules).toHaveLength(1);
  });

  it('should throw ConfigurationError for invalid JSON', () => {
    expect(() => parseAllowlistConfigJson('not json')).toThrow(ConfigurationError);
    try {
      parseAllowlistConfigJson('{bad json}', '/path/to/file');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigurationError);
      expect((err as ConfigurationError).message).toContain('Invalid JSON');
      expect((err as ConfigurationError).path).toBe('/path/to/file');
    }
  });

  it('should throw ConfigurationError for valid JSON but invalid config', () => {
    expect(() => parseAllowlistConfigJson('{"mode": "invalid"}')).toThrow(ConfigurationError);
  });

  it('should include path in errors', () => {
    try {
      parseAllowlistConfigJson('{}', '/etc/allowlist.json');
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as ConfigurationError).path).toBe('/etc/allowlist.json');
    }
  });
});

describe('parseProxyConfigJson', () => {
  it('should parse valid JSON and validate', () => {
    const json = JSON.stringify({
      server: { host: '127.0.0.1', port: 8080, mode: 'tunnel' },
      allowlist: { mode: 'strict', defaultAction: 'deny', rules: [] },
    });
    const result = parseProxyConfigJson(json);
    expect(result.server.port).toBe(8080);
  });

  it('should throw ConfigurationError for invalid JSON', () => {
    expect(() => parseProxyConfigJson('not json')).toThrow(ConfigurationError);
  });

  it('should throw ConfigurationError for valid JSON but invalid config', () => {
    expect(() => parseProxyConfigJson('{}')).toThrow(ConfigurationError);
  });

  it('should include path in JSON parse errors', () => {
    try {
      parseProxyConfigJson('bad', '/config.json');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigurationError);
      expect((err as ConfigurationError).path).toBe('/config.json');
    }
  });
});
