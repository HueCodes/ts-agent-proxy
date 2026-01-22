/**
 * gRPC service and method matcher.
 *
 * Provides matching logic for gRPC services and methods based on
 * allowlist rule configurations.
 *
 * @module filter/grpc-matcher
 */

import type { GrpcRuleConfig } from '../types/allowlist.js';
import { parseGrpcPath, type GrpcPath } from '../proxy/grpc-parser.js';

/**
 * gRPC match result.
 */
export interface GrpcMatchResult {
  /** Whether the gRPC request is allowed */
  allowed: boolean;
  /** Reason for the match decision */
  reason: string;
  /** Matched service pattern (if any) */
  matchedService?: string;
  /** Matched method pattern (if any) */
  matchedMethod?: string;
}

/**
 * Well-known gRPC services.
 */
export const GRPC_REFLECTION_SERVICE = 'grpc.reflection.v1alpha.ServerReflection';
export const GRPC_REFLECTION_SERVICE_V1 = 'grpc.reflection.v1.ServerReflection';
export const GRPC_HEALTH_SERVICE = 'grpc.health.v1.Health';

/**
 * gRPC service/method matcher.
 *
 * Matches gRPC requests against allowlist rules with support for:
 * - Exact service matching
 * - Wildcard service matching (e.g., myapp.*)
 * - Exact method matching (e.g., myapp.UserService/GetUser)
 * - Special handling for reflection and health check services
 */
export class GrpcMatcher {
  /**
   * Match a gRPC request against rule configuration.
   */
  match(path: string, config: GrpcRuleConfig | undefined): GrpcMatchResult {
    // No gRPC config means allow all gRPC (fallback to general rule matching)
    if (!config) {
      return { allowed: true, reason: 'No gRPC restrictions' };
    }

    // Parse the gRPC path
    const parsed = parseGrpcPath(path);
    if (!parsed) {
      return { allowed: false, reason: 'Invalid gRPC path format' };
    }

    // Check for reflection service
    if (this.isReflectionService(parsed.fullService)) {
      if (config.allowReflection) {
        return {
          allowed: true,
          reason: 'Reflection service allowed',
          matchedService: parsed.fullService,
        };
      }
      return {
        allowed: false,
        reason: 'gRPC reflection not allowed',
      };
    }

    // Check for health check service
    if (this.isHealthService(parsed.fullService)) {
      // Health check is allowed by default unless explicitly disabled
      if (config.allowHealthCheck !== false) {
        return {
          allowed: true,
          reason: 'Health check service allowed',
          matchedService: parsed.fullService,
        };
      }
      return {
        allowed: false,
        reason: 'gRPC health check not allowed',
      };
    }

    // Check method-level rules first (more specific)
    if (config.methods && config.methods.length > 0) {
      const methodMatch = this.matchMethods(parsed, config.methods);
      if (methodMatch.matched) {
        return {
          allowed: true,
          reason: 'Method allowed by rule',
          matchedMethod: methodMatch.pattern,
        };
      }
      // Methods specified but didn't match - check if services also specified
      // If only methods are specified, reject
      if (!config.services || config.services.length === 0) {
        return {
          allowed: false,
          reason: `Method ${parsed.fullService}/${parsed.method} not in allowed list`,
        };
      }
    }

    // Check service-level rules
    if (config.services && config.services.length > 0) {
      const serviceMatch = this.matchServices(parsed, config.services);
      if (serviceMatch.matched) {
        return {
          allowed: true,
          reason: 'Service allowed by rule',
          matchedService: serviceMatch.pattern,
        };
      }

      // Services are specified but didn't match
      return {
        allowed: false,
        reason: `Service ${parsed.fullService} not in allowed list`,
      };
    }

    // No services or methods specified, but config exists
    // This means gRPC is configured but no specific restrictions
    return { allowed: true, reason: 'gRPC allowed (no service restrictions)' };
  }

  /**
   * Match against service patterns.
   */
  private matchServices(
    parsed: GrpcPath,
    patterns: string[]
  ): { matched: boolean; pattern?: string } {
    for (const pattern of patterns) {
      if (this.matchServicePattern(parsed, pattern)) {
        return { matched: true, pattern };
      }
    }
    return { matched: false };
  }

  /**
   * Match a service against a pattern.
   * Supports exact match, package wildcard (myapp.*), and double wildcard (**).
   */
  private matchServicePattern(parsed: GrpcPath, pattern: string): boolean {
    // Double wildcard matches everything
    if (pattern === '**') {
      return true;
    }

    // Package wildcard (e.g., myapp.*)
    if (pattern.endsWith('.*')) {
      const packagePrefix = pattern.slice(0, -2);
      return parsed.package === packagePrefix ||
             parsed.fullService.startsWith(packagePrefix + '.');
    }

    // Exact match
    return parsed.fullService === pattern;
  }

  /**
   * Match against method patterns.
   */
  private matchMethods(
    parsed: GrpcPath,
    patterns: string[]
  ): { matched: boolean; pattern?: string } {
    for (const pattern of patterns) {
      if (this.matchMethodPattern(parsed, pattern)) {
        return { matched: true, pattern };
      }
    }
    return { matched: false };
  }

  /**
   * Match a method against a pattern.
   * Supports exact match, method wildcard (Service/*), service wildcard (myapp.* /Method).
   */
  private matchMethodPattern(parsed: GrpcPath, pattern: string): boolean {
    const slashIndex = pattern.indexOf('/');
    if (slashIndex === -1) {
      // No slash - treat as service pattern
      return this.matchServicePattern(parsed, pattern);
    }

    const servicePattern = pattern.slice(0, slashIndex);
    const methodPattern = pattern.slice(slashIndex + 1);

    // Check service match
    const serviceMatches = this.matchServicePattern(parsed, servicePattern);
    if (!serviceMatches) {
      return false;
    }

    // Check method match
    if (methodPattern === '*') {
      return true;
    }

    return parsed.method === methodPattern;
  }

  /**
   * Check if a service is the gRPC reflection service.
   */
  private isReflectionService(service: string): boolean {
    return service === GRPC_REFLECTION_SERVICE ||
           service === GRPC_REFLECTION_SERVICE_V1;
  }

  /**
   * Check if a service is the gRPC health check service.
   */
  private isHealthService(service: string): boolean {
    return service === GRPC_HEALTH_SERVICE;
  }

  /**
   * Validate gRPC rule configuration.
   */
  static validateConfig(config: GrpcRuleConfig): string[] {
    const errors: string[] = [];

    if (config.services) {
      if (!Array.isArray(config.services)) {
        errors.push('services must be an array');
      } else {
        for (const service of config.services) {
          if (typeof service !== 'string' || service.length === 0) {
            errors.push('Each service must be a non-empty string');
          }
        }
      }
    }

    if (config.methods) {
      if (!Array.isArray(config.methods)) {
        errors.push('methods must be an array');
      } else {
        for (const method of config.methods) {
          if (typeof method !== 'string' || method.length === 0) {
            errors.push('Each method must be a non-empty string');
          }
          // Validate method format (should contain /)
          if (typeof method === 'string' && !method.includes('/') && !method.endsWith('.*')) {
            errors.push(`Method '${method}' should be in format 'Service/Method'`);
          }
        }
      }
    }

    if (config.maxMessageSize !== undefined) {
      if (typeof config.maxMessageSize !== 'number' || config.maxMessageSize <= 0) {
        errors.push('maxMessageSize must be a positive number');
      }
    }

    if (config.maxConcurrentStreams !== undefined) {
      if (typeof config.maxConcurrentStreams !== 'number' || config.maxConcurrentStreams <= 0) {
        errors.push('maxConcurrentStreams must be a positive number');
      }
    }

    if (config.streamingRateLimit !== undefined) {
      if (typeof config.streamingRateLimit !== 'number' || config.streamingRateLimit <= 0) {
        errors.push('streamingRateLimit must be a positive number');
      }
    }

    return errors;
  }
}

/**
 * Create a gRPC matcher instance.
 */
export function createGrpcMatcher(): GrpcMatcher {
  return new GrpcMatcher();
}
