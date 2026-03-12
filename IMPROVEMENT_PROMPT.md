# ts-agent-proxy: Production Hardening & Improvement Prompt

## Project Context

**ts-agent-proxy** is an HTTP allowlist proxy that filters network requests from AI agents, permitting only explicitly configured domains/paths/methods. It supports tunnel (CONNECT) and MITM inspection modes, gRPC/gRPC-Web, WebSocket proxying, multi-tenant isolation, circuit breakers, connection pooling, rate limiting, OpenTelemetry tracing, Prometheus metrics, audit logging, and an admin API with auth.

**Current State**: ~85% production-ready. Core proxy functionality, filtering, observability, and security features are implemented. What remains is hardening edges, improving test coverage, adding operational tooling, and filling gaps for enterprise deployment.

**Tech Stack**: TypeScript 5.7 (strict, ESM), Node.js 20+, Vitest, Pino, Zod, prom-client, OpenTelemetry, node-forge, Docker (Alpine multi-stage).

---

## Autonomy & Approval Guidelines

You have full autonomy to proceed without asking for approval on the following:

### Proceed Without Approval
- **Bug fixes**: Fix any bugs you discover while working — broken logic, incorrect types, missing error handling, off-by-one errors, resource leaks, race conditions.
- **Code quality**: Fix lint issues, add missing types, remove dead code, fix import ordering, improve variable names for clarity.
- **Test improvements**: Add missing unit tests, fix flaky tests, improve test assertions, add edge case coverage, increase test coverage toward 90%+.
- **Security fixes**: Fix any vulnerabilities you find — injection risks, missing input validation, unsafe defaults, missing sanitization, improper error exposure.
- **Performance fixes**: Fix obvious performance issues — unnecessary allocations in hot paths, missing cleanup/disposal, inefficient algorithms where a better one is straightforward.
- **Documentation in code**: Add/fix JSDoc for public APIs, fix misleading comments, remove outdated comments.
- **Config/build fixes**: Fix tsconfig issues, fix CI pipeline problems, fix Dockerfile issues, fix package.json scripts.
- **Refactoring within a file**: Extract private helpers, simplify complex conditionals, reduce nesting — as long as the public API doesn't change.

### Ask Before Proceeding
- **New dependencies**: Adding any new npm package (even devDependencies). State the package, why it's needed, and what alternatives you considered.
- **Architecture changes**: Changing module boundaries, splitting/merging files across directories, changing the plugin/extension model, altering the request processing pipeline order.
- **Breaking API changes**: Changing the public TypeScript API surface (exported types, function signatures, class interfaces), CLI argument changes, config schema changes that aren't backward-compatible.
- **New features not listed below**: If you identify a feature gap not covered in this prompt, propose it before implementing.
- **Removing existing functionality**: Even if it seems unused, confirm before deleting a feature or exported symbol.
- **Infrastructure changes**: Changing CI/CD pipeline behavior, Docker base images, Node.js version requirements, or deployment topology.
- **Large refactors**: Changes touching 10+ files or fundamentally restructuring a subsystem.

**When in doubt**: Bias toward acting. If the change is < 50 lines, clearly correct, and doesn't affect public API — just do it. Mention what you did in your summary.

---

## Objective

Bring ts-agent-proxy to full production readiness. Every change should make the proxy more reliable, secure, performant, or operable in real-world deployments. Do not add complexity for its own sake. Every feature must earn its place.

---

## Phase 1: Code Quality & Developer Experience

### 1.1 ESLint & Prettier Configuration

**Problem**: ESLint is referenced in npm scripts and CI but no configuration files exist. Code style is inconsistent.

**Required**:
- Add `.eslintrc.cjs` (or `eslint.config.js` flat config) with:
  - `@typescript-eslint/recommended` and `@typescript-eslint/strict` rulesets
  - No-unused-vars (error), no-explicit-any (warn), consistent-return, eqeqeq
  - Import ordering rules
- Add `.prettierrc` with: single quotes, 2-space indent, 100 char print width, trailing commas
- Add `.prettierignore` and `.eslintignore` (dist, node_modules, coverage)
- Run formatter/linter across entire codebase and fix all issues
- Ensure `npm run lint` passes in CI

### 1.2 Pre-commit Hooks

**Required**:
- Add `husky` + `lint-staged` for pre-commit linting/formatting
- Staged files only: run prettier, then eslint --fix, then type-check affected files
- Add to `package.json` scripts

### 1.3 Strengthen TypeScript Strictness

**Required**:
- Audit for any `as` casts or `@ts-ignore` comments — eliminate or justify each one
- Ensure `noUncheckedIndexedAccess: true` is enabled in tsconfig
- Ensure `exactOptionalPropertyTypes: true` is enabled
- Fix all resulting type errors (these will surface real bugs)

---

## Phase 2: Testing & Reliability

### 2.1 Increase Unit Test Coverage to 90%+

**Current State**: ~42% coverage ratio (6,090 LOC tests vs 14,472 LOC source). 23 unit test files.

**Required**:
- Run `npm test -- --coverage` and identify all files below 80% coverage
- Prioritize coverage for:
  - `src/server.ts` — the main orchestrator, critical paths
  - `src/proxy/forward-proxy.ts` — core proxy logic
  - `src/proxy/connect-handler.ts` — tunnel mode
  - `src/proxy/mitm/interceptor.ts` — MITM inspection
  - `src/proxy/mitm/cert-manager.ts` — certificate generation
  - `src/proxy/grpc-handler.ts` — gRPC proxying
  - `src/proxy/grpc-web-handler.ts` — gRPC-Web proxying
  - `src/proxy/websocket-handler.ts` — WebSocket upgrades
  - `src/config/watcher.ts` — config hot reload
  - `src/admin/rules-api.ts` — dynamic rule management
  - `src/admin/admin-server.ts` — admin endpoints
  - `src/validation/validator.ts` — config validation
  - `src/telemetry/tracing.ts` — OpenTelemetry setup
- Every test should test behavior, not implementation details
- Include edge cases: malformed input, empty input, boundary values, unicode, very large inputs
- Test error paths and failure modes, not just happy paths
- Mock external I/O (network, filesystem) but test real logic

### 2.2 Expand Integration Tests

**Current State**: Single `server.integration.test.ts` file.

**Required**:
- Test full request lifecycle for each proxy mode:
  - HTTP forward proxy (allowed, denied, rate-limited, size-limited)
  - HTTPS tunnel mode (allowed domain, denied domain, timeout)
  - MITM mode (path filtering, method filtering, header transformation, body transformation)
  - gRPC proxying (allowed service/method, denied, streaming)
  - WebSocket upgrade (allowed, denied, message forwarding)
- Test admin API:
  - Health/ready endpoints (unauthenticated)
  - Metrics endpoint (authenticated)
  - Rules CRUD API (authenticated, validation errors, concurrent updates)
  - Config reload
- Test operational scenarios:
  - Graceful shutdown (in-flight requests complete, new requests rejected)
  - Config hot-reload (rules update without restart)
  - Circuit breaker tripping and recovery
  - Connection pool exhaustion and recovery
  - Rate limit enforcement across concurrent requests
- Test security scenarios:
  - Request smuggling attempts
  - Header injection attempts
  - Oversized requests rejected
  - Malformed HTTP rejected
  - Admin API without auth rejected
- Use `30_000ms` timeout for integration tests (already configured)
- Each test should clean up after itself (no leaked servers, sockets, timers)

### 2.3 Add Performance Benchmarks

**Required**:
- Create `benchmark/` directory with Vitest bench files:
  - `benchmark/throughput.bench.ts` — requests/second for tunnel and MITM modes
  - `benchmark/matcher.bench.ts` — allowlist matching performance with 10, 100, 1000 rules
  - `benchmark/latency.bench.ts` — p50/p95/p99 latency distribution
- Add `npm run bench` script to `package.json`
- Document baseline numbers in benchmark output
- Target: 10,000+ req/s tunnel mode, 1,000+ req/s MITM mode, < 1ms matcher lookup for 1000 rules

### 2.4 Error Handling Audit

**Required**:
- Audit every `try/catch` block — ensure errors are logged with context, not swallowed
- Ensure all async operations have proper error handling (no unhandled promise rejections)
- Ensure `server.ts` has a top-level `process.on('unhandledRejection')` and `process.on('uncaughtException')` handler that logs and exits with code 1
- Ensure all socket/stream error handlers are attached before any I/O
- Ensure cleanup runs in `finally` blocks (not just in the happy path)
- Ensure error responses to clients never leak internal details (stack traces, file paths, config)

---

## Phase 3: Security Hardening

### 3.1 Input Validation Hardening

**Required**:
- Audit all Zod schemas — ensure they have:
  - `max()` bounds on all strings and arrays
  - `int()` and `min(0)` on all numeric fields
  - `url()` or custom regex on any URL/domain fields
  - `.strict()` on all object schemas (reject unknown keys)
- Validate all incoming HTTP headers in MITM mode before forwarding
- Validate all admin API request bodies with Zod before processing
- Ensure no user-controlled input reaches `eval`, `Function()`, `child_process`, or template literals used in shell commands
- Ensure log messages don't include raw user input that could exploit log injection (newlines, ANSI codes)

### 3.2 TLS & Certificate Security

**Required**:
- Ensure MITM CA key is generated with RSA 2048+ or ECDSA P-256+
- Ensure generated leaf certificates have:
  - Proper validity period (not excessively long — max 1 year)
  - Correct SAN (Subject Alternative Name) entries
  - Proper key usage extensions
- Ensure CA key material is protected (file permissions 0600 if written to disk)
- Add option to load CA cert/key from environment variables (for container secrets)
- Ensure TLS connections to upstream use system CA store by default (no `rejectUnauthorized: false` unless explicitly configured)

### 3.3 Rate Limiting Hardening

**Required**:
- Ensure rate limiter cannot be bypassed via:
  - IP spoofing (X-Forwarded-For when proxy is not behind a trusted load balancer)
  - Connection reuse (rate limit per client identity, not per connection)
  - Request pipelining
- Add global rate limit (not just per-rule) as a safety net
- Ensure rate limit state cleanup doesn't leak memory over time
- Add rate limit response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

### 3.4 Dependency Security

**Required**:
- Run `npm audit` and fix all high/critical vulnerabilities
- Review all production dependencies for:
  - Active maintenance (last commit within 6 months)
  - No known CVEs
  - Appropriate license (MIT, Apache 2.0, BSD)
- Add `npm audit` to CI pipeline (fail on high/critical)
- Consider pinning dependency versions (exact versions in package.json) for reproducible builds

---

## Phase 4: Operational Readiness

### 4.1 Graceful Shutdown

**Required**:
- On SIGTERM/SIGINT:
  1. Stop accepting new connections immediately
  2. Set health endpoint to return 503 (so load balancer stops sending traffic)
  3. Wait for in-flight requests to complete (with configurable timeout, default 30s)
  4. Close all idle connections in connection pool
  5. Flush metrics and audit logs
  6. Close admin server
  7. Exit with code 0
- If shutdown timeout expires, force-close remaining connections and exit with code 1
- Log shutdown progress at each step
- Ensure no resource leaks on shutdown (timers, file handles, sockets)

### 4.2 Configuration Validation CLI

**Required**:
- Add `ts-agent-proxy validate <config-file>` subcommand
- Output: validation result (pass/fail), detailed error messages with JSON path to invalid field
- Add `--dry-run` flag: load config, build matchers, test against sample requests (from stdin or `--test-request` flag)
- Exit code 0 on valid, 1 on invalid
- Run validation on startup before binding any ports

### 4.3 Startup Validation & Diagnostics

**Required**:
- On startup, log:
  - Version, Node.js version, platform
  - Loaded configuration summary (number of rules, mode, ports, enabled features)
  - Listening addresses
  - CA certificate fingerprint (MITM mode)
- Validate all configuration before starting:
  - Allowlist rules parse correctly
  - Ports are available
  - CA cert/key are valid (MITM mode)
  - Admin auth is configured if admin is enabled on non-localhost
- Fail fast with clear error message if validation fails

### 4.4 Kubernetes Readiness

**Required**:
- `/health` — always returns 200 if process is alive (liveness probe)
- `/ready` — returns 200 only when:
  - Allowlist is loaded and parsed
  - Admin server is bound
  - Proxy server is bound and accepting connections
  - (MITM mode) CA certificate is loaded
- Returns 503 during startup and during graceful shutdown
- Add `startupProbe` documentation (for slow-starting instances)

### 4.5 Docker Compose for Local Development

**Required**:
- Create `docker-compose.yml` with:
  - `proxy` service (the agent proxy)
  - `prometheus` service (scraping proxy metrics)
  - `grafana` service (pre-configured dashboard for proxy metrics)
  - `jaeger` service (receiving traces from proxy)
- Create `monitoring/grafana-dashboard.json` with panels for:
  - Request rate by status code
  - Latency percentiles
  - Active connections
  - Rate limit hits
  - Circuit breaker state
  - Error rate
- Create `monitoring/prometheus.yml` with scrape config for the proxy
- Add `npm run dev:stack` script to start everything

### 4.6 Helm Chart

**Required**:
- Create `helm/ts-agent-proxy/` with:
  - `Chart.yaml`, `values.yaml`
  - Templates: Deployment, Service, ConfigMap (allowlist), Secret (CA cert, admin token), ServiceAccount, HPA, PDB, NetworkPolicy
- Default values should be secure and production-appropriate
- Support both `ClusterIP` and `LoadBalancer` service types
- Include `ServiceMonitor` for Prometheus Operator integration
- Include notes.txt with post-install instructions

---

## Phase 5: Remaining Feature Gaps

### 5.1 Redis Backend for Rate Limiting

**Current**: Memory-only rate limiting (not suitable for multi-instance deployment).

**Required**:
- Add optional `ioredis` as a peer dependency
- Add `rateLimit.backend: 'memory' | 'redis'` config option
- Add `rateLimit.redis.url` config option
- Use `rate-limiter-flexible` Redis store when configured
- Fallback to memory if Redis is unavailable (with warning log)
- Add Redis connection health to `/ready` endpoint when configured

### 5.2 Request/Response Compression

**Required**:
- Support `Accept-Encoding: gzip, br` for admin API responses
- In MITM mode, properly handle compressed request/response bodies:
  - Decompress for inspection/transformation
  - Re-compress before forwarding (preserving original encoding)
- Don't double-compress already-compressed content

### 5.3 Structured Error Responses

**Required**:
- All proxy error responses (403, 413, 429, 502, 503, 504) should return JSON:
  ```json
  {
    "error": "DOMAIN_NOT_ALLOWED",
    "message": "Request to api.example.com is not permitted by the allowlist",
    "requestId": "req_abc123"
  }
  ```
- Error codes should be documented and stable (not just HTTP status codes)
- Include `Retry-After` header on 429 responses
- Include `X-Request-Id` header on all responses

### 5.4 Connection Draining for Config Reload

**Current**: Config reload is immediate, which could disrupt in-flight requests.

**Required**:
- When config reloads:
  1. New rules apply to new requests immediately
  2. In-flight requests complete with the rules they started with
  3. Log the reload event with old/new rule counts
- Add `/api/config/reload` admin endpoint (POST, authenticated)
- Add config reload metrics (count, last reload time, last reload status)

---

## Phase 6: Documentation & Operational Guides

### 6.1 Architecture Documentation

**Required** (create `docs/architecture.md`):
- High-level architecture diagram (ASCII art or mermaid)
- Request flow diagrams for each proxy mode (tunnel, MITM, gRPC)
- Module dependency diagram
- Data flow: how a request moves through the filter chain
- Extension points: where custom logic can be added

### 6.2 Operations Runbook

**Required** (create `docs/operations.md`):
- Deployment checklist (pre-deploy, deploy, post-deploy verification)
- Common operational tasks:
  - Adding a new allowlist rule
  - Rotating the MITM CA certificate
  - Investigating blocked requests (audit log queries)
  - Scaling horizontally
  - Debugging high latency
- Alert definitions: what to alert on, severity levels, runbook links
- Incident response: what to do when the proxy is unhealthy

### 6.3 Security Hardening Guide

**Required** (create `docs/security.md`):
- Threat model: what the proxy protects against, what it doesn't
- Recommended configuration for security-sensitive deployments
- Network architecture: where to place the proxy, firewall rules
- TLS configuration best practices
- Admin API security configuration
- Audit log retention and analysis

---

## Implementation Notes

### General Principles
- **No premature abstraction**: Don't build plugin systems or extension points unless there's a concrete second use case.
- **Fail fast, fail loud**: Prefer crashing on startup with a clear error over silently degrading at runtime.
- **Backward compatibility**: Existing `allowlist.json` files and CLI arguments must continue to work. New config fields must have sensible defaults.
- **Minimal dependencies**: Before adding a new package, consider if the functionality can be achieved with Node.js built-ins or existing dependencies in < 100 lines.
- **Test-driven**: Write the test first when fixing bugs. Write tests alongside new features.

### Code Style
- Use `async/await` over raw promises or callbacks
- Prefer `const` over `let`, never use `var`
- Use early returns to reduce nesting
- Keep functions under 50 lines where practical
- Name things descriptively — avoid abbreviations except well-known ones (req, res, ctx, config)

### Commit Style
- One logical change per commit
- Format: `<type>: <description>` (feat, fix, refactor, test, docs, chore)
- Include the "why" in the commit body if not obvious from the diff

---

## Success Criteria

When complete, the proxy should:

- [ ] Pass `npm run lint` with zero warnings
- [ ] Have >90% test coverage across all source files
- [ ] Have integration tests for every proxy mode and admin endpoint
- [ ] Handle 10,000+ req/s tunnel mode, 1,000+ req/s MITM mode (benchmarked)
- [ ] Gracefully shut down within 30s preserving in-flight requests
- [ ] Start up in <2s with clear diagnostic output
- [ ] Fail startup with clear errors for all invalid configurations
- [ ] Have zero `npm audit` high/critical vulnerabilities
- [ ] Run in Docker with <150MB image size
- [ ] Deploy to Kubernetes via Helm chart with HPA, PDB, health probes
- [ ] Export Prometheus metrics and OpenTelemetry traces
- [ ] Include operational documentation sufficient for on-call engineers
- [ ] All error responses are structured JSON with stable error codes
