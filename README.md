# ts-agent-proxy

HTTP allowlist proxy for filtering AI agent network requests.

## Features

- **Domain allowlisting** - Control which domains agents can access
- **Wildcard support** - `*.example.com` or `**.example.com` patterns
- **Path filtering** - Glob patterns for allowed paths (MITM mode)
- **Method filtering** - Restrict HTTP methods per rule
- **Rate limiting** - Per-rule request limits
- **Audit logging** - Security logs for all decisions
- **Two modes**:
  - **Tunnel mode** (default) - CONNECT tunneling, domain-level filtering
  - **MITM mode** - Full inspection with dynamic certificates

## Installation

```bash
npm install
npm run build
```

## Usage

### Start the Proxy

```bash
# Development
npm run dev

# Production
npm start

# With options
npm start -- --port=8080 --host=127.0.0.1 --mode=tunnel
```

### Configure Allowlist

Edit `config/allowlist.json`:

```json
{
  "mode": "strict",
  "defaultAction": "deny",
  "rules": [
    {
      "id": "openai-api",
      "domain": "api.openai.com",
      "paths": ["/v1/chat/completions", "/v1/models"],
      "methods": ["POST", "GET"],
      "rateLimit": { "requestsPerMinute": 60 }
    },
    {
      "id": "github-readonly",
      "domain": "api.github.com",
      "paths": ["/repos/**", "/users/**"],
      "methods": ["GET"]
    }
  ]
}
```

### Test the Proxy

```bash
# Allowed request
curl -x http://127.0.0.1:8080 https://api.openai.com/v1/models

# Blocked request (should return 403)
curl -x http://127.0.0.1:8080 https://evil.com
```

### Use with AI Agents

Set environment variables:

```bash
export HTTP_PROXY=http://127.0.0.1:8080
export HTTPS_PROXY=http://127.0.0.1:8080
```

## Running Tests

```bash
npm test                    # Unit tests
npm run test:integration    # Integration tests
```

## API (Programmatic Usage)

```typescript
import { createProxyServer, loadAllowlistConfig } from 'ts-agent-proxy';

const config = {
  server: {
    host: '127.0.0.1',
    port: 8080,
    mode: 'tunnel',
    logging: { level: 'info', console: true, pretty: true }
  },
  allowlist: loadAllowlistConfig('./config/allowlist.json')
};

const server = createProxyServer({ config });
await server.start();

// Reload allowlist at runtime
server.reloadAllowlist(newAllowlistConfig);

// Stop
await server.stop();
```

## Integration with Wasm Sandbox

```typescript
import { generateSandboxNetworkConfig } from 'ts-agent-proxy';

const sandboxConfig = generateSandboxNetworkConfig('127.0.0.1', 8080);
// Returns environment variables and WASI config for routing
// sandbox traffic through the proxy
```

## Domain Pattern Examples

| Pattern | Matches |
|---------|---------|
| `api.example.com` | Exact match only |
| `*.example.com` | `foo.example.com` (one level) |
| `**.example.com` | `foo.bar.example.com` (any depth) |
