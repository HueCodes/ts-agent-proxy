# OpenTelemetry exporters

This is an advanced topic. If you're new, start with the [README](../../README.md).

The proxy can emit traces via OpenTelemetry. Default exporter is OTLP HTTP, which is the right choice for most setups. Two alternatives are available for legacy environments:

- **OTLP gRPC** — for OpenTelemetry collectors fronted by gRPC.
- **Jaeger native** — for environments still running Jaeger's native protocol (deprecated upstream but widespread).

Selection is via env var:

```
OTEL_EXPORTER=otlp-http   # default
OTEL_EXPORTER=otlp-grpc
OTEL_EXPORTER=jaeger
```

The exporter is wired in `src/telemetry/tracing.ts`. If you don't need observability, leave the env unset and the no-op exporter is used.
