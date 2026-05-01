# WASM sandbox bridge

This is an advanced topic. If you're new, start with the [README](../../README.md).

`generateSandboxNetworkConfig()` returns env vars and WASI config that route a WebAssembly sandbox's network calls through the proxy. This is useful only if you're embedding both the proxy and a WASI sandbox inside another runtime — there is no agent in the wild today that uses this combination.

Source: `src/integration/wasm-bridge.ts`. Treat as experimental.
