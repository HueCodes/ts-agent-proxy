# Advanced topics

This is an advanced reference. If you're new, start with the [README](../README.md).

The topics below cover surface area that most users never touch — TLS MITM cert management, multi-tenant isolation, gRPC-Web specifics, OpenTelemetry exporter selection, library-mode embedding, Docker/Helm deployment.

Detailed pages will land here as the project matures. For now, refer to:

- Source under `src/proxy/mitm/` for MITM cert generation and per-host cert caching.
- `src/proxy/multi-tenant.ts` for per-tenant rule isolation.
- `src/proxy/grpc-web-handler.ts` for gRPC-Web framing.
- `src/telemetry/` for OpenTelemetry wiring (OTLP HTTP is the default; OTLP gRPC and Jaeger are also supported).
- `src/integration/wasm-bridge.ts` for embedding the proxy alongside a WASI sandbox.
- `Dockerfile` and `docker-compose.yml` for the reference stack with Prometheus + Grafana.

Run `ts-agent-proxy --help --advanced` to see flags hidden from the common help output.
