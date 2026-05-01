# Embedding the proxy as a library

This is an advanced topic. If you're new, start with the [README](../../README.md).

The proxy can be used as a library (TypeScript/Node.js).

```typescript
import { createProxyServer, applySafeDefaults } from 'ts-agent-proxy';

const server = createProxyServer({
  config: {
    server: {
      host: '127.0.0.1',
      port: 8080,
      mode: 'tunnel',
      logging: { level: 'info', console: true, pretty: true },
    },
    allowlist: applySafeDefaults({
      mode: 'strict',
      defaultAction: 'deny',
      rules: [{ id: 'anthropic', domain: 'api.anthropic.com' }],
    }),
  },
});

await server.start();
// Reload at runtime if needed:
server.reloadAllowlist(newAllowlistConfig);
await server.stop();
```

Re-exports: `createProxyServer`, `createAllowlistMatcher`, `createAuditLogger`, the safe-defaults helpers, the validation schemas, and the audit-logger subscribe API. Stable API surface is whatever's exported from `src/index.ts`.

For Docker/Kubernetes deployments, see the reference Dockerfile + docker-compose.yml at the repo root and the Prometheus/Grafana wiring under `monitoring/`.
