# ts-agent-proxy

A network firewall for AI coding agents.

## The problem

You hand a long-running task to Claude Code, Cursor, Codex, or an OpenHands worker and walk away. While you're not looking, the agent installs an MCP server you didn't vet, calls a typo-squatted package mirror, queries `169.254.169.254` for cloud credentials, or POSTs an API key to a webhook it found in some scraped README. The first time you find out is when the bill arrives — or when someone else's agent does it to you.

`ts-agent-proxy` sits in front of the agent and only lets through the network calls you sanctioned. Everything else is denied and logged.

## 30-second demo

```bash
# In one terminal: run the agent under the proxy
npx ts-agent-proxy run --profile claude-code -- claude

# In another terminal: watch what gets blocked, live
npx ts-agent-proxy tail --blocks-only
```

<!-- TODO(checkpoint-9): replace with a recorded GIF -->

```
TIME       VERDICT  METHOD  HOST                          PATH                    REASON
14:02:11   BLOCK    GET     169.254.169.254               /latest/meta-data       safe-default-imds
14:02:14   ALLOW    POST    api.anthropic.com             /v1/messages            profile:claude-code
14:02:18   BLOCK    GET     evil-anthropoc.com            /api                    safe-default-typo-squat
```

## Install

```bash
npm install -g ts-agent-proxy
```

## Profiles

Pick the agent you're running. Profiles are curated allowlists.

| Profile | For |
|---|---|
| `claude-code` | Anthropic Claude Code CLI |
| `codex` | OpenAI Codex CLI |
| `cursor` | Cursor's background agents |
| `generic-agent` | Anything else (broadest reasonable defaults) |

```bash
ts-agent-proxy --list-profiles
ts-agent-proxy run --profile claude-code -- claude
```

Extend a profile with `--allow-domain` (additive) or override entirely with `--config`.

## Policy as YAML

```yaml
profile: claude-code

allow:
  domains:
    - api.anthropic.com
    - github.com
  paths:
    "github.com":
      - /HueCodes/*

block:
  domains:
    - evil.com
  ips:
    - 10.0.0.0/8

redact:
  patterns:
    - name: anthropic-key
      regex: 'sk-ant-[a-zA-Z0-9-]{40,}'
    - name: github-token
      regex: 'gh[pousr]_[A-Za-z0-9]{36,}'
```

JSON works too. Both are validated; errors include line and column.

## What it catches by default

Even with no policy file, these are blocked:

- **Cloud metadata endpoints** — IMDS at `169.254.169.254`, `metadata.google.internal`, Azure metadata DNS
- **Private IP ranges** — RFC1918 (`10/8`, `172.16/12`, `192.168/16`), loopback, link-local
- **DNS rebinding** — domains that resolve to a blocked IP
- **Plaintext HTTP egress** — to anything not explicitly allowlisted
- **Common typo-squats** — for the major LLM API hosts

Disable with `--unsafe-disable-defaults` (named to be loud).

## What it does NOT do

This is a network-layer tool. It cannot stop:

- Code execution that doesn't make outbound network calls (rm -rf, local file exfiltration to a mounted volume)
- Traffic that bypasses the proxy environment variables (raw sockets, agents that ignore `HTTPS_PROXY`)
- Attacks against an allowlisted destination from a compromised allowlisted destination

Pair it with a sandbox if those matter to you.

## Architecture

```
     ┌───────────────┐                 ┌─────────────────┐
     │   AI agent    │                 │   policy.yaml   │
     │ (claude/codex │                 │   + profile     │
     │  /cursor)     │                 └────────┬────────┘
     └───────┬───────┘                          │
             │ HTTP_PROXY=127.0.0.1:54321       │
             ▼                                  ▼
     ┌────────────────────────────────────────────────┐
     │                ts-agent-proxy                  │
     │  ┌─────────┐  ┌────────┐  ┌──────────────────┐ │
     │  │ CONNECT │─▶│ filter │─▶│ secret redaction │ │
     │  │  /MITM  │  │ (allow/│  │ MCP-aware audit  │ │
     │  └─────────┘  │  block)│  └──────────────────┘ │
     │               └────────┘                       │
     └────────────────────┬───────────────────────────┘
                          │ allowed only
                          ▼
                   ┌──────────────┐
                   │   Internet   │
                   └──────────────┘
```

## Advanced

For TLS MITM cert management, multi-tenant isolation, gRPC-Web, OTel exporter selection, Helm charts, and library-mode embedding, see [docs/advanced.md](docs/advanced.md).

## Status

Pre-1.0. Core filtering, audit logging, and CONNECT/MITM modes are stable and well-tested. The profile system, `run`/`tail` subcommands, YAML loader, secret redaction, and MCP awareness shipped in v0.2; treat them as new and report rough edges. Library-mode programmatic API is stable; CLI surface may still shift before 1.0.

## License

MIT.
