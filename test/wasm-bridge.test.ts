import { describe, it, expect } from 'vitest';
import {
  generateSandboxNetworkConfig,
  generateRustConfigSnippet,
  generatePythonTestCode,
  validateSandboxConfig,
} from '../src/integration/wasm-bridge.js';

describe('wasm-bridge', () => {
  describe('generateSandboxNetworkConfig', () => {
    it('should generate default config', () => {
      const config = generateSandboxNetworkConfig();

      expect(config.proxyHost).toBe('127.0.0.1');
      expect(config.proxyPort).toBe(8080);
      expect(config.envVars.HTTP_PROXY).toBe('http://127.0.0.1:8080');
      expect(config.envVars.HTTPS_PROXY).toBe('http://127.0.0.1:8080');
      expect(config.envVars.NO_PROXY).toBe('');
      expect(config.wasiConfig.blockByDefault).toBe(true);
    });

    it('should generate config with custom host/port', () => {
      const config = generateSandboxNetworkConfig('192.168.1.1', 3128);

      expect(config.proxyHost).toBe('192.168.1.1');
      expect(config.proxyPort).toBe(3128);
      expect(config.envVars.HTTP_PROXY).toBe('http://192.168.1.1:3128');
    });

    it('should include both uppercase and lowercase env vars', () => {
      const config = generateSandboxNetworkConfig();

      expect(config.envVars.HTTP_PROXY).toBeDefined();
      expect(config.envVars.http_proxy).toBeDefined();
      expect(config.envVars.HTTP_PROXY).toBe(config.envVars.http_proxy);
    });
  });

  describe('generateRustConfigSnippet', () => {
    it('should generate valid Rust code', () => {
      const config = generateSandboxNetworkConfig();
      const snippet = generateRustConfigSnippet(config);

      expect(snippet).toContain('WasiCtxBuilder::new()');
      expect(snippet).toContain('.env("HTTP_PROXY"');
      expect(snippet).toContain('.env("HTTPS_PROXY"');
      expect(snippet).toContain('127.0.0.1:8080');
    });
  });

  describe('generatePythonTestCode', () => {
    it('should generate Python test code', () => {
      const code = generatePythonTestCode('127.0.0.1', 8080);

      expect(code).toContain('def test_proxy_config');
      expect(code).toContain('def test_allowed_request');
      expect(code).toContain('def test_blocked_request');
      expect(code).toContain('127.0.0.1');
      expect(code).toContain('8080');
    });
  });

  describe('validateSandboxConfig', () => {
    it('should validate correct config', () => {
      const config = generateSandboxNetworkConfig();
      const result = validateSandboxConfig(config);

      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should flag non-localhost proxy', () => {
      const config = generateSandboxNetworkConfig('10.0.0.1', 8080);
      const result = validateSandboxConfig(config);

      expect(result.valid).toBe(false);
      expect(result.issues).toContain('Proxy host should be localhost for security');
    });

    it('should flag non-empty NO_PROXY', () => {
      const config = generateSandboxNetworkConfig();
      config.envVars.NO_PROXY = 'localhost';
      const result = validateSandboxConfig(config);

      expect(result.valid).toBe(false);
      expect(result.issues).toContain('NO_PROXY should be empty to prevent bypassing');
    });

    it('should flag missing block by default', () => {
      const config = generateSandboxNetworkConfig();
      config.wasiConfig.blockByDefault = false;
      const result = validateSandboxConfig(config);

      expect(result.valid).toBe(false);
      expect(result.issues).toContain('WASI should block network by default');
    });
  });
});
