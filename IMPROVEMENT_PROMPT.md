# ts-agent-proxy: Production Hardening Prompt

You are the engineer driving `ts-agent-proxy` to production readiness. This document is your standing brief: what to build, how to decide, and how to operate. Read it once, then go.

---

## 1. Mission

`ts-agent-proxy` is an HTTP allowlist proxy that filters network traffic from AI agents. Only explicitly permitted domains, paths, and methods get through. It supports tunnel (CONNECT) and MITM modes, gRPC + gRPC-Web, WebSocket upgrades, multi-tenant isolation, circuit breakers, connection pooling, rate limiting, OpenTelemetry tracing, Prometheus metrics, structured audit logs, and an authenticated admin API.

The codebase is roughly 85% there. Core functionality works. The remaining work is hardening, coverage, ops surface area, and a few feature gaps. Your job is to close that 15% without bloating the project.

**Tech stack**: TypeScript 5.7 (strict, ESM), Node 20+, Vitest, Pino, Zod, prom-client, OpenTelemetry, node-forge, Docker (Alpine multi-stage). Existing infra: `monitoring/` (Prometheus + Grafana), `docker-compose.yml`, `.github/workflows/`, ESLint + Prettier configs already present.

---

## 2. How to operate

This is the most important section. Read it carefully.

### 2.1 Default to action

If a change is **clearly correct**, **doesn't change the public API**, and **is reversible by `git revert`**, just ship it. Do not ask. Do not write a proposal. Do the work, run the tests, move on.

This applies to:

- Bug fixes of any size — broken logic, type errors, race conditions, resource leaks, missing cleanup, wrong status codes, off-by-one errors, swallowed errors, leaked file descriptors or sockets.
- Test additions and fixes — new unit tests, new integration tests, fixing flakes, expanding edge case coverage, replacing implementation-detail tests with behavior tests.
- Lint, format, type strictness — fix every warning. Eliminate `any`, `as` casts, `@ts-ignore`. Turn on `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` and fix the fallout.
- Internal refactors — extracting helpers, simplifying conditionals, reducing nesting, renaming locals — as long as the exported surface doesn't move.
- Security fixes — input validation gaps, log injection, header injection, missing bounds on Zod schemas, unsafe defaults, leaked stack traces in error responses.
- Performance fixes when the win is obvious and the change is local.
- Comment hygiene — remove stale comments, fix wrong ones, add a one-liner only when the *why* is non-obvious.
- Config, build, CI — fix tsconfig, fix Dockerfile bugs, fix broken workflow steps, fix package.json scripts.

If you find five of these in one session, fix all five. Don't batch them into a proposal.

### 2.2 Surface, don't ask

For these, **do the work** and **mention it in your end-of-turn summary**. No mid-flight check-in.

- Adding a new test file or new docs file under `docs/`.
- Adding a new private module that isn't exported.
- Tightening a Zod schema (adding `.max()`, `.strict()`, etc.) even if it could in principle reject formerly-accepted input — log the change.
- Adding observability (new metrics, new spans, new log fields) so long as cardinality is bounded.
- Adding a new CLI subcommand or `--flag` that is purely additive.

### 2.3 Stop and ask

These are the only things worth interrupting for. Be specific in the question — name the package, the file, the API.

- **New runtime dependency.** State the package, why a built-in or existing dep can't do it, and what you considered. (DevDependencies for tooling: just add them, mention it.)
- **Public API breakage** — exported types, function signatures, CLI args, or config schema changes that aren't backward-compatible.
- **Removing a feature or exported symbol**, even if it looks unused. Confirm first.
- **Architecture changes** — pipeline reordering, module boundary moves, plugin-system style abstractions.
- **Infra changes** — Node version bump, Docker base image change, CI behavior change beyond fixing a bug, deployment topology.
- **Refactors touching 10+ files** or fundamentally restructuring a subsystem.
- **Anything that touches a real external system** — pushing to a remote, opening a PR, posting to Slack/email, hitting a third-party API with credentials. Always ask. (Per standing rule: never take public/external actions without explicit approval.)

### 2.4 The heuristic, when in doubt

Ask: *if I shipped this and the user disagreed, how hard would it be to undo?* If the answer is `git revert`, ship it. If the answer involves coordinating with anyone or rewriting something downstream, ask first.

A second heuristic: *would a senior engineer on this codebase pause to ask, or would they just commit?* Match that.

### 2.5 Communication

- **At the start of a work block**: one sentence — what you're tackling and why now. Not a plan document.
- **While working**: short status updates only at meaningful moments (found something, changed direction, hit a real blocker). Don't narrate routine tool calls.
- **At the end**: one or two sentences — what changed, what's verified (tests pass / lint clean / coverage delta), what's next. No emojis. No section headers for a one-shot fix. No restating the diff.
- **Never**: invent a "Phase 1.2.3" structure for a small task; write a multi-paragraph summary; ask "should I also...?" if the answer is in section 2.1.

### 2.6 Verification before declaring done

For any non-trivial change:

1. `npm run typecheck` — clean.
2. `npm run lint` — zero warnings.
3. `npm test` — all green.
4. For changes touching the request path: `npm run test:integration` — all green.
5. If you changed startup, shutdown, or config loading: actually start the proxy locally and exercise the change. Don't claim "should work" — verify it.

If a test fails, do not skip it, mark it `.skip`, or comment it out to make CI green. Find the root cause. If the root cause is genuinely a flaky test (timing, ordering, resource contention) and not a real bug, fix the flakiness — don't paper over it.

---

## 3. Project context (current reality)

Source layout (`src/`):

- `server.ts` — top-level orchestrator, lifecycle.
- `proxy/` — `forward-proxy`, `connect-handler`, `mitm/`, `grpc-handler`, `grpc-web-handler`, `grpc-parser`, `websocket-handler`, `body-transformer`, `connection-pool`, `circuit-breaker`, `multi-tenant`, `size-limiter`, `http-parser`.
- `filter/` — `allowlist-matcher`, `domain-matcher`, `domain-trie`, `ip-matcher`, `grpc-matcher`, `rate-limiter`, `connection-limiter`.
- `admin/` — `admin-server`, `auth`, `rules-api`, `metrics`, `prometheus-metrics`.
- `config/` — loader + watcher.
- `logging/`, `telemetry/`, `transform/`, `validation/`, `errors.ts`, `utils/`, `types/`, `integration/`.

Tests live in `test/` (unit) with a separate `vitest.integration.config.ts` for integration. Coverage is roughly 42% by LOC ratio — the priority files for coverage are listed in §5.2.

Already in the repo: `eslint.config.js`, `.prettierrc`, `Dockerfile`, `docker-compose.yml`, `monitoring/prometheus.yml`, `monitoring/grafana/`, GitHub workflow under `.github/workflows/`. **Not yet** in the repo: `helm/`, `benchmark/`, `docs/`, pre-commit hooks, a `validate` CLI subcommand.

---

## 4. Working agreements

- **Backward compatibility**: existing `allowlist.json` files and CLI arguments must keep working. New config fields need sensible defaults.
- **Dependencies**: prefer Node built-ins. Before adding a runtime dep, check whether existing deps cover it. Pin transitive concerns via `npm audit`. Devtool deps are cheaper — still mention.
- **Code style**: `async`/`await` over raw promises. `const` always. Early returns over nested branches. Descriptive names — `req`/`res`/`ctx` are fine; one-letter locals usually aren't.
- **Comments**: default to none. Add a single line only when the *why* is non-obvious — a hidden invariant, a workaround, a subtle constraint. Never describe what the code does.
- **Commits**: one logical change per commit. Format `<type>: <description>` (feat/fix/refactor/test/docs/chore). Why-in-the-body only when the diff doesn't tell the story. **No emojis. Short.** (Per user preference.)
- **No public actions without approval.** Don't push, don't open PRs, don't hit external services. Local commits are fine; remote operations are not.

---

## 5. Workstreams

Ordered by impact and dependency. Within a workstream, work the items in order — but cross between workstreams freely if blocked or if a small win is obvious.

### P0 — Correctness, safety, and the test floor

**5.1 Type and lint cleanliness.** Run `npm run lint` and `npm run typecheck`. Zero warnings, zero errors. Audit every `as` cast and every `@ts-ignore` — eliminate or annotate with a one-line justification. Turn on `noUncheckedIndexedAccess: true` and `exactOptionalPropertyTypes: true` in `tsconfig.json` and fix the fallout — these flags surface real bugs.

**5.2 Coverage to 90% on critical paths.** Run `npm test -- --coverage`. Bring these files to 90%+:

- `src/server.ts`
- `src/proxy/forward-proxy.ts`, `connect-handler.ts`, `grpc-handler.ts`, `grpc-web-handler.ts`, `websocket-handler.ts`
- `src/proxy/mitm/interceptor.ts`, `mitm/cert-manager.ts`
- `src/config/watcher.ts`
- `src/admin/admin-server.ts`, `admin/rules-api.ts`
- `src/validation/validator.ts`
- `src/telemetry/tracing.ts`

Test behavior, not implementation. Cover failure modes, malformed input, empty input, boundary values, unicode, oversized inputs. Mock external I/O; test real logic.

**5.3 Integration test expansion.** Today there's one `server.integration.test.ts`. Split into per-mode files and cover:

- Forward HTTP: allowed, denied, rate-limited, size-limited, timeout.
- Tunnel HTTPS: allowed domain, denied domain, upstream timeout, client abort.
- MITM: path filter, method filter, header transform, body transform, oversized body, invalid TLS.
- gRPC and gRPC-Web: allowed service/method, denied, streaming.
- WebSocket: upgrade allowed, upgrade denied, message forwarding, peer-initiated close.
- Admin API: health/ready unauthenticated, metrics/rules authenticated, rules CRUD validation, concurrent updates, config reload.
- Operational: graceful shutdown with in-flight requests, hot reload, circuit breaker trip + recovery, pool exhaustion + recovery, rate limit under concurrency.
- Security: request smuggling, header injection, oversized request rejection, malformed HTTP, admin without auth.

Each test cleans up — no leaked servers, sockets, timers, files. Use the existing 30s integration timeout.

**5.4 Error handling audit.** Walk every `try/catch`. Errors are logged with context, never swallowed. Every async path has rejection handling. `server.ts` installs `unhandledRejection` and `uncaughtException` handlers that log and exit 1. Socket and stream error handlers are attached *before* I/O begins. Cleanup runs in `finally`, not just the happy path. Error responses never leak stack traces, file paths, or config values to clients.

**5.5 Pre-commit hooks.** Add `husky` + `lint-staged`. Staged files run prettier → eslint --fix → typecheck. Add the npm scripts. Devtool dep — proceed without asking.

### P1 — Operational readiness

**5.6 Graceful shutdown.** On SIGTERM/SIGINT:

1. Stop accepting new connections.
2. Flip `/ready` to 503.
3. Wait for in-flight requests up to a configurable timeout (default 30s).
4. Drain idle pool connections.
5. Flush metrics and audit logs.
6. Close the admin server.
7. Exit 0.

If the timeout elapses, force-close and exit 1. Log progress at each step. No leaked timers, handles, or sockets.

**5.7 Startup validation and diagnostics.** On boot, log version, Node version, platform, config summary (rule count, mode, ports, enabled features), bound addresses, and (MITM) CA fingerprint. Validate everything *before* binding ports: rules parse, ports free, CA cert/key valid in MITM mode, admin auth set when admin binds non-localhost. Fail fast with a precise error message.

**5.8 `validate` CLI subcommand.** `ts-agent-proxy validate <config-file>` — exit 0 on valid, 1 with JSON-pathed errors on invalid. `--dry-run` flag: load config, build matchers, evaluate sample requests from stdin or `--test-request`. Wire validation into startup.

**5.9 Kubernetes probes.** `/health` always 200 if the process is alive. `/ready` 200 only when allowlist loaded, admin bound, proxy bound and accepting, CA loaded (MITM). 503 during startup and shutdown. Document a `startupProbe` recipe.

**5.10 Connection draining on config reload.** Reload behavior:

- New rules apply to new requests immediately.
- In-flight requests finish under their original ruleset.
- Log the reload with old/new rule counts and timestamps.
- Add `POST /api/config/reload` (authenticated) on the admin server.
- Metrics: reload count, last reload time, last reload status.

**5.11 Structured error responses.** Every proxy error (403, 413, 429, 502, 503, 504) returns JSON with stable `error` codes, a human `message`, and a `requestId`. `Retry-After` on 429. `X-Request-Id` on every response. Document the error codes.

**5.12 Local dev stack.** `docker-compose.yml` already exists — verify it brings up proxy + Prometheus + Grafana + Jaeger. Ensure `monitoring/grafana/` has a dashboard with: request rate by status, latency p50/p95/p99, active connections, rate limit hits, circuit breaker state, error rate. `npm run dev:stack` is wired — confirm it works end-to-end.

**5.13 Helm chart.** Create `helm/ts-agent-proxy/` with `Chart.yaml`, `values.yaml`, and templates for Deployment, Service, ConfigMap (allowlist), Secret (CA, admin token), ServiceAccount, HPA, PDB, NetworkPolicy, ServiceMonitor. Defaults must be production-safe. Support ClusterIP and LoadBalancer service types. Include a post-install `notes.txt`.

### P2 — Security hardening

**5.14 Input validation.** Every Zod schema gets `.max()` on strings/arrays, `int()`/`min(0)` on numerics, `url()` or regex on URL/domain fields, and `.strict()` on objects. Validate MITM-mode headers before forwarding. Validate every admin API body. No user input ever reaches `eval`, `Function`, `child_process`, or shell-bound template literals. No raw user input in log lines without escaping (newlines, ANSI).

**5.15 TLS and certificates.** MITM CA: RSA 2048+ or ECDSA P-256+. Generated leaf certs: max 1-year validity, correct SAN entries, proper key usage. CA key on disk: 0600 permissions. Support loading CA cert/key from env vars (for K8s secrets). Upstream TLS uses the system CA store; never `rejectUnauthorized: false` unless explicitly opt-in.

**5.16 Rate limiting hardening.** Cannot be bypassed by spoofed `X-Forwarded-For` (only honor it behind a configured trusted proxy), connection reuse (limit per identity, not per socket), or pipelining. Add a global rate limit as a backstop. Cleanup must not leak memory. Emit `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers.

**5.17 Dependency hygiene.** `npm audit` clean on high/critical. Every prod dep: maintained within 6 months, no known CVEs, MIT/Apache/BSD-class license. Add `npm audit --audit-level=high` to CI. Consider exact version pins for reproducibility.

### P3 — Feature gaps

**5.18 Redis-backed rate limiting.** Add `ioredis` as a peer dep. Config: `rateLimit.backend: 'memory' | 'redis'`, `rateLimit.redis.url`. Use `rate-limiter-flexible`'s Redis store. Fallback to memory with a warning log if Redis is unavailable. Surface Redis health on `/ready` when configured. (Peer dep, not runtime — proceed; mention.)

**5.19 Compression handling.** Honor `Accept-Encoding: gzip, br` on admin responses. In MITM mode: decompress for inspection/transformation, recompress before forwarding while preserving the original encoding. Never double-compress already-compressed content.

**5.20 Performance benchmarks.** Create `benchmark/` with Vitest bench files: throughput (tunnel + MITM), matcher lookup at 10/100/1000 rules, latency p50/p95/p99. Add `npm run bench`. Capture baselines in the output. Targets: 10k+ req/s tunnel, 1k+ req/s MITM, sub-millisecond matcher lookup at 1000 rules.

### P4 — Documentation

Only after P0 and P1 are mostly done.

- `docs/architecture.md` — high-level diagram, request flow per mode, module dependencies, filter chain data flow, extension points.
- `docs/operations.md` — deployment checklist, common ops tasks (adding rules, rotating CA, investigating blocks, scaling, debugging latency), alert definitions, incident response.
- `docs/security.md` — threat model (what the proxy does and does not protect against), recommended config for sensitive deployments, network placement, TLS guidance, admin API hardening, audit retention.

---

## 6. Definition of done

The project is done when all of the following are true:

- `npm run lint` — zero warnings.
- `npm run typecheck` — clean, no `as` casts or `@ts-ignore` left without justification.
- `npm test -- --coverage` — overall ≥ 90% on critical-path files (§5.2).
- `npm run test:integration` — covers every mode and every admin endpoint listed in §5.3.
- `npm run bench` — baselines committed; targets in §5.20 met or documented as deferred with a reason.
- Graceful shutdown drains in-flight requests within 30s and exits 0; force-close exits 1.
- Cold start completes in under 2s with diagnostic output identifying version, config summary, and bind addresses.
- Every invalid configuration fails startup with a precise message — no silent degradation.
- `npm audit` — zero high or critical.
- Docker image under 150MB.
- Helm chart deploys cleanly with HPA, PDB, and probes wired.
- Prometheus metrics and OTel traces export end-to-end through the dev stack.
- All proxy error responses are structured JSON with stable error codes.
- `docs/architecture.md`, `docs/operations.md`, `docs/security.md` exist and are accurate.

When you believe an item is done, verify it with the actual command — don't claim it from memory.

---

## 7. Final notes

Every change must make the proxy more reliable, more secure, more performant, or more operable. If a proposed change does none of those things, drop it.

No premature abstraction. No plugin system without a concrete second use case. No backwards-compat shims for code that hasn't shipped. No half-finished implementations — if you start it, finish it or revert it.

Start with §5.1 and §5.4 in parallel — type/lint cleanliness and the error-handling audit will surface real bugs that change what later work needs to do. Then move to coverage. Operational readiness and security follow naturally.

Now go.
