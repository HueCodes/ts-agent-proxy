import { describe, it, expect } from 'vitest';
import {
  evaluateMcpRequest,
  extractToolName,
  jsonRpcErrorResponse,
  looksLikeMcp,
  parseJsonRpc,
  type McpPolicy,
} from '../src/filter/mcp-matcher.js';

describe('looksLikeMcp', () => {
  it('matches /mcp paths', () => {
    expect(looksLikeMcp({ path: '/mcp' })).toBe(true);
    expect(looksLikeMcp({ path: '/mcp/sse' })).toBe(true);
  });

  it('matches /sse paths', () => {
    expect(looksLikeMcp({ path: '/sse' })).toBe(true);
  });

  it('matches when content-type is JSON and the body is JSON-RPC 2.0', () => {
    expect(
      looksLikeMcp({
        contentType: 'application/json',
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      }),
    ).toBe(true);
  });

  it('does not match plain JSON without the JSON-RPC marker', () => {
    expect(
      looksLikeMcp({
        contentType: 'application/json',
        body: '{"foo":"bar"}',
      }),
    ).toBe(false);
  });

  it('does not match arbitrary HTTP', () => {
    expect(looksLikeMcp({ path: '/api/users', contentType: 'application/json' })).toBe(false);
  });
});

describe('parseJsonRpc', () => {
  it('parses a single request', () => {
    const got = parseJsonRpc('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    expect(got).not.toBeNull();
    expect(got!.length).toBe(1);
    expect(got![0]!.method).toBe('tools/list');
  });

  it('parses a batch', () => {
    const got = parseJsonRpc(
      '[{"jsonrpc":"2.0","id":1,"method":"a"},{"jsonrpc":"2.0","id":2,"method":"b"}]',
    );
    expect(got!.length).toBe(2);
  });

  it('returns null for malformed JSON', () => {
    expect(parseJsonRpc('not json')).toBeNull();
  });

  it('returns null when jsonrpc != 2.0', () => {
    expect(parseJsonRpc('{"jsonrpc":"1.0","method":"x"}')).toBeNull();
  });

  it('returns null when method is missing', () => {
    expect(parseJsonRpc('{"jsonrpc":"2.0","id":1}')).toBeNull();
  });

  it('preserves notifications (no id)', () => {
    const got = parseJsonRpc('{"jsonrpc":"2.0","method":"notify"}');
    expect(got).not.toBeNull();
    expect(got![0]!.id).toBeUndefined();
  });
});

describe('extractToolName', () => {
  it('returns null for non-tool methods', () => {
    expect(extractToolName({ jsonrpc: '2.0', id: 1, method: 'initialize' })).toBeNull();
  });

  it('returns the tool name for tools/call', () => {
    expect(
      extractToolName({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '/etc/passwd' } },
      }),
    ).toBe('read_file');
  });

  it('returns null when params.name is missing', () => {
    expect(extractToolName({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} })).toBeNull();
  });
});

describe('evaluateMcpRequest', () => {
  const policy: McpPolicy = {
    servers: [
      {
        host: 'mcp.example.com',
        allowTools: ['read_file', 'list_directory'],
        blockTools: ['execute_shell'],
      },
    ],
  };

  it('allows hosts not in the policy to pass through', () => {
    const result = evaluateMcpRequest(
      'unmanaged.example.com',
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file' } },
      policy,
    );
    expect(result.allowed).toBe(true);
  });

  it('allows non-tool methods regardless of policy', () => {
    const result = evaluateMcpRequest(
      'mcp.example.com',
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      policy,
    );
    expect(result.allowed).toBe(true);
  });

  it('allows allowlisted tools', () => {
    const result = evaluateMcpRequest(
      'mcp.example.com',
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file' } },
      policy,
    );
    expect(result.allowed).toBe(true);
    expect(result.tool).toBe('read_file');
  });

  it('blocks tools in the blocklist even when also allowlisted', () => {
    const conflictingPolicy: McpPolicy = {
      servers: [{ host: 'mcp.example.com', allowTools: ['*'], blockTools: ['execute_shell'] }],
    };
    const result = evaluateMcpRequest(
      'mcp.example.com',
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'execute_shell' } },
      conflictingPolicy,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/blocked/i);
  });

  it('denies tools not in the allowlist', () => {
    const result = evaluateMcpRequest(
      'mcp.example.com',
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mystery_tool' } },
      policy,
    );
    expect(result.allowed).toBe(false);
  });

  it('supports glob patterns in allowTools', () => {
    const globPolicy: McpPolicy = {
      servers: [{ host: 'mcp.example.com', allowTools: ['read_*'] }],
    };
    expect(
      evaluateMcpRequest(
        'mcp.example.com',
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file' } },
        globPolicy,
      ).allowed,
    ).toBe(true);
    expect(
      evaluateMcpRequest(
        'mcp.example.com',
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_file' } },
        globPolicy,
      ).allowed,
    ).toBe(false);
  });
});

describe('jsonRpcErrorResponse', () => {
  it('produces a well-formed JSON-RPC error envelope', () => {
    const r = jsonRpcErrorResponse(7, 'Tool blocked by policy');
    expect(r.jsonrpc).toBe('2.0');
    expect(r.id).toBe(7);
    expect(r.error?.message).toBe('Tool blocked by policy');
    expect(r.error?.code).toBeLessThan(0);
  });

  it('uses null id when not provided', () => {
    const r = jsonRpcErrorResponse(undefined, 'oops');
    expect(r.id).toBeNull();
  });
});
