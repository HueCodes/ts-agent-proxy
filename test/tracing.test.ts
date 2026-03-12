import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock OpenTelemetry modules before importing the module under test
const mockSdkStart = vi.fn().mockResolvedValue(undefined);
const mockSdkShutdown = vi.fn().mockResolvedValue(undefined);

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: vi.fn().mockImplementation(() => ({
    start: mockSdkStart,
    shutdown: mockSdkShutdown,
  })),
}));

vi.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: vi.fn().mockReturnValue([]),
}));

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: vi.fn(),
}));

vi.mock('@opentelemetry/exporter-jaeger', () => ({
  JaegerExporter: vi.fn(),
}));

vi.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: vi.fn().mockReturnValue({}),
}));

vi.mock('@opentelemetry/semantic-conventions', () => ({
  ATTR_SERVICE_NAME: 'service.name',
  ATTR_SERVICE_VERSION: 'service.version',
}));

const mockSpan = {
  spanContext: vi.fn().mockReturnValue({
    traceId: 'abc123trace',
    spanId: 'def456span',
  }),
  setAttribute: vi.fn(),
  setAttributes: vi.fn(),
  addEvent: vi.fn(),
  setStatus: vi.fn(),
  recordException: vi.fn(),
  end: vi.fn(),
  isRecording: vi.fn().mockReturnValue(true),
  updateName: vi.fn(),
};

const mockTracer = {
  startSpan: vi.fn().mockReturnValue(mockSpan),
  startActiveSpan: vi.fn(),
};

const mockNoopSpan = {
  spanContext: vi.fn().mockReturnValue({ traceId: '', spanId: '' }),
  setAttribute: vi.fn(),
  setAttributes: vi.fn(),
  addEvent: vi.fn(),
  setStatus: vi.fn(),
  recordException: vi.fn(),
  end: vi.fn(),
  isRecording: vi.fn().mockReturnValue(false),
  updateName: vi.fn(),
};

const mockNoopTracer = {
  startSpan: vi.fn().mockReturnValue(mockNoopSpan),
  startActiveSpan: vi.fn(),
};

const mockExtract = vi.fn().mockReturnValue({} as any);
const mockInject = vi.fn();
const mockGetSpan = vi.fn().mockReturnValue(undefined);
const mockSetSpan = vi.fn().mockReturnValue({} as any);
const mockContextActive = vi.fn().mockReturnValue({} as any);
const mockContextWith = vi.fn().mockImplementation((_ctx: any, fn: () => any) => fn());
const mockGetTracer = vi.fn().mockReturnValue(mockNoopTracer);

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: (...args: any[]) => mockGetTracer(...args),
    getSpan: (...args: any[]) => mockGetSpan(...args),
    setSpan: (...args: any[]) => mockSetSpan(...args),
  },
  context: {
    active: () => mockContextActive(),
    with: (...args: any[]) => mockContextWith(...args),
  },
  propagation: {
    extract: (...args: any[]) => mockExtract(...args),
    inject: (...args: any[]) => mockInject(...args),
  },
  SpanStatusCode: {
    UNSET: 0,
    OK: 1,
    ERROR: 2,
  },
  SpanKind: {
    INTERNAL: 0,
    SERVER: 1,
    CLIENT: 2,
    PRODUCER: 3,
    CONSUMER: 4,
  },
}));

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  TracingManager,
  createTracingManager,
  DEFAULT_TRACING_CONFIG,
  SpanStatusCode,
  SpanKind,
  trace,
  context,
  propagation,
} from '../src/telemetry/tracing.js';

describe('TracingManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTracer.mockReturnValue(mockNoopTracer);
  });

  describe('constructor', () => {
    it('should use default config when no config provided', () => {
      const manager = new TracingManager();
      expect(manager.isEnabled()).toBe(false);
    });

    it('should merge provided config with defaults', () => {
      const manager = new TracingManager({
        enabled: true,
        serviceName: 'custom-service',
      });
      // enabled is true but not initialized, so isEnabled() still false
      expect(manager.isEnabled()).toBe(false);
      expect(manager.getTracer()).toBeUndefined();
    });

    it('should allow partial config override', () => {
      const manager = new TracingManager({ samplingRatio: 0.5 });
      expect(manager.isEnabled()).toBe(false);
    });
  });

  describe('initialize', () => {
    it('should not initialize when disabled', async () => {
      const manager = new TracingManager({ enabled: false });
      await manager.initialize();
      expect(NodeSDK).not.toHaveBeenCalled();
      expect(manager.isEnabled()).toBe(false);
    });

    it('should not initialize when exporter is none', async () => {
      const manager = new TracingManager({ enabled: true, exporter: 'none' });
      await manager.initialize();
      expect(NodeSDK).not.toHaveBeenCalled();
      expect(manager.isEnabled()).toBe(false);
    });

    it('should initialize with OTLP exporter', async () => {
      mockGetTracer.mockReturnValue(mockTracer);
      const manager = new TracingManager({
        enabled: true,
        exporter: 'otlp',
        otlpEndpoint: 'http://collector:4318/v1/traces',
      });
      await manager.initialize();

      expect(OTLPTraceExporter).toHaveBeenCalledWith({
        url: 'http://collector:4318/v1/traces',
      });
      expect(NodeSDK).toHaveBeenCalled();
      expect(mockSdkStart).toHaveBeenCalled();
      expect(manager.isEnabled()).toBe(true);
    });

    it('should use default OTLP endpoint when not specified', async () => {
      mockGetTracer.mockReturnValue(mockTracer);
      const manager = new TracingManager({
        enabled: true,
        exporter: 'otlp',
      });
      await manager.initialize();

      expect(OTLPTraceExporter).toHaveBeenCalledWith({
        url: 'http://localhost:4318/v1/traces',
      });
    });

    it('should initialize with Jaeger exporter', async () => {
      mockGetTracer.mockReturnValue(mockTracer);
      const manager = new TracingManager({
        enabled: true,
        exporter: 'jaeger',
        jaegerHost: 'jaeger-host',
        jaegerPort: 6831,
      });
      await manager.initialize();

      expect(JaegerExporter).toHaveBeenCalledWith({
        host: 'jaeger-host',
        port: 6831,
      });
      expect(NodeSDK).toHaveBeenCalled();
      expect(manager.isEnabled()).toBe(true);
    });

    it('should use default Jaeger host/port when not specified', async () => {
      mockGetTracer.mockReturnValue(mockTracer);
      const manager = new TracingManager({
        enabled: true,
        exporter: 'jaeger',
      });
      await manager.initialize();

      expect(JaegerExporter).toHaveBeenCalledWith({
        host: 'localhost',
        port: 6832,
      });
    });

    it('should initialize with console exporter', async () => {
      mockGetTracer.mockReturnValue(mockTracer);
      const manager = new TracingManager({
        enabled: true,
        exporter: 'console',
      });
      await manager.initialize();

      expect(NodeSDK).toHaveBeenCalled();
      expect(manager.isEnabled()).toBe(true);
    });

    it('should create resource with service name and version', async () => {
      mockGetTracer.mockReturnValue(mockTracer);
      const manager = new TracingManager({
        enabled: true,
        exporter: 'otlp',
        serviceName: 'test-service',
        serviceVersion: '1.0.0',
      });
      await manager.initialize();

      expect(resourceFromAttributes).toHaveBeenCalledWith({
        'service.name': 'test-service',
        'service.version': '1.0.0',
      });
    });

    it('should include auto-instrumentations when enabled', async () => {
      mockGetTracer.mockReturnValue(mockTracer);
      const manager = new TracingManager({
        enabled: true,
        exporter: 'otlp',
        autoInstrumentation: true,
      });
      await manager.initialize();

      expect(getNodeAutoInstrumentations).toHaveBeenCalledWith({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
      });
    });

    it('should not include auto-instrumentations when disabled', async () => {
      mockGetTracer.mockReturnValue(mockTracer);
      const manager = new TracingManager({
        enabled: true,
        exporter: 'otlp',
        autoInstrumentation: false,
      });
      await manager.initialize();

      expect(getNodeAutoInstrumentations).not.toHaveBeenCalled();
      const sdkCall = (NodeSDK as any).mock.calls[0][0];
      expect(sdkCall.instrumentations).toEqual([]);
    });

    it('should get tracer with service name and version', async () => {
      mockGetTracer.mockReturnValue(mockTracer);
      const manager = new TracingManager({
        enabled: true,
        exporter: 'otlp',
        serviceName: 'my-proxy',
        serviceVersion: '2.0.0',
      });
      await manager.initialize();

      expect(mockGetTracer).toHaveBeenCalledWith('my-proxy', '2.0.0');
    });

    it('should not re-initialize if already initialized', async () => {
      mockGetTracer.mockReturnValue(mockTracer);
      const manager = new TracingManager({
        enabled: true,
        exporter: 'otlp',
      });
      await manager.initialize();
      await manager.initialize();

      expect(NodeSDK).toHaveBeenCalledTimes(1);
    });
  });

  describe('shutdown', () => {
    it('should shutdown SDK when initialized', async () => {
      mockGetTracer.mockReturnValue(mockTracer);
      const manager = new TracingManager({
        enabled: true,
        exporter: 'otlp',
      });
      await manager.initialize();
      await manager.shutdown();

      expect(mockSdkShutdown).toHaveBeenCalled();
      expect(manager.isEnabled()).toBe(false);
    });

    it('should do nothing when SDK is not initialized', async () => {
      const manager = new TracingManager();
      await manager.shutdown();
      expect(mockSdkShutdown).not.toHaveBeenCalled();
    });
  });

  describe('getTracer', () => {
    it('should return undefined when not initialized', () => {
      const manager = new TracingManager();
      expect(manager.getTracer()).toBeUndefined();
    });

    it('should return tracer when initialized', async () => {
      mockGetTracer.mockReturnValue(mockTracer);
      const manager = new TracingManager({
        enabled: true,
        exporter: 'otlp',
      });
      await manager.initialize();
      expect(manager.getTracer()).toBe(mockTracer);
    });
  });

  describe('isEnabled', () => {
    it('should return false when disabled and not initialized', () => {
      const manager = new TracingManager({ enabled: false });
      expect(manager.isEnabled()).toBe(false);
    });

    it('should return false when enabled but not initialized', () => {
      const manager = new TracingManager({ enabled: true });
      expect(manager.isEnabled()).toBe(false);
    });

    it('should return true when enabled and initialized', async () => {
      mockGetTracer.mockReturnValue(mockTracer);
      const manager = new TracingManager({
        enabled: true,
        exporter: 'otlp',
      });
      await manager.initialize();
      expect(manager.isEnabled()).toBe(true);
    });

    it('should return false after shutdown', async () => {
      mockGetTracer.mockReturnValue(mockTracer);
      const manager = new TracingManager({
        enabled: true,
        exporter: 'otlp',
      });
      await manager.initialize();
      await manager.shutdown();
      expect(manager.isEnabled()).toBe(false);
    });
  });

  describe('startProxySpan', () => {
    it('should return noop span when tracer is not initialized', () => {
      const manager = new TracingManager();
      const span = manager.startProxySpan('test-span');

      expect(mockGetTracer).toHaveBeenCalledWith('noop');
      expect(mockNoopTracer.startSpan).toHaveBeenCalledWith('noop');
      expect(span).toBe(mockNoopSpan);
    });

    it('should create span with SERVER kind when tracer is available', async () => {
      mockGetTracer.mockReturnValue(mockTracer);
      const manager = new TracingManager({
        enabled: true,
        exporter: 'otlp',
      });
      await manager.initialize();

      const attrs = { 'http.method': 'GET', 'http.url': '/api' };
      const span = manager.startProxySpan('proxy-request', attrs);

      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'proxy-request',
        {
          kind: SpanKind.SERVER,
          attributes: attrs,
        },
        expect.anything(),
      );
      expect(span).toBe(mockSpan);
    });

    it('should use parent context when provided', async () => {
      mockGetTracer.mockReturnValue(mockTracer);
      const manager = new TracingManager({
        enabled: true,
        exporter: 'otlp',
      });
      await manager.initialize();

      const parentCtx = { custom: 'context' } as any;
      manager.startProxySpan('test', undefined, parentCtx);

      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'test',
        {
          kind: SpanKind.SERVER,
          attributes: undefined,
        },
        parentCtx,
      );
    });

    it('should use active context when no parent context provided', async () => {
      mockGetTracer.mockReturnValue(mockTracer);
      const activeCtx = { active: true };
      mockContextActive.mockReturnValue(activeCtx);

      const manager = new TracingManager({
        enabled: true,
        exporter: 'otlp',
      });
      await manager.initialize();

      manager.startProxySpan('test');

      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'test',
        expect.anything(),
        activeCtx,
      );
    });
  });

  describe('startChildSpan', () => {
    it('should return noop span when tracer is not initialized', () => {
      const manager = new TracingManager();
      const span = manager.startChildSpan('child', mockSpan as any);

      expect(mockGetTracer).toHaveBeenCalledWith('noop');
      expect(span).toBe(mockNoopSpan);
    });

    it('should create child span with INTERNAL kind', async () => {
      mockGetTracer.mockReturnValue(mockTracer);
      const childCtx = { child: true };
      mockSetSpan.mockReturnValue(childCtx);

      const manager = new TracingManager({
        enabled: true,
        exporter: 'otlp',
      });
      await manager.initialize();

      const attrs = { 'custom.attr': 'value' };
      const span = manager.startChildSpan('child-op', mockSpan as any, attrs);

      expect(mockSetSpan).toHaveBeenCalledWith(expect.anything(), mockSpan);
      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'child-op',
        {
          kind: SpanKind.INTERNAL,
          attributes: attrs,
        },
        childCtx,
      );
      expect(span).toBe(mockSpan);
    });
  });

  describe('extractContext', () => {
    it('should extract context from request headers', () => {
      const manager = new TracingManager();
      const req = { headers: { traceparent: '00-abc-def-01' } } as any;

      manager.extractContext(req);

      expect(mockExtract).toHaveBeenCalledWith(expect.anything(), req.headers);
    });
  });

  describe('injectContext', () => {
    it('should inject context into headers', () => {
      const manager = new TracingManager();
      const headers: Record<string, string> = {};

      manager.injectContext(headers);

      expect(mockInject).toHaveBeenCalledWith(expect.anything(), headers);
    });
  });

  describe('getCurrentTraceId', () => {
    it('should return undefined when no active span', () => {
      mockGetSpan.mockReturnValue(undefined);
      const manager = new TracingManager();
      expect(manager.getCurrentTraceId()).toBeUndefined();
    });

    it('should return trace ID from active span', () => {
      mockGetSpan.mockReturnValue(mockSpan);
      const manager = new TracingManager();
      expect(manager.getCurrentTraceId()).toBe('abc123trace');
    });
  });

  describe('getCurrentSpanId', () => {
    it('should return undefined when no active span', () => {
      mockGetSpan.mockReturnValue(undefined);
      const manager = new TracingManager();
      expect(manager.getCurrentSpanId()).toBeUndefined();
    });

    it('should return span ID from active span', () => {
      mockGetSpan.mockReturnValue(mockSpan);
      const manager = new TracingManager();
      expect(manager.getCurrentSpanId()).toBe('def456span');
    });
  });

  describe('withSpan', () => {
    it('should execute function within span and set OK status on success', async () => {
      mockGetTracer.mockReturnValue(mockTracer);
      const manager = new TracingManager({
        enabled: true,
        exporter: 'otlp',
      });
      await manager.initialize();

      const result = await manager.withSpan('test-op', async (span) => {
        expect(span).toBe(mockSpan);
        return 'result';
      });

      expect(result).toBe('result');
      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.OK,
      });
      expect(mockSpan.end).toHaveBeenCalled();
    });

    it('should record exception and set ERROR status on failure', async () => {
      mockGetTracer.mockReturnValue(mockTracer);
      const manager = new TracingManager({
        enabled: true,
        exporter: 'otlp',
      });
      await manager.initialize();

      const error = new Error('test error');

      await expect(
        manager.withSpan('fail-op', async () => {
          throw error;
        }),
      ).rejects.toThrow('test error');

      expect(mockSpan.recordException).toHaveBeenCalledWith(error);
      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: 'test error',
      });
      expect(mockSpan.end).toHaveBeenCalled();
    });

    it('should pass attributes to startProxySpan', async () => {
      mockGetTracer.mockReturnValue(mockTracer);
      const manager = new TracingManager({
        enabled: true,
        exporter: 'otlp',
      });
      await manager.initialize();

      const attrs = { 'http.method': 'POST' } as any;
      await manager.withSpan('op', async () => 'ok', attrs);

      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'op',
        expect.objectContaining({
          kind: SpanKind.SERVER,
          attributes: attrs,
        }),
        expect.anything(),
      );
    });

    it('should always end span even on error', async () => {
      mockGetTracer.mockReturnValue(mockTracer);
      const manager = new TracingManager({
        enabled: true,
        exporter: 'otlp',
      });
      await manager.initialize();

      try {
        await manager.withSpan('op', async () => {
          throw new Error('fail');
        });
      } catch {
        // expected
      }

      expect(mockSpan.end).toHaveBeenCalledTimes(1);
    });
  });

  describe('recordException', () => {
    it('should record exception on current span', () => {
      mockGetSpan.mockReturnValue(mockSpan);
      const manager = new TracingManager();
      const error = new Error('something went wrong');

      manager.recordException(error);

      expect(mockSpan.recordException).toHaveBeenCalledWith(error);
      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: 'something went wrong',
      });
    });

    it('should do nothing when no active span', () => {
      mockGetSpan.mockReturnValue(undefined);
      const manager = new TracingManager();

      // Should not throw
      manager.recordException(new Error('no span'));
    });
  });

  describe('addEvent', () => {
    it('should add event to current span', () => {
      mockGetSpan.mockReturnValue(mockSpan);
      const manager = new TracingManager();
      const attrs = { key: 'value' };

      manager.addEvent('test-event', attrs);

      expect(mockSpan.addEvent).toHaveBeenCalledWith('test-event', attrs);
    });

    it('should do nothing when no active span', () => {
      mockGetSpan.mockReturnValue(undefined);
      const manager = new TracingManager();

      // Should not throw
      manager.addEvent('event');
    });
  });

  describe('setAttributes', () => {
    it('should set attributes on current span', () => {
      mockGetSpan.mockReturnValue(mockSpan);
      const manager = new TracingManager();
      const attrs = { foo: 'bar', count: 42 };

      manager.setAttributes(attrs);

      expect(mockSpan.setAttributes).toHaveBeenCalledWith(attrs);
    });

    it('should do nothing when no active span', () => {
      mockGetSpan.mockReturnValue(undefined);
      const manager = new TracingManager();

      // Should not throw
      manager.setAttributes({ key: 'value' });
    });
  });

  describe('createTracingManager', () => {
    it('should create a TracingManager instance', () => {
      const manager = createTracingManager();
      expect(manager).toBeInstanceOf(TracingManager);
    });

    it('should pass config to TracingManager', () => {
      const manager = createTracingManager({
        enabled: true,
        serviceName: 'factory-service',
      });
      expect(manager).toBeInstanceOf(TracingManager);
    });
  });

  describe('DEFAULT_TRACING_CONFIG', () => {
    it('should have expected default values', () => {
      expect(DEFAULT_TRACING_CONFIG).toEqual({
        enabled: false,
        serviceName: 'ts-agent-proxy',
        serviceVersion: '0.1.0',
        exporter: 'none',
        samplingRatio: 1.0,
        autoInstrumentation: true,
      });
    });
  });

  describe('re-exports', () => {
    it('should re-export SpanStatusCode', () => {
      expect(SpanStatusCode).toBeDefined();
      expect(SpanStatusCode.OK).toBe(1);
      expect(SpanStatusCode.ERROR).toBe(2);
    });

    it('should re-export SpanKind', () => {
      expect(SpanKind).toBeDefined();
      expect(SpanKind.SERVER).toBe(1);
      expect(SpanKind.INTERNAL).toBe(0);
      expect(SpanKind.CLIENT).toBe(2);
    });

    it('should re-export trace', () => {
      expect(trace).toBeDefined();
      expect(typeof trace.getTracer).toBe('function');
      expect(typeof trace.getSpan).toBe('function');
    });

    it('should re-export context', () => {
      expect(context).toBeDefined();
      expect(typeof context.active).toBe('function');
    });

    it('should re-export propagation', () => {
      expect(propagation).toBeDefined();
      expect(typeof propagation.extract).toBe('function');
      expect(typeof propagation.inject).toBe('function');
    });
  });
});
