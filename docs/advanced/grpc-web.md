# gRPC and gRPC-Web

This is an advanced topic. If you're new, start with the [README](../../README.md).

The proxy understands gRPC and gRPC-Web framing. gRPC support exists primarily so MCP servers and agent-orchestration tooling that speak gRPC can be allowlisted at the service / method level. gRPC-Web (the browser-friendly framing) is implemented but rarely useful for an agent firewall — most agents are CLIs.

Per-rule gRPC config (`grpc.services`, `grpc.methods`, `grpc.allowReflection`, `grpc.allowHealthCheck`) is documented in `src/types/allowlist.ts`. Implementation lives at `src/proxy/grpc-handler.ts`, `src/proxy/grpc-parser.ts`, and `src/proxy/grpc-web-handler.ts`.

If you don't need gRPC, you can ignore this surface entirely.
