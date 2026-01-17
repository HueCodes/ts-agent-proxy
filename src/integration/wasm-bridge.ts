/**
 * Integration bridge between the Wasm sandbox and the proxy.
 *
 * This module provides utilities for configuring sandbox environments
 * to route their network traffic through the proxy.
 */

export interface SandboxNetworkConfig {
  /** Proxy server host */
  proxyHost: string;
  /** Proxy server port */
  proxyPort: number;
  /** Environment variables to set in the sandbox */
  envVars: Record<string, string>;
  /** WASI network configuration */
  wasiConfig: WasiNetworkConfig;
}

export interface WasiNetworkConfig {
  /** Allowed outbound addresses (for WASI Preview 2 sockets) */
  allowedOutbound: string[];
  /** Whether to block all network by default */
  blockByDefault: boolean;
}

/**
 * Generate sandbox network configuration.
 *
 * This creates the environment variables and WASI configuration
 * needed to route a sandbox's network traffic through the proxy.
 */
export function generateSandboxNetworkConfig(
  proxyHost: string = '127.0.0.1',
  proxyPort: number = 8080
): SandboxNetworkConfig {
  const proxyUrl = `http://${proxyHost}:${proxyPort}`;

  return {
    proxyHost,
    proxyPort,
    envVars: {
      // Standard proxy environment variables
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      // Prevent bypassing proxy
      NO_PROXY: '',
      no_proxy: '',
      // Python-specific
      REQUESTS_CA_BUNDLE: '',
      CURL_CA_BUNDLE: '',
    },
    wasiConfig: {
      // Only allow connections to the proxy
      allowedOutbound: [`${proxyHost}:${proxyPort}`],
      blockByDefault: true,
    },
  };
}

/**
 * Generate a Rust code snippet for configuring the sandbox.
 *
 * This returns Rust code that can be used to configure WASI
 * with the appropriate network restrictions.
 */
export function generateRustConfigSnippet(config: SandboxNetworkConfig): string {
  const envLines = Object.entries(config.envVars)
    .map(([key, value]) => `    .env("${key}", "${value}")`)
    .join('\n');

  return `// Configure WASI with proxy environment
let wasi = WasiCtxBuilder::new()
${envLines}
    .build();

// Note: WASI Preview 1 does not support network sockets.
// The Python code must use HTTP libraries that respect
// environment variables (requests, urllib, etc.)
//
// For WASI Preview 2 with network support, configure:
// - Allow only: ${config.wasiConfig.allowedOutbound.join(', ')}
// - Block all other outbound connections`;
}

/**
 * Configuration for testing sandbox connectivity.
 */
export interface ConnectivityTestConfig {
  /** Test URL that should be allowed */
  allowedUrl: string;
  /** Test URL that should be blocked */
  blockedUrl: string;
  /** Expected response for allowed URL */
  expectedAllowed: boolean;
}

/**
 * Generate Python test code for verifying sandbox network configuration.
 */
export function generatePythonTestCode(proxyHost: string, proxyPort: number): string {
  return `
# Test script to verify proxy configuration
import os
import sys

def test_proxy_config():
    """Verify proxy environment is set correctly."""
    proxy_url = f"http://${proxyHost}:${proxyPort}"

    assert os.environ.get('HTTP_PROXY') == proxy_url, "HTTP_PROXY not set"
    assert os.environ.get('HTTPS_PROXY') == proxy_url, "HTTPS_PROXY not set"
    print("Proxy environment configured correctly")

def test_allowed_request():
    """Test that allowed requests go through."""
    try:
        import urllib.request
        # This will only work if api.openai.com is in the allowlist
        req = urllib.request.Request('https://api.openai.com/v1/models')
        req.add_header('Authorization', 'Bearer test')
        # Should succeed or get 401 (auth error, but connection worked)
        try:
            urllib.request.urlopen(req, timeout=5)
            print("Allowed request: SUCCESS")
        except urllib.error.HTTPError as e:
            if e.code in [401, 403]:
                print("Allowed request: SUCCESS (auth required)")
            else:
                raise
    except Exception as e:
        print(f"Allowed request: FAILED - {e}")

def test_blocked_request():
    """Test that blocked requests are denied."""
    try:
        import urllib.request
        req = urllib.request.Request('https://evil-domain.com/')
        urllib.request.urlopen(req, timeout=5)
        print("Blocked request: FAILED (should have been blocked)")
    except urllib.error.HTTPError as e:
        if e.code == 403:
            print("Blocked request: SUCCESS (403 Forbidden)")
        else:
            print(f"Blocked request: UNEXPECTED ({e.code})")
    except Exception as e:
        print(f"Blocked request: SUCCESS (connection refused)")

if __name__ == '__main__':
    test_proxy_config()
    test_allowed_request()
    test_blocked_request()
`.trim();
}

/**
 * Validate that a sandbox configuration is secure.
 */
export function validateSandboxConfig(config: SandboxNetworkConfig): ValidationResult {
  const issues: string[] = [];

  // Check that proxy URL is localhost
  if (config.proxyHost !== '127.0.0.1' && config.proxyHost !== 'localhost') {
    issues.push('Proxy host should be localhost for security');
  }

  // Check that environment variables are set
  if (!config.envVars.HTTP_PROXY || !config.envVars.HTTPS_PROXY) {
    issues.push('Missing proxy environment variables');
  }

  // Check that NO_PROXY is empty
  if (config.envVars.NO_PROXY !== '') {
    issues.push('NO_PROXY should be empty to prevent bypassing');
  }

  // Check WASI config
  if (!config.wasiConfig.blockByDefault) {
    issues.push('WASI should block network by default');
  }

  if (config.wasiConfig.allowedOutbound.length === 0) {
    issues.push('No allowed outbound addresses configured');
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

export interface ValidationResult {
  valid: boolean;
  issues: string[];
}
