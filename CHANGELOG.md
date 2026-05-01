# Changelog

## v0.2.0

The pivot release. ts-agent-proxy is now positioned as a network firewall for AI coding agents, not a generic HTTP allowlist proxy. The README, profiles, run/tail subcommands, secret redaction, MCP awareness, and the safe-defaults policy that ships out of the box all serve that identity.

### Added
- **Safe defaults** (`src/profiles/safe-defaults.ts`). Out of the box the proxy denies cloud metadata DNS (`metadata.google.internal`, Azure metadata), RFC1918 ranges, loopback, link-local (catches IMDS at 169.254.169.254), ULA, the unspecified address, and plain HTTP egress to non-allowlisted hosts. A separate async DNS-rebinding check resolves outbound hostnames and matches the resolved IP against the same blocklist. Disable with `--unsafe-disable-defaults`.
- **Profile system** (`src/profiles/`). Built-in profiles for `claude-code`, `codex`, `cursor`, and `generic-agent`. List with `--list-profiles`; pick with `--profile`. Profile rules merge under user rules; ID collisions resolved by suffixing the profile rule.
- **`run` subcommand** (`src/cli/run.ts`). `ts-agent-proxy run --profile <name> -- <command>` picks a free port, generates or loads a cached CA at `~/.cache/ts-agent-proxy/ca.pem` (XDG on Linux/Mac, LOCALAPPDATA on Windows), boots the proxy in MITM mode, and spawns the child with `HTTP_PROXY`, `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`. Stdio inherited; signals forwarded with a 10s grace window before SIGKILL; child exit code propagated.
- **`tail` subcommand** (`src/cli/tail.ts`). `ts-agent-proxy tail` connects to a running proxy's `/api/audit/stream` SSE endpoint and prints audit events in a columnar view. Auto-discovers via pidfile, falls back to `--admin-url`. `--blocks-only`, `--json`, `--since=5m` supported.
- **YAML policy support** (`src/config/yaml-loader.ts`). Auto-detects format by extension; YAML errors carry line/column when known; both formats route through the existing Zod schemas.
- **Secret detection + audit redaction** (`src/filter/secret-detector.ts`). Detectors for Anthropic, OpenAI, GitHub PAT/classic, AWS access/secret keys, Slack tokens/webhooks, Google API keys. High-entropy patterns are gated on keyword context to suppress git-SHA-style false positives. The audit logger now scrubs request bodies and header values before writing or streaming.
- **MCP awareness** (`src/filter/mcp-matcher.ts`). Parses JSON-RPC 2.0 envelopes and matches `tools/call` against per-server allowlist/blocklist policies. Block decisions render JSON-RPC error responses (code -32601) so the agent surfaces a meaningful failure.
- **Audit SSE stream** (`/api/audit/stream` on the admin server). Server-Sent Events with `?include=blocks-only` and `?since=5m` replay from a bounded ring buffer (1000 entries by default).
- **`--help` surface**. `ts-agent-proxy --help` prints a one-screen common-flags summary; `--help --advanced` reveals the rest.
- **Demo** (`demos/run-demo.sh`, `demos/agent-sim.sh`, `demos/sample-audit.log`). Reproducible 5-call demo that ends with a clean sample audit log.

### Changed
- README rewritten around the agent-firewall identity. `package.json` description and keywords updated. Startup banner updated.
- Advanced topics (MITM cert internals, multi-tenant, gRPC-Web, OTel exporter selection, WASM bridge, library embedding) moved to `docs/advanced/`. No code was deleted; the cut is about narrative compression.
- The matcher now evaluates: user-explicit block (always wins), allow rules (override default-blocked domains), safe-default block, default action.
- Forward-proxy and connect-handler 403 responses now propagate the matcher's reason instead of a generic "not permitted" string.
- The MITM interceptor's CONNECT denial path now writes to the audit log (previously only the response was sent). It also installs a client-socket error listener so a client RST during a denial doesn't bubble to `uncaughtException`.
- `ProxyServer` accepts a `shutdownTimeoutMs` option; the `run` subcommand uses 2s so the foreground devtool exits promptly when the agent does.

### Fixed
- CONNECT integration test no longer treated Node's `'connect'` event as proof of tunnel success — it's emitted for any response to a CONNECT, including 403s. The deny-test was masked by this; now success is derived from the status code.

### Tests
- 1223 unit tests, 9 integration tests, all green from a clean `npm ci`.
- Coverage: critical-path filtering, profile registry/merge, safe-defaults, secret detection, MCP matcher, YAML loader, run subcommand (CA cache, child env, exit-code propagation), tail subcommand (pidfile lifecycle, formatting, SSE end-to-end).

## v0.1.0

Initial release. HTTP allowlist proxy with TLS MITM, gRPC, WebSocket, audit logging, OpenTelemetry, and admin endpoints.
