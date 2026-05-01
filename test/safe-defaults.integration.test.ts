import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createProxyServer, type ProxyServer } from '../src/server.js';
import type { ProxyConfig } from '../src/types/config.js';
import { applySafeDefaults } from '../src/profiles/safe-defaults.js';

describe('Safe defaults — proxy integration', () => {
  let server: ProxyServer;
  let proxyPort: number;

  const config: ProxyConfig = {
    server: {
      host: '127.0.0.1',
      port: 0,
      mode: 'tunnel',
      logging: { level: 'error', console: false },
    },
    allowlist: applySafeDefaults({
      mode: 'strict',
      defaultAction: 'deny',
      rules: [{ id: 'example', domain: 'example.com' }],
    }),
  };

  beforeAll(async () => {
    server = createProxyServer({ config });
    await server.start();
    proxyPort = server.getAddress()?.port ?? 8080;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('blocks CONNECT to the IMDS literal IP', async () => {
    const result = await connect('169.254.169.254:443');
    expect(result.statusCode).toBe(403);
  });

  it('blocks CONNECT to RFC1918', async () => {
    const result = await connect('10.0.0.5:443');
    expect(result.statusCode).toBe(403);
  });

  it('blocks CONNECT to the cloud metadata DNS name', async () => {
    const result = await connect('metadata.google.internal:443');
    expect(result.statusCode).toBe(403);
  });

  it('blocks plain-HTTP forward request to non-allowlisted host', async () => {
    const res = await forward('http://unknown.example.com/');
    expect(res.statusCode).toBe(403);
  });

  it('user-block list overrides any allow rule', async () => {
    // Configure a fresh server with an explicit user block on example.com.
    const blockedServer = createProxyServer({
      config: {
        ...config,
        allowlist: applySafeDefaults({
          mode: 'strict',
          defaultAction: 'deny',
          rules: [{ id: 'example', domain: 'example.com' }],
          block: { domains: ['example.com'] },
        }),
      },
    });
    await blockedServer.start();
    const blockedPort = blockedServer.getAddress()?.port ?? 8080;
    try {
      const result = await connect('example.com:443', blockedPort);
      expect(result.statusCode).toBe(403);
    } finally {
      await blockedServer.stop();
    }
  });

  function connect(
    target: string,
    port: number = proxyPort,
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'CONNECT',
        path: target,
      });

      req.on('connect', (res, socket) => {
        let body = '';
        socket.on('data', (chunk) => (body += chunk.toString()));
        socket.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
        socket.on('close', () => resolve({ statusCode: res.statusCode ?? 0, body }));
      });
      req.on('response', (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
      });
      req.on('error', () => resolve({ statusCode: 0, body: '' }));
      req.end();
    });
  }

  function forward(url: string): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxyPort,
          path: url,
          method: 'GET',
          headers: { Host: parsed.host },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }
});
