import { describe, it, expect, beforeEach } from 'vitest';
import {
  BodyTransformer,
  createBodyTransformer,
  type BodyTransformRule,
  type TransformContext,
} from '../src/proxy/body-transformer.js';

describe('BodyTransformer', () => {
  let transformer: BodyTransformer;

  const createContext = (overrides: Partial<TransformContext> = {}): TransformContext => ({
    host: 'api.example.com',
    path: '/api/test',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    contentType: 'application/json',
    ...overrides,
  });

  describe('JSON transformations', () => {
    beforeEach(() => {
      transformer = new BodyTransformer({
        rules: [
          {
            id: 'json-transform',
            direction: 'request',
            contentTypeFilter: 'application/json',
            jsonOperations: [
              { type: 'set', path: 'timestamp', value: 12345 },
              { type: 'set', path: 'nested.added', value: 'new value' },
            ],
          },
        ],
      });
    });

    it('should add JSON fields', async () => {
      const body = Buffer.from(JSON.stringify({ original: true }));
      const context = createContext();

      const result = await transformer.transform(body, context, 'request');

      expect(result.bodyModified).toBe(true);
      const parsed = JSON.parse(result.body.toString());
      expect(parsed.original).toBe(true);
      expect(parsed.timestamp).toBe(12345);
      expect(parsed.nested.added).toBe('new value');
    });

    it('should delete JSON fields', async () => {
      transformer = createBodyTransformer({
        rules: [
          {
            id: 'delete-rule',
            direction: 'request',
            contentTypeFilter: 'application/json',
            jsonOperations: [
              { type: 'delete', path: 'sensitive' },
            ],
          },
        ],
      });

      const body = Buffer.from(JSON.stringify({ keep: true, sensitive: 'secret' }));
      const context = createContext();

      const result = await transformer.transform(body, context, 'request');

      const parsed = JSON.parse(result.body.toString());
      expect(parsed.keep).toBe(true);
      expect(parsed.sensitive).toBeUndefined();
    });

    it('should rename JSON fields', async () => {
      transformer = createBodyTransformer({
        rules: [
          {
            id: 'rename-rule',
            direction: 'request',
            contentTypeFilter: 'application/json',
            jsonOperations: [
              { type: 'rename', path: 'oldName', newPath: 'newName' },
            ],
          },
        ],
      });

      const body = Buffer.from(JSON.stringify({ oldName: 'value' }));
      const context = createContext();

      const result = await transformer.transform(body, context, 'request');

      const parsed = JSON.parse(result.body.toString());
      expect(parsed.oldName).toBeUndefined();
      expect(parsed.newName).toBe('value');
    });

    it('should copy JSON fields', async () => {
      transformer = createBodyTransformer({
        rules: [
          {
            id: 'copy-rule',
            direction: 'request',
            contentTypeFilter: 'application/json',
            jsonOperations: [
              { type: 'copy', path: 'source', newPath: 'copy' },
            ],
          },
        ],
      });

      const body = Buffer.from(JSON.stringify({ source: { nested: true } }));
      const context = createContext();

      const result = await transformer.transform(body, context, 'request');

      const parsed = JSON.parse(result.body.toString());
      expect(parsed.source.nested).toBe(true);
      expect(parsed.copy.nested).toBe(true);
    });

    it('should move JSON fields', async () => {
      transformer = createBodyTransformer({
        rules: [
          {
            id: 'move-rule',
            direction: 'request',
            contentTypeFilter: 'application/json',
            jsonOperations: [
              { type: 'move', path: 'source', newPath: 'destination' },
            ],
          },
        ],
      });

      const body = Buffer.from(JSON.stringify({ source: 'value' }));
      const context = createContext();

      const result = await transformer.transform(body, context, 'request');

      const parsed = JSON.parse(result.body.toString());
      expect(parsed.source).toBeUndefined();
      expect(parsed.destination).toBe('value');
    });
  });

  describe('text transformations', () => {
    beforeEach(() => {
      transformer = new BodyTransformer({
        rules: [
          {
            id: 'text-transform',
            direction: 'response',
            textReplacements: [
              { pattern: 'old-url', replacement: 'new-url' },
              { pattern: /secret-\d+/g, replacement: '[REDACTED]' },
            ],
          },
        ],
      });
    });

    it('should perform text replacements', async () => {
      const body = Buffer.from('Visit old-url for more info');
      const context = createContext({ contentType: 'text/plain' });

      const result = await transformer.transform(body, context, 'response');

      expect(result.bodyModified).toBe(true);
      expect(result.body.toString()).toBe('Visit new-url for more info');
    });

    it('should handle regex replacements', async () => {
      const body = Buffer.from('Keys: secret-123 and secret-456');
      const context = createContext({ contentType: 'text/plain' });

      const result = await transformer.transform(body, context, 'response');

      expect(result.body.toString()).toBe('Keys: [REDACTED] and [REDACTED]');
    });
  });

  describe('header transformations', () => {
    beforeEach(() => {
      transformer = new BodyTransformer({
        rules: [
          {
            id: 'header-transform',
            direction: 'request',
            headerTransforms: {
              add: { 'x-custom': 'added' },
              remove: ['x-remove'],
              rename: { 'x-old': 'x-new' },
              override: { 'x-override': 'overridden' },
            },
          },
        ],
      });
    });

    it('should add headers', async () => {
      const context = createContext();
      const result = await transformer.transform(Buffer.from(''), context, 'request');

      expect(result.headersModified).toBe(true);
      expect(result.headers['x-custom']).toBe('added');
    });

    it('should remove headers', async () => {
      const context = createContext({
        headers: { 'x-remove': 'value', 'x-keep': 'value' },
      });

      const result = await transformer.transform(Buffer.from(''), context, 'request');

      expect(result.headers['x-remove']).toBeUndefined();
      expect(result.headers['x-keep']).toBe('value');
    });

    it('should rename headers', async () => {
      const context = createContext({
        headers: { 'x-old': 'value' },
      });

      const result = await transformer.transform(Buffer.from(''), context, 'request');

      expect(result.headers['x-old']).toBeUndefined();
      expect(result.headers['x-new']).toBe('value');
    });

    it('should override headers', async () => {
      const context = createContext({
        headers: { 'x-override': 'original' },
      });

      const result = await transformer.transform(Buffer.from(''), context, 'request');

      expect(result.headers['x-override']).toBe('overridden');
    });
  });

  describe('rule filtering', () => {
    it('should filter by host pattern', async () => {
      transformer = createBodyTransformer({
        rules: [
          {
            id: 'api-only',
            direction: 'request',
            hostPattern: /^api\./,
            jsonOperations: [{ type: 'set', path: 'matched', value: true }],
          },
        ],
      });

      const body = Buffer.from('{}');

      // Matching host
      const result1 = await transformer.transform(
        body,
        createContext({ host: 'api.example.com' }),
        'request'
      );
      expect(JSON.parse(result1.body.toString()).matched).toBe(true);

      // Non-matching host
      const result2 = await transformer.transform(
        body,
        createContext({ host: 'www.example.com' }),
        'request'
      );
      expect(result2.bodyModified).toBe(false);
    });

    it('should filter by path pattern', async () => {
      transformer = createBodyTransformer({
        rules: [
          {
            id: 'api-path',
            direction: 'request',
            pathPattern: /^\/api\//,
            jsonOperations: [{ type: 'set', path: 'matched', value: true }],
          },
        ],
      });

      const body = Buffer.from('{}');

      // Matching path
      const result1 = await transformer.transform(
        body,
        createContext({ path: '/api/users' }),
        'request'
      );
      expect(result1.bodyModified).toBe(true);

      // Non-matching path
      const result2 = await transformer.transform(
        body,
        createContext({ path: '/health' }),
        'request'
      );
      expect(result2.bodyModified).toBe(false);
    });

    it('should filter by content type', async () => {
      transformer = createBodyTransformer({
        rules: [
          {
            id: 'json-only',
            direction: 'request',
            contentTypeFilter: 'application/json',
            jsonOperations: [{ type: 'set', path: 'matched', value: true }],
          },
        ],
      });

      const body = Buffer.from('{}');

      // Matching content type
      const result1 = await transformer.transform(
        body,
        createContext({ contentType: 'application/json' }),
        'request'
      );
      expect(result1.bodyModified).toBe(true);

      // Non-matching content type
      const result2 = await transformer.transform(
        body,
        createContext({ contentType: 'text/plain' }),
        'request'
      );
      expect(result2.bodyModified).toBe(false);
    });

    it('should filter by direction', async () => {
      transformer = createBodyTransformer({
        rules: [
          {
            id: 'request-only',
            direction: 'request',
            jsonOperations: [{ type: 'set', path: 'direction', value: 'request' }],
          },
          {
            id: 'response-only',
            direction: 'response',
            jsonOperations: [{ type: 'set', path: 'direction', value: 'response' }],
          },
        ],
      });

      const body = Buffer.from('{}');
      const context = createContext();

      const requestResult = await transformer.transform(body, context, 'request');
      expect(JSON.parse(requestResult.body.toString()).direction).toBe('request');

      const responseResult = await transformer.transform(body, context, 'response');
      expect(JSON.parse(responseResult.body.toString()).direction).toBe('response');
    });
  });

  describe('rule priority', () => {
    it('should apply rules in priority order', async () => {
      transformer = createBodyTransformer({
        rules: [
          {
            id: 'low-priority',
            direction: 'request',
            priority: 1,
            jsonOperations: [{ type: 'set', path: 'order', value: 'low' }],
          },
          {
            id: 'high-priority',
            direction: 'request',
            priority: 10,
            jsonOperations: [{ type: 'set', path: 'order', value: 'high' }],
          },
        ],
      });

      const body = Buffer.from('{}');
      const result = await transformer.transform(body, createContext(), 'request');

      // Low priority runs last, so its value wins
      expect(JSON.parse(result.body.toString()).order).toBe('low');
      expect(result.appliedRules).toEqual(['high-priority', 'low-priority']);
    });
  });

  describe('content-length update', () => {
    it('should update content-length after modification', async () => {
      transformer = createBodyTransformer({
        rules: [
          {
            id: 'add-data',
            direction: 'request',
            jsonOperations: [
              { type: 'set', path: 'added', value: 'some extra data' },
            ],
          },
        ],
      });

      const body = Buffer.from('{}');
      const context = createContext({
        headers: { 'content-length': '2' },
      });

      const result = await transformer.transform(body, context, 'request');

      expect(result.headers['content-length']).not.toBe('2');
      expect(parseInt(result.headers['content-length'] as string)).toBe(result.body.length);
    });
  });

  describe('rule management', () => {
    it('should add rules dynamically', async () => {
      transformer = createBodyTransformer({});

      transformer.addRule({
        id: 'dynamic',
        direction: 'request',
        jsonOperations: [{ type: 'set', path: 'dynamic', value: true }],
      });

      const body = Buffer.from('{}');
      const result = await transformer.transform(body, createContext(), 'request');

      expect(JSON.parse(result.body.toString()).dynamic).toBe(true);
    });

    it('should remove rules', async () => {
      transformer = createBodyTransformer({
        rules: [
          { id: 'remove-me', direction: 'request', jsonOperations: [] },
        ],
      });

      expect(transformer.removeRule('remove-me')).toBe(true);
      expect(transformer.getRule('remove-me')).toBeUndefined();
    });

    it('should get all rules', () => {
      transformer = createBodyTransformer({
        rules: [
          { id: 'rule1', direction: 'request' },
          { id: 'rule2', direction: 'response' },
        ],
      });

      const rules = transformer.getRules();
      expect(rules).toHaveLength(2);
    });

    it('should clear all rules', () => {
      transformer = createBodyTransformer({
        rules: [
          { id: 'rule1', direction: 'request' },
          { id: 'rule2', direction: 'response' },
        ],
      });

      transformer.clearRules();
      expect(transformer.getRules()).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('should handle empty body', async () => {
      transformer = createBodyTransformer({
        rules: [
          {
            id: 'skip-empty',
            direction: 'request',
            skipEmpty: true,
            jsonOperations: [{ type: 'set', path: 'added', value: true }],
          },
        ],
      });

      const result = await transformer.transform(
        Buffer.from(''),
        createContext(),
        'request'
      );

      expect(result.bodyModified).toBe(false);
      expect(result.appliedRules).toHaveLength(0);
    });

    it('should handle invalid JSON gracefully', async () => {
      transformer = createBodyTransformer({
        rules: [
          {
            id: 'json-rule',
            direction: 'request',
            jsonOperations: [{ type: 'set', path: 'added', value: true }],
          },
        ],
      });

      const body = Buffer.from('not valid json');
      const result = await transformer.transform(body, createContext(), 'request');

      expect(result.bodyModified).toBe(false);
      expect(result.body.toString()).toBe('not valid json');
    });

    it('should skip large bodies', async () => {
      transformer = createBodyTransformer({
        maxBodySize: 100,
        rules: [
          {
            id: 'transform',
            direction: 'request',
            jsonOperations: [{ type: 'set', path: 'added', value: true }],
          },
        ],
      });

      const largeBody = Buffer.alloc(200, 'x');
      const result = await transformer.transform(largeBody, createContext(), 'request');

      expect(result.bodyModified).toBe(false);
    });
  });

  describe('custom transformations', () => {
    it('should apply custom transform function', async () => {
      transformer = createBodyTransformer({
        rules: [
          {
            id: 'custom',
            direction: 'request',
            customTransform: (body) => {
              return Buffer.from(body.toString().toUpperCase());
            },
          },
        ],
      });

      const body = Buffer.from('hello world');
      const result = await transformer.transform(body, createContext(), 'request');

      expect(result.body.toString()).toBe('HELLO WORLD');
      expect(result.bodyModified).toBe(true);
    });

    it('should handle async custom transform', async () => {
      transformer = createBodyTransformer({
        rules: [
          {
            id: 'async-custom',
            direction: 'request',
            customTransform: async (body) => {
              await new Promise((resolve) => setTimeout(resolve, 10));
              return Buffer.from(body.toString().toUpperCase());
            },
          },
        ],
      });

      const body = Buffer.from('hello');
      const result = await transformer.transform(body, createContext(), 'request');

      expect(result.body.toString()).toBe('HELLO');
    });
  });
});
