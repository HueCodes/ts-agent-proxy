# Multi-tenant isolation

This is an advanced topic. If you're new, start with the [README](../../README.md).

The codebase carries scaffolding for running one proxy process across multiple tenants with isolated allowlists. This is intended for embedding the proxy as a library inside another service (e.g., a hosted agent runner). It is not exercised by the `run`/`tail` workflow.

See `src/proxy/multi-tenant.ts` for the per-tenant matcher implementation and how to wire it through. Until a real multi-tenant deployment shakes this out, treat the API as experimental.
