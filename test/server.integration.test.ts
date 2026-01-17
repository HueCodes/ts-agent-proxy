import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import { createProxyServer, type ProxyServer } from '../src/server.js';
import type { ProxyConfig } from '../src/types/config.js';

describe('ProxyServer Integration', () => {
  let server: ProxyServer;
  let proxyPort: number;

  const testConfig: ProxyConfig = {
    server: {
      host: '127.0.0.1',
      port: 0, // Dynamic port
      mode: 'tunnel',
      logging: {
        level: 'error', // Quiet for tests
        console: false,
      },
    },
    allowlist: {
      mode: 'strict',
      defaultAction: 'deny',
      rules: [
        {
          id: 'httpbin',
          domain: 'httpbin.org',
          paths: ['/**'],
          methods: ['GET', 'POST'],
        },
        {
          id: 'example',
          domain: 'example.com',
          paths: ['/**'],
          methods: ['GET'],
        },
      ],
    },
  };

  beforeAll(async () => {
    server = createProxyServer({ config: testConfig });
    await server.start();
    const addr = server.getAddress();
    proxyPort = addr?.port ?? 8080;
  });

  afterAll(async () => {
    await server.stop();
  });

  describe('HTTP forwarding', () => {
    it('should forward allowed HTTP requests', async () => {
      const response = await makeProxyRequest('http://example.com/', 'GET', proxyPort);
      // example.com should return 200
      expect(response.statusCode).toBe(200);
    });

    it('should block denied HTTP requests', async () => {
      const response = await makeProxyRequest('http://evil.com/', 'GET', proxyPort);
      expect(response.statusCode).toBe(403);
    });
  });

  describe('CONNECT tunneling', () => {
    it('should allow CONNECT to allowed domains', async () => {
      const result = await makeConnectRequest('example.com:443', proxyPort);
      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
    });

    it('should deny CONNECT to blocked domains', async () => {
      const result = await makeConnectRequest('blocked.example.org:443', proxyPort);
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(403);
    });
  });
});

/**
 * Make an HTTP request through the proxy.
 */
function makeProxyRequest(
  url: string,
  method: string,
  proxyPort: number
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);

    const options: http.RequestOptions = {
      host: '127.0.0.1',
      port: proxyPort,
      path: url,
      method,
      headers: {
        Host: parsedUrl.host,
      },
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        resolve({ statusCode: res.statusCode ?? 0, body });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Make a CONNECT request through the proxy.
 */
function makeConnectRequest(
  target: string,
  proxyPort: number
): Promise<{ success: boolean; statusCode: number }> {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: target,
    });

    req.on('connect', (res, socket) => {
      socket.destroy();
      resolve({ success: true, statusCode: res.statusCode ?? 0 });
    });

    req.on('response', (res) => {
      resolve({ success: false, statusCode: res.statusCode ?? 0 });
    });

    req.on('error', () => {
      resolve({ success: false, statusCode: 0 });
    });

    req.end();
  });
}
