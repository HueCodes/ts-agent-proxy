/**
 * Logging infrastructure using pino.
 */

import pino, { Logger as PinoLogger } from 'pino';
import type { LoggingConfig } from '../types/config.js';

export type Logger = PinoLogger;

export interface LoggerOptions {
  name?: string;
  level?: string;
  pretty?: boolean;
}

/**
 * Create a logger instance.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const { name = 'ts-agent-proxy', level = 'info', pretty = true } = options;

  const transport = pretty
    ? pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      })
    : undefined;

  return pino(
    {
      name,
      level,
    },
    transport
  );
}

/**
 * Create a logger from logging configuration.
 */
export function createLoggerFromConfig(config: LoggingConfig): Logger {
  return createLogger({
    level: config.level,
    pretty: config.pretty ?? true,
  });
}

/**
 * Create a child logger with additional context.
 */
export function createChildLogger(parent: Logger, bindings: Record<string, unknown>): Logger {
  return parent.child(bindings);
}
