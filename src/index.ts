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
import { parseAllowlistConfigJson } from './validation/validator.js';
import { ConfigurationError } from './errors.js';

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
export { createIpMatcher, IpMatcher, matchesIp, matchesIpWithExclusion } from './filter/ip-matcher.js';
export { createCertManager, CertManager } from './proxy/mitm/cert-manager.js';
export * from './integration/wasm-bridge.js';

// Re-export admin components
export {
  createMetricsCollector,
  MetricsCollector,
  type ProxyMetrics,
  type RuleMetrics,
} from './admin/metrics.js';
export {
  createAdminServer,
  AdminServer,
  type AdminServerConfig,
  type HealthResponse,
} from './admin/admin-server.js';

// Re-export config watcher
export {
  createConfigWatcher,
  ConfigWatcher,
  watchConfig,
  type ConfigWatcherOptions,
} from './config/watcher.js';

// Re-export transform utilities
export {
  transformHeaders,
  getHeader,
  deleteHeader,
  substituteVariables,
  createTransformContext,
  applyRequestTransform,
  applyResponseTransform,
  type TransformContext,
} from './transform/header-transformer.js';

// Re-export errors
export * from './errors.js';

// Re-export validation (excluding type re-exports to avoid conflicts)
export {
  validateAllowlistConfig,
  validateServerConfig,
  validateProxyConfig,
  parseAllowlistConfigJson,
  parseProxyConfigJson,
} from './validation/index.js';
export {
  AllowlistRuleSchema,
  AllowlistConfigSchema,
  ServerConfigSchema,
  ProxyConfigSchema,
  RateLimitConfigSchema,
  HeaderTransformSchema,
  HttpMethodSchema,
  LoggingConfigSchema,
  TlsConfigSchema,
  AdminConfigSchema,
} from './validation/index.js';

/**
 * Load allowlist configuration from a JSON file with validation.
 *
 * @param filePath - Path to the JSON configuration file
 * @returns Validated allowlist configuration
 * @throws ConfigurationError if the file cannot be read or config is invalid
 *
 * @example
 * ```typescript
 * const config = loadAllowlistConfig('./config/allowlist.json');
 * console.log(`Loaded ${config.rules.length} rules`);
 * ```
 */
export function loadAllowlistConfig(filePath: string): AllowlistConfig {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    throw new ConfigurationError(
      `Failed to read configuration file: ${error instanceof Error ? error.message : 'Unknown error'}`,
      filePath
    );
  }

  return parseAllowlistConfigJson(content, filePath);
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
  const watchArg = args.includes('--watch');
  const adminArg = args.find(a => a.startsWith('--admin-port='));

  // Load configuration
  const config = createDefaultConfig();

  // Determine allowlist path
  const allowlistPath = configArg
    ? configArg.split('=')[1]
    : path.join(process.cwd(), 'config', 'allowlist.json');

  // Load allowlist from default location if exists
  if (fs.existsSync(allowlistPath)) {
    try {
      config.allowlist = loadAllowlistConfig(allowlistPath);
      logger.info({ path: allowlistPath }, 'Loaded allowlist configuration');
    } catch (error) {
      logger.error({ error, path: allowlistPath }, 'Failed to load allowlist');
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

  // Enable admin server if port specified
  if (adminArg) {
    config.server.admin = {
      enabled: true,
      port: parseInt(adminArg.split('=')[1], 10),
      host: '127.0.0.1',
    };
  }

  // Create and start server
  const server = createProxyServer({ config, logger });

  // Config watcher cleanup function
  let stopWatching: (() => void) | undefined;

  // Handle shutdown gracefully
  const shutdown = async () => {
    logger.info('Shutting down...');
    if (stopWatching) {
      stopWatching();
    }
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await server.start();

    // Start config watcher if enabled
    if (watchArg && fs.existsSync(allowlistPath)) {
      const { watchConfig: watchConfigFn } = await import('./config/watcher.js');
      stopWatching = watchConfigFn({
        filePath: allowlistPath,
        onReload: (newConfig) => {
          server.reloadAllowlist(newConfig);
          logger.info({ rulesCount: newConfig.rules.length }, 'Configuration reloaded');
        },
        onError: (error) => {
          logger.error({ error }, 'Configuration reload failed');
        },
        logger,
      });
      logger.info({ path: allowlistPath }, 'Watching configuration for changes');
    }

    logger.info(
      {
        rulesCount: config.allowlist.rules.length,
        mode: config.server.mode,
        watching: watchArg,
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
