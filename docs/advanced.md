# Advanced topics

This is an advanced reference. If you're new, start with the [README](../README.md).

The topics below cover surface area most users never touch.

- [MITM certificate management](advanced/mitm-cert-management.md) — how the local CA is generated, cached, and refreshed; where it lives on disk; how `run` injects it into the child without touching the system trust store.
- [Multi-tenant isolation](advanced/multi-tenant.md) — running one proxy across multiple tenants with isolated allowlists.
- [gRPC and gRPC-Web](advanced/grpc-web.md) — per-rule service/method allowlisting for gRPC traffic.
- [OpenTelemetry exporters](advanced/otel-exporters.md) — selecting OTLP HTTP / OTLP gRPC / Jaeger.
- [WASM sandbox bridge](advanced/wasm-bridge.md) — wiring the proxy into a WASI sandbox runtime.
- [Embedding as a library](advanced/embedding.md) — programmatic API for hosting the proxy inside another service.

For Docker / Kubernetes / Helm, see `Dockerfile`, `docker-compose.yml`, and the `monitoring/` directory at the repo root.
