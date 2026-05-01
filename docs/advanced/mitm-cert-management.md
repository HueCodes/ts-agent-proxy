# MITM certificate management

This is an advanced topic. If you're new, start with the [README](../../README.md).

In `mitm` mode, the proxy generates a per-domain TLS leaf cert signed by a local CA so it can decrypt request bodies for redaction and policy decisions. The CA is generated automatically on first use and cached at `$XDG_CACHE_HOME/ts-agent-proxy/ca.pem` (Linux/macOS) or `%LOCALAPPDATA%\ts-agent-proxy\ca.pem` (Windows).

The `run` subcommand wires the CA into the child via `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, and `REQUESTS_CA_BUNDLE`, so you do not need to install it in the system trust store. If you embed the proxy yourself or run it standalone with a long-lived agent, you may want to import the CA into the agent's trust configuration.

Cert refresh: the CA is regenerated automatically if it's missing, unparseable, or expiring within 30 days. Per-domain leaf certs live in an in-memory LRU cache (default 1000 entries, 24h TTL).

For deeper internals, see `src/proxy/mitm/cert-manager.ts` and `src/cli/ca-cache.ts`.
