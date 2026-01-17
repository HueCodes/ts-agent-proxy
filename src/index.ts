/**
 * Agent Network Proxy - HTTP Allowlist Proxy for AI Agents
 *
 * Entry point and main exports.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createProxyServer, type ProxyServer } from './server.js';
import { createDefaultConfig, type ProxyConfig } from './types/config.js';
import type { AllowlistConfig } from './types/allowlist.js';
import { createLogger } from './logging/logger.js';

// Re-export types
export * from './types/allowlist.js';
export * from './types/config.js';

// Re-export main components
export { createProxyServer, ProxyServer } from './server.js';
export { createLogger, type Logger } from './logging/logger.js';
export { createAuditLogger, AuditLogger } from './logging/audit-logger.js';
export { createAllowlistMatcher, AllowlistMatcher } from './filter/allowlist-matcher.js';
export { createDomainMatcher, DomainMatcher } from './filter/domain-matcher.js';
export { createRateLimiter, RateLimiter } from './filter/rate-limiter.js';
export { createCertManager, CertManager } from './proxy/mitm/cert-manager.js';
export * from './integration/wasm-bridge.js';

/**
 * Load allowlist configuration from a JSON file.
 */
export function loadAllowlistConfig(filePath: string): AllowlistConfig {
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as AllowlistConfig;
}

/**
 * Load full proxy configuration.
 */
export function loadProxyConfig(
  serverConfigPath?: string,
  allowlistPath?: string
): ProxyConfig {
  const config = createDefaultConfig();

  if (allowlistPath && fs.existsSync(allowlistPath)) {
    config.allowlist = loadAllowlistConfig(allowlistPath);
  }

  return config;
}

/**
 * CLI entry point.
 */
async function main(): Promise<void> {
  const logger = createLogger({ level: 'info', pretty: true });

  // Parse command line arguments
  const args = process.argv.slice(2);
  const configArg = args.find(a => a.startsWith('--config='));
  const portArg = args.find(a => a.startsWith('--port='));
  const hostArg = args.find(a => a.startsWith('--host='));
  const modeArg = args.find(a => a.startsWith('--mode='));

  // Load configuration
  let config = createDefaultConfig();

  // Load allowlist from default location if exists
  const defaultAllowlistPath = path.join(process.cwd(), 'config', 'allowlist.json');
  if (fs.existsSync(defaultAllowlistPath)) {
    try {
      config.allowlist = loadAllowlistConfig(defaultAllowlistPath);
      logger.info({ path: defaultAllowlistPath }, 'Loaded allowlist configuration');
    } catch (error) {
      logger.error({ error, path: defaultAllowlistPath }, 'Failed to load allowlist');
    }
  }

  // Override with command line arguments
  if (portArg) {
    config.server.port = parseInt(portArg.split('=')[1], 10);
  }
  if (hostArg) {
    config.server.host = hostArg.split('=')[1];
  }
  if (modeArg) {
    const mode = modeArg.split('=')[1];
    if (mode === 'tunnel' || mode === 'mitm') {
      config.server.mode = mode;
    }
  }

  // Create and start server
  const server = createProxyServer({ config, logger });

  // Handle shutdown gracefully
  const shutdown = async () => {
    logger.info('Shutting down...');
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await server.start();

    logger.info(
      {
        rulesCount: config.allowlist.rules.length,
        mode: config.server.mode,
      },
      'Proxy ready'
    );

    // Print CA certificate path if in MITM mode
    if (config.server.mode === 'mitm') {
      const caCert = server.getCaCertPem();
      if (caCert) {
        logger.info('MITM mode enabled. Install the CA certificate to trust intercepted connections.');
      }
    }
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  }
}

// Run if this is the entry point
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
