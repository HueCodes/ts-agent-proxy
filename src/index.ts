/**
 * Agent Network Proxy - HTTP Allowlist Proxy for AI Agents
 *
 * Entry point and main exports.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createProxyServer } from './server.js';
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
export {
  createIpMatcher,
  IpMatcher,
  matchesIp,
  matchesIpWithExclusion,
} from './filter/ip-matcher.js';
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
      filePath,
    );
  }

  return parseAllowlistConfigJson(content, filePath);
}

/**
 * Load full proxy configuration.
 */
export function loadProxyConfig(serverConfigPath?: string, allowlistPath?: string): ProxyConfig {
  const config = createDefaultConfig();

  if (allowlistPath && fs.existsSync(allowlistPath)) {
    config.allowlist = loadAllowlistConfig(allowlistPath);
  }

  return config;
}

/**
 * Read package version from package.json.
 */
function getVersion(): string {
  try {
    const pkgPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      '..',
      'package.json',
    );
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * CLI entry point.
 */
async function main(): Promise<void> {
  const logger = createLogger({ level: 'info', pretty: true });
  const version = getVersion();

  // Parse command line arguments
  const args = process.argv.slice(2);
  const configArg = args.find((a) => a.startsWith('--config='));
  const portArg = args.find((a) => a.startsWith('--port='));
  const hostArg = args.find((a) => a.startsWith('--host='));
  const modeArg = args.find((a) => a.startsWith('--mode='));
  const watchArg = args.includes('--watch');
  const adminArg = args.find((a) => a.startsWith('--admin-port='));

  // Startup diagnostics
  logger.info(
    {
      version,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
    },
    'ts-agent-proxy starting',
  );

  // Load configuration
  const config = createDefaultConfig();

  // Determine allowlist path
  const allowlistPath = configArg
    ? configArg.split('=')[1]!
    : path.join(process.cwd(), 'config', 'allowlist.json');

  // Load allowlist from default location if exists
  if (fs.existsSync(allowlistPath)) {
    try {
      config.allowlist = loadAllowlistConfig(allowlistPath);
      logger.info(
        { path: allowlistPath, rulesCount: config.allowlist.rules.length },
        'Loaded allowlist configuration',
      );
    } catch (error) {
      logger.error({ error, path: allowlistPath }, 'Failed to load allowlist configuration');
      process.exit(1);
    }
  } else if (configArg) {
    // User explicitly specified a config file that doesn't exist
    logger.error({ path: allowlistPath }, 'Configuration file not found');
    process.exit(1);
  }

  // Override with command line arguments
  if (portArg) {
    const port = parseInt(portArg.split('=')[1]!, 10);
    if (isNaN(port) || port < 0 || port > 65535) {
      logger.error({ port: portArg.split('=')[1]! }, 'Invalid port number');
      process.exit(1);
    }
    config.server.port = port;
  }
  if (hostArg) {
    config.server.host = hostArg.split('=')[1]!;
  }
  if (modeArg) {
    const mode = modeArg.split('=')[1]!;
    if (mode === 'tunnel' || mode === 'mitm') {
      config.server.mode = mode;
    } else {
      logger.error({ mode }, 'Invalid proxy mode (must be "tunnel" or "mitm")');
      process.exit(1);
    }
  }

  // Enable admin server if port specified
  if (adminArg) {
    const adminPort = parseInt(adminArg.split('=')[1]!, 10);
    if (isNaN(adminPort) || adminPort < 0 || adminPort > 65535) {
      logger.error({ port: adminArg.split('=')[1]! }, 'Invalid admin port number');
      process.exit(1);
    }
    config.server.admin = {
      enabled: true,
      port: adminPort,
      host: '127.0.0.1',
    };
  }

  // Create and start server
  const server = createProxyServer({ config, logger });

  // Config watcher cleanup function
  let stopWatching: (() => void) | undefined;
  let isShuttingDown = false;

  // Handle shutdown gracefully
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info({ signal }, 'Received shutdown signal');
    if (stopWatching) {
      stopWatching();
      logger.info('Config watcher stopped');
    }
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Handle uncaught errors
  process.on('unhandledRejection', (reason) => {
    logger.error({ error: reason }, 'Unhandled promise rejection');
    process.exit(1);
  });

  process.on('uncaughtException', (error) => {
    logger.error({ error }, 'Uncaught exception');
    process.exit(1);
  });

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

    // Log ready state with configuration summary
    logger.info(
      {
        host: config.server.host,
        port: config.server.port,
        mode: config.server.mode,
        rulesCount: config.allowlist.rules.length,
        adminEnabled: !!config.server.admin?.enabled,
        adminPort: config.server.admin?.port,
        configWatch: watchArg,
      },
      'Proxy ready',
    );

    // Print CA certificate info if in MITM mode
    if (config.server.mode === 'mitm') {
      const caCert = server.getCaCertPem();
      if (caCert) {
        logger.info(
          'MITM mode enabled. Install the CA certificate to trust intercepted connections.',
        );
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
