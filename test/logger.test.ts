import { describe, it, expect } from 'vitest';
import { createLogger, createLoggerFromConfig, createChildLogger } from '../src/logging/logger.js';

describe('createLogger', () => {
  it('should create a logger with default options', () => {
    const logger = createLogger();
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('should create a logger with custom name', () => {
    const logger = createLogger({ name: 'custom-app' });
    expect(logger).toBeDefined();
  });

  it('should create a logger with custom level', () => {
    const logger = createLogger({ level: 'debug' });
    expect(logger.level).toBe('debug');
  });

  it('should create a logger with pretty=false (no transport)', () => {
    const logger = createLogger({ pretty: false });
    expect(logger).toBeDefined();
    expect(logger.level).toBe('info');
  });

  it('should default to info level', () => {
    const logger = createLogger({ pretty: false });
    expect(logger.level).toBe('info');
  });

  it('should support all log levels', () => {
    const logger = createLogger({ level: 'trace', pretty: false });
    expect(logger.level).toBe('trace');
    // Ensure all log methods exist
    expect(typeof logger.trace).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.fatal).toBe('function');
  });
});

describe('createLoggerFromConfig', () => {
  it('should create a logger from config with level', () => {
    const logger = createLoggerFromConfig({ level: 'warn' });
    expect(logger).toBeDefined();
    expect(logger.level).toBe('warn');
  });

  it('should use pretty=true by default', () => {
    const logger = createLoggerFromConfig({ level: 'info' });
    expect(logger).toBeDefined();
  });

  it('should respect pretty=false in config', () => {
    const logger = createLoggerFromConfig({ level: 'error', pretty: false });
    expect(logger).toBeDefined();
    expect(logger.level).toBe('error');
  });
});

describe('createChildLogger', () => {
  it('should create a child logger with additional context', () => {
    const parent = createLogger({ pretty: false, level: 'info' });
    const child = createChildLogger(parent, { module: 'proxy', requestId: '123' });
    expect(child).toBeDefined();
    expect(typeof child.info).toBe('function');
  });

  it('should preserve parent log level', () => {
    const parent = createLogger({ pretty: false, level: 'debug' });
    const child = createChildLogger(parent, { component: 'filter' });
    expect(child.level).toBe('debug');
  });

  it('should allow nested child loggers', () => {
    const parent = createLogger({ pretty: false, level: 'info' });
    const child = createChildLogger(parent, { module: 'proxy' });
    const grandchild = createChildLogger(child, { handler: 'connect' });
    expect(grandchild).toBeDefined();
    expect(typeof grandchild.info).toBe('function');
  });
});
