/**
 * Custom error classes for the proxy server.
 * Provides structured error handling with error codes.
 */

/**
 * Base error class for all proxy-related errors.
 */
export class ProxyError extends Error {
  /**
   * Creates a new ProxyError.
   * @param message - Human-readable error message
   * @param code - Machine-readable error code
   */
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'ProxyError';
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Converts the error to a JSON-serializable object.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
    };
  }
}

/**
 * Error thrown when configuration is invalid or cannot be loaded.
 */
export class ConfigurationError extends ProxyError {
  /**
   * Creates a new ConfigurationError.
   * @param message - Description of the configuration error
   * @param path - Path to the configuration file or property that caused the error
   * @param details - Additional error details (e.g., validation errors)
   */
  constructor(
    message: string,
    public readonly path?: string,
    public readonly details?: unknown
  ) {
    super(message, 'CONFIG_ERROR');
    this.name = 'ConfigurationError';
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      path: this.path,
      details: this.details,
    };
  }
}

/**
 * Error thrown when a rate limit is exceeded.
 */
export class RateLimitExceededError extends ProxyError {
  /**
   * Creates a new RateLimitExceededError.
   * @param ruleId - ID of the rule that triggered the rate limit
   * @param retryAfter - Seconds until the rate limit resets
   * @param clientIp - IP address of the rate-limited client
   */
  constructor(
    public readonly ruleId: string,
    public readonly retryAfter: number,
    public readonly clientIp?: string
  ) {
    super(`Rate limit exceeded for rule '${ruleId}'`, 'RATE_LIMIT_EXCEEDED');
    this.name = 'RateLimitExceededError';
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      ruleId: this.ruleId,
      retryAfter: this.retryAfter,
      clientIp: this.clientIp,
    };
  }
}

/**
 * Error thrown when a domain is not in the allowlist.
 */
export class DomainNotAllowedError extends ProxyError {
  /**
   * Creates a new DomainNotAllowedError.
   * @param domain - The domain that was blocked
   * @param reason - Reason the domain was blocked
   */
  constructor(
    public readonly domain: string,
    public readonly reason?: string
  ) {
    super(`Domain '${domain}' is not in the allowlist`, 'DOMAIN_NOT_ALLOWED');
    this.name = 'DomainNotAllowedError';
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      domain: this.domain,
      reason: this.reason,
    };
  }
}

/**
 * Error thrown when a request path is not allowed.
 */
export class PathNotAllowedError extends ProxyError {
  /**
   * Creates a new PathNotAllowedError.
   * @param domain - The target domain
   * @param path - The blocked path
   * @param method - The HTTP method used
   */
  constructor(
    public readonly domain: string,
    public readonly path: string,
    public readonly method?: string
  ) {
    super(`Path '${path}' on '${domain}' is not allowed`, 'PATH_NOT_ALLOWED');
    this.name = 'PathNotAllowedError';
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      domain: this.domain,
      path: this.path,
      method: this.method,
    };
  }
}

/**
 * Error thrown when an HTTP method is not allowed.
 */
export class MethodNotAllowedError extends ProxyError {
  /**
   * Creates a new MethodNotAllowedError.
   * @param method - The blocked HTTP method
   * @param allowedMethods - List of allowed methods for this resource
   */
  constructor(
    public readonly method: string,
    public readonly allowedMethods: string[]
  ) {
    super(`Method '${method}' is not allowed`, 'METHOD_NOT_ALLOWED');
    this.name = 'MethodNotAllowedError';
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      method: this.method,
      allowedMethods: this.allowedMethods,
    };
  }
}

/**
 * Error thrown when certificate generation fails.
 */
export class CertificateError extends ProxyError {
  /**
   * Creates a new CertificateError.
   * @param message - Description of the certificate error
   * @param domain - Domain for which certificate generation failed
   */
  constructor(
    message: string,
    public readonly domain?: string
  ) {
    super(message, 'CERTIFICATE_ERROR');
    this.name = 'CertificateError';
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      domain: this.domain,
    };
  }
}

/**
 * Error thrown when connection to upstream server fails.
 */
export class UpstreamConnectionError extends ProxyError {
  /**
   * Creates a new UpstreamConnectionError.
   * @param host - Target host
   * @param port - Target port
   * @param cause - Original error that caused the connection failure
   */
  constructor(
    public readonly host: string,
    public readonly port: number,
    public readonly cause?: Error
  ) {
    super(`Failed to connect to ${host}:${port}`, 'UPSTREAM_CONNECTION_ERROR');
    this.name = 'UpstreamConnectionError';
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      host: this.host,
      port: this.port,
      cause: this.cause?.message,
    };
  }
}
