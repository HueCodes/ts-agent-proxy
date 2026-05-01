/**
 * MCP (Model Context Protocol) awareness.
 *
 * MCP is the highest-leverage attack surface an agent has — a malicious or
 * misbehaving MCP server that the user installs gets to run any tool the
 * agent calls. This module gives the proxy first-class understanding of MCP
 * traffic: it parses JSON-RPC envelopes, matches tool calls against an
 * allowlist/blocklist, and produces JSON-RPC error responses for blocked
 * calls so the agent surfaces a meaningful failure.
 *
 * Scope: HTTP+SSE transport only. Stdio is out of scope (no proxy hop).
 */

import picomatch from 'picomatch';

export interface McpServerPolicy {
  /** Hostname the server is reachable at (exact or wildcard). */
  host: string;
  /** Tool names allowed for this server. Default: all not in blockTools. */
  allowTools?: string[] | undefined;
  /** Tool names blocked for this server. Always wins. */
  blockTools?: string[] | undefined;
  /** When true, audit log entries include tool arguments (after redaction). */
  auditArgs?: boolean | undefined;
}

export interface McpPolicy {
  servers: McpServerPolicy[];
}

/**
 * Minimal JSON-RPC 2.0 envelope shape the proxy understands. We don't parse
 * the full spec — only what's needed to decide allow/block.
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type ToolCallParams = { name?: string; arguments?: unknown };

/**
 * Best-effort detection of MCP traffic. Today: Content-Type contains
 * application/json AND the body parses as JSON-RPC 2.0; OR the path looks
 * MCP-shaped (/mcp, /sse). The proxy can also be told "this host is MCP"
 * explicitly via the policy.
 */
export function looksLikeMcp(opts: {
  path?: string | undefined;
  contentType?: string | undefined;
  body?: string | undefined;
}): boolean {
  if (opts.path && /\/(mcp|sse)(\/|$)/i.test(opts.path)) return true;
  if (opts.contentType?.includes('application/json') && opts.body) {
    try {
      const parsed = JSON.parse(opts.body) as { jsonrpc?: unknown };
      if (parsed.jsonrpc === '2.0') return true;
    } catch {
      // Fall through.
    }
  }
  return false;
}

/**
 * Parse a JSON-RPC request envelope. Returns null for unparseable input or
 * shapes that don't match the spec.
 *
 * Batch requests are returned as an array of envelopes; single requests
 * yield a one-element array. Notifications (no id) are kept — callers can
 * filter them out.
 */
export function parseJsonRpc(body: string): JsonRpcRequest[] | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  const arr = Array.isArray(data) ? data : [data];
  const out: JsonRpcRequest[] = [];
  for (const item of arr) {
    if (!isJsonRpcRequest(item)) return null;
    out.push(item);
  }
  return out;
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.jsonrpc !== '2.0') return false;
  if (typeof v.method !== 'string') return false;
  return true;
}

/**
 * For an MCP `tools/call` request, return the tool name (params.name).
 * Returns null for non-tool methods or malformed params.
 */
export function extractToolName(req: JsonRpcRequest): string | null {
  if (req.method !== 'tools/call') return null;
  const params = req.params as ToolCallParams | undefined;
  return typeof params?.name === 'string' ? params.name : null;
}

/**
 * Decide whether a JSON-RPC request should be allowed against an MCP policy.
 * Returns the matched-rule + decision; the caller renders a JSON-RPC error
 * response for denied calls.
 */
export function evaluateMcpRequest(
  host: string,
  request: JsonRpcRequest,
  policy: McpPolicy,
): { allowed: boolean; reason: string; tool: string | null } {
  const server = policy.servers.find((s) => matchHost(s.host, host));
  if (!server) {
    return { allowed: true, reason: 'host not in MCP policy; passing through', tool: null };
  }

  const tool = extractToolName(request);
  if (tool === null) {
    // Non-tool methods (initialize, notifications, etc.) flow through.
    return { allowed: true, reason: `method ${request.method} not gated`, tool: null };
  }

  if (server.blockTools && server.blockTools.some((t) => matchTool(t, tool))) {
    return { allowed: false, reason: `tool ${tool} blocked by policy`, tool };
  }

  if (server.allowTools && server.allowTools.length > 0) {
    const allowed = server.allowTools.some((t) => matchTool(t, tool));
    return {
      allowed,
      reason: allowed ? `tool ${tool} allowed by policy` : `tool ${tool} not in server allowlist`,
      tool,
    };
  }

  // Server in policy but no allowTools => everything except blockTools is allowed.
  return { allowed: true, reason: `tool ${tool} not in blocklist`, tool };
}

function matchHost(pattern: string, host: string): boolean {
  // Reuse picomatch for simple host wildcard support.
  return picomatch(pattern, { nocase: true })(host);
}

function matchTool(pattern: string, tool: string): boolean {
  // Exact match or glob.
  if (pattern === tool) return true;
  return picomatch(pattern)(tool);
}

const JSON_RPC_METHOD_NOT_FOUND = -32601;

/**
 * Build a JSON-RPC error response that surfaces the block reason to the
 * agent. Use the request's id; for batches/notifications, callers may pass
 * null.
 */
export function jsonRpcErrorResponse(
  id: string | number | null | undefined,
  message: string,
  code = JSON_RPC_METHOD_NOT_FOUND,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message },
  };
}
