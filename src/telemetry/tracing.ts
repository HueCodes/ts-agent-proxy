/**
 * OpenTelemetry tracing integration.
 *
 * Provides distributed tracing for proxy requests with support
 * for multiple exporters (Jaeger, OTLP).
 *
 * @module telemetry/tracing
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import {
  trace,
  context,
  SpanStatusCode,
  SpanKind,
  propagation,
  type Span,
  type Tracer,
  type Context,
} from '@opentelemetry/api';
import type { IncomingMessage } from 'node:http';

/**
 * Tracing exporter type.
 */
export type TracingExporter = 'jaeger' | 'otlp' | 'console' | 'none';

/**
 * Tracing configuration.
 */
export interface TracingConfig {
  /** Enable tracing (default: false) */
  enabled: boolean;
  /** Service name for spans */
  serviceName: string;
  /** Service version */
  serviceVersion: string;
  /** Exporter to use */
  exporter: TracingExporter;
  /** OTLP endpoint URL (for 'otlp' exporter) */
  otlpEndpoint?: string;
  /** Jaeger agent host (for 'jaeger' exporter) */
  jaegerHost?: string;
  /** Jaeger agent port (for 'jaeger' exporter) */
  jaegerPort?: number;
  /** Sampling ratio (0.0 to 1.0, default: 1.0) */
  samplingRatio: number;
  /** Enable auto-instrumentation (default: true) */
  autoInstrumentation: boolean;
}

/**
 * Default tracing configuration.
 */
export const DEFAULT_TRACING_CONFIG: TracingConfig = {
  enabled: false,
  serviceName: 'ts-agent-proxy',
  serviceVersion: '0.1.0',
  exporter: 'none',
  samplingRatio: 1.0,
  autoInstrumentation: true,
};

/**
 * Span attributes for proxy requests.
 */
export interface ProxySpanAttributes {
  /** Target host */
  'proxy.target_host'?: string;
  /** Target port */
  'proxy.target_port'?: number;
  /** Request method */
  'http.method'?: string;
  /** Request path */
  'http.url'?: string;
  /** Response status code */
  'http.status_code'?: number;
  /** Matched rule ID */
  'proxy.rule_id'?: string;
  /** Allow/deny decision */
  'proxy.decision'?: 'allow' | 'deny' | 'rate_limited';
  /** Denial reason */
  'proxy.deny_reason'?: string;
  /** Request size in bytes */
  'http.request_content_length'?: number;
  /** Response size in bytes */
  'http.response_content_length'?: number;
  /** Client IP */
  'client.address'?: string;
  /** Proxy mode */
  'proxy.mode'?: 'tunnel' | 'mitm' | 'forward';
}

/**
 * Tracing manager for OpenTelemetry integration.
 *
 * Initializes the OpenTelemetry SDK and provides helpers for
 * creating and managing spans.
 *
 * @example
 * ```typescript
 * const tracing = new TracingManager({
 *   enabled: true,
 *   serviceName: 'my-proxy',
 *   exporter: 'jaeger',
 *   jaegerHost: 'localhost',
 * });
 *
 * await tracing.initialize();
 *
 * // Create a span for a proxy request
 * const span = tracing.startProxySpan('forward-request', {
 *   'proxy.target_host': 'api.example.com',
 *   'http.method': 'GET',
 * });
 *
 * try {
 *   // ... handle request ...
 *   span.setStatus({ code: SpanStatusCode.OK });
 * } catch (error) {
 *   span.recordException(error);
 *   span.setStatus({ code: SpanStatusCode.ERROR });
 * } finally {
 *   span.end();
 * }
 * ```
 */
export class TracingManager {
  private readonly config: TracingConfig;
  private sdk?: NodeSDK;
  private tracer?: Tracer;
  private initialized = false;

  constructor(config: Partial<TracingConfig> = {}) {
    this.config = { ...DEFAULT_TRACING_CONFIG, ...config };
  }

  /**
   * Initialize the tracing SDK.
   */
  async initialize(): Promise<void> {
    if (!this.config.enabled || this.initialized) {
      return;
    }

    const exporter = this.createExporter();
    if (!exporter) {
      return;
    }

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: this.config.serviceName,
      [ATTR_SERVICE_VERSION]: this.config.serviceVersion,
    });

    this.sdk = new NodeSDK({
      resource,
      traceExporter: exporter,
      instrumentations: this.config.autoInstrumentation
        ? [getNodeAutoInstrumentations({
            '@opentelemetry/instrumentation-fs': { enabled: false },
            '@opentelemetry/instrumentation-dns': { enabled: false },
          })]
        : [],
    });

    await this.sdk.start();
    this.tracer = trace.getTracer(this.config.serviceName, this.config.serviceVersion);
    this.initialized = true;
  }

  /**
   * Create the trace exporter based on configuration.
   */
  private createExporter(): any {
    switch (this.config.exporter) {
      case 'otlp':
        return new OTLPTraceExporter({
          url: this.config.otlpEndpoint ?? 'http://localhost:4318/v1/traces',
        });
      case 'jaeger':
        return new JaegerExporter({
          host: this.config.jaegerHost ?? 'localhost',
          port: this.config.jaegerPort ?? 6832,
        });
      case 'console':
        // Console exporter for debugging
        return {
          export: (spans: any[], resultCallback: (result: any) => void) => {
            spans.forEach((span) => {
              console.log('Span:', JSON.stringify(span, null, 2));
            });
            resultCallback({ code: 0 });
          },
          shutdown: () => Promise.resolve(),
        };
      case 'none':
      default:
        return null;
    }
  }

  /**
   * Shutdown the tracing SDK.
   */
  async shutdown(): Promise<void> {
    if (this.sdk) {
      await this.sdk.shutdown();
      this.initialized = false;
    }
  }

  /**
   * Get the tracer instance.
   */
  getTracer(): Tracer | undefined {
    return this.tracer;
  }

  /**
   * Check if tracing is enabled and initialized.
   */
  isEnabled(): boolean {
    return this.config.enabled && this.initialized;
  }

  /**
   * Start a new span for a proxy request.
   */
  startProxySpan(
    name: string,
    attributes?: ProxySpanAttributes,
    parentContext?: Context
  ): Span {
    if (!this.tracer) {
      return trace.getTracer('noop').startSpan('noop');
    }

    const ctx = parentContext ?? context.active();
    const span = this.tracer.startSpan(
      name,
      {
        kind: SpanKind.SERVER,
        attributes: attributes as Record<string, any>,
      },
      ctx
    );

    return span;
  }

  /**
   * Start a child span.
   */
  startChildSpan(
    name: string,
    parent: Span,
    attributes?: Record<string, any>
  ): Span {
    if (!this.tracer) {
      return trace.getTracer('noop').startSpan('noop');
    }

    const ctx = trace.setSpan(context.active(), parent);
    return this.tracer.startSpan(
      name,
      {
        kind: SpanKind.INTERNAL,
        attributes,
      },
      ctx
    );
  }

  /**
   * Extract trace context from incoming HTTP request.
   */
  extractContext(req: IncomingMessage): Context {
    return propagation.extract(context.active(), req.headers);
  }

  /**
   * Inject trace context into outgoing HTTP headers.
   */
  injectContext(headers: Record<string, string | string[] | undefined>): void {
    propagation.inject(context.active(), headers);
  }

  /**
   * Get the current trace ID from context.
   */
  getCurrentTraceId(): string | undefined {
    const span = trace.getSpan(context.active());
    return span?.spanContext().traceId;
  }

  /**
   * Get the current span ID from context.
   */
  getCurrentSpanId(): string | undefined {
    const span = trace.getSpan(context.active());
    return span?.spanContext().spanId;
  }

  /**
   * Run a function within a span context.
   */
  async withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    attributes?: ProxySpanAttributes
  ): Promise<T> {
    const span = this.startProxySpan(name, attributes);
    const ctx = trace.setSpan(context.active(), span);

    try {
      const result = await context.with(ctx, () => fn(span));
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (error as Error).message,
      });
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Record an exception on the current span.
   */
  recordException(error: Error): void {
    const span = trace.getSpan(context.active());
    if (span) {
      span.recordException(error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message,
      });
    }
  }

  /**
   * Add an event to the current span.
   */
  addEvent(name: string, attributes?: Record<string, any>): void {
    const span = trace.getSpan(context.active());
    if (span) {
      span.addEvent(name, attributes);
    }
  }

  /**
   * Set attributes on the current span.
   */
  setAttributes(attributes: Record<string, any>): void {
    const span = trace.getSpan(context.active());
    if (span) {
      span.setAttributes(attributes);
    }
  }
}

/**
 * Create a tracing manager.
 */
export function createTracingManager(
  config?: Partial<TracingConfig>
): TracingManager {
  return new TracingManager(config);
}

// Re-export useful types and utilities
export { SpanStatusCode, SpanKind, trace, context, propagation };
export type { Span, Tracer, Context };
