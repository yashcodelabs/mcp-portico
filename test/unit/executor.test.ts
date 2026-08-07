import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { PorticoPrincipal } from '../../src/auth/types';
import { MemoryAuditLog } from '../../src/audit/log';
import type {
  CatalogCachePolicy,
  ConfirmationPolicy,
  HttpMethod,
  NormalizedApiModel,
  NormalizedOperation,
  NormalizedParameter,
  NormalizedRequestBody,
  NormalizedResponse,
  RedactionRule,
  RiskLevel,
} from '../../src/catalog/types';
import { compileCatalog } from '../../src/catalog/compile';
import { LimitsStore } from '../../src/limits/store';
import { snapshotFromDocument } from '../../src/registry/snapshot';
import type { RegistryDocument } from '../../src/registry/types';
import { CacheStore } from '../../src/runtime/cache';
import { CircuitBreakerStore } from '../../src/runtime/circuit';
import { createOperationExecutor } from '../../src/runtime/executor';
import {
  confirmationTokenFor,
  type OperationExecutor,
} from '../../src/runtime/execution';
import { HealthStore } from '../../src/runtime/health';
import { SessionStore, type SessionState } from '../../src/session/store';
import { PorticoError } from '../../src/shared/errors';

type UpstreamHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Buffer,
) => void;

const servers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const close = servers.pop();
    if (close !== undefined) await close();
  }
});

async function startServer(
  handler: UpstreamHandler,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => handler(req, res, Buffer.concat(chunks)));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  let closed = false;
  const close = () =>
    new Promise<void>((resolve) => {
      if (closed) {
        resolve();
        return;
      }
      closed = true;
      server.close(() => resolve());
    });
  servers.push(close);
  return { port: address.port, close };
}

interface OperationInput {
  operationId?: string;
  method?: HttpMethod;
  path?: string;
  parameters?: NormalizedParameter[];
  requestBody?: NormalizedRequestBody;
  responses?: Record<string, NormalizedResponse>;
  risk?: RiskLevel;
  confirmation?: ConfirmationPolicy;
  cache?: CatalogCachePolicy;
  redactions?: RedactionRule[];
}

function operation(input: OperationInput = {}): NormalizedOperation {
  return {
    method: input.method ?? 'GET',
    path: input.path ?? '/echo/{id}',
    parameters: input.parameters ?? [],
    responses: input.responses ?? {
      '200': {
        description: 'OK',
        contentTypes: ['application/json'],
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
      },
    },
    ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
    ...(input.requestBody !== undefined ? { requestBody: input.requestBody } : {}),
    ...(input.risk !== undefined ? { risk: input.risk } : {}),
    ...(input.confirmation !== undefined ? { confirmation: input.confirmation } : {}),
    ...(input.cache !== undefined ? { cache: input.cache } : {}),
    ...(input.redactions !== undefined ? { redactions: input.redactions } : {}),
  };
}

function buildModel(): NormalizedApiModel {
  return {
    api: { id: 'echo', title: 'Echo API', version: '1.0.0' },
    securitySchemes: {},
    operations: [
      operation({
        operationId: 'echo.get',
        path: '/echo/{id}',
        parameters: [
          { in: 'path', name: 'id', required: true, schema: { type: 'string' } },
          { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
        ],
      }),
      operation({
        operationId: 'echo.post',
        method: 'POST',
        path: '/echo',
        risk: 'write',
        confirmation: 'write',
        requestBody: {
          contentTypes: ['application/json'],
          required: true,
          schema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
          },
        },
        responses: {
          '201': { description: 'Created', contentTypes: ['application/json'] },
        },
      }),
      operation({
        operationId: 'echo.form',
        method: 'POST',
        path: '/form',
        risk: 'write',
        confirmation: 'never',
        requestBody: {
          contentTypes: ['application/x-www-form-urlencoded'],
          kind: 'form',
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              age: { type: 'number' },
            },
          },
        },
      }),
      operation({
        operationId: 'echo.multipart',
        method: 'POST',
        path: '/multipart',
        risk: 'write',
        confirmation: 'never',
        requestBody: { contentTypes: ['multipart/form-data'], kind: 'multipart' },
      }),
      operation({
        operationId: 'echo.binary',
        method: 'POST',
        path: '/binary',
        risk: 'write',
        confirmation: 'never',
        requestBody: { contentTypes: ['application/octet-stream'], kind: 'binary' },
      }),
      operation({
        operationId: 'echo.text',
        method: 'POST',
        path: '/text',
        risk: 'write',
        confirmation: 'never',
        requestBody: { contentTypes: ['text/plain'], kind: 'text' },
      }),
      operation({
        operationId: 'redact.get',
        path: '/redact',
        redactions: [{ fields: ['secret'] }],
      }),
    ],
  };
}

function modelWithCache(model: NormalizedApiModel): NormalizedApiModel {
  return {
    ...model,
    operations: model.operations.map((entry) =>
      entry.operationId === 'echo.get'
        ? { ...entry, cache: { eligible: true, ttlSeconds: 60 } }
        : entry,
    ),
  };
}

interface SetupOverrides {
  rateLimitPerMinute?: number;
  maxResponseBytes?: number;
  failureThreshold?: number;
  validateResponses?: boolean;
  model?: NormalizedApiModel;
}

interface SetupResult {
  executor: OperationExecutor;
  principal: PorticoPrincipal;
  session: SessionState;
  snapshot: ReturnType<typeof snapshotFromDocument>;
  catalog: ReturnType<typeof compileCatalog>['catalog'];
  close: () => Promise<void>;
}

async function setup(
  handler: UpstreamHandler,
  overrides: SetupOverrides = {},
): Promise<SetupResult> {
  const model = overrides.model ?? buildModel();
  const { catalog } = compileCatalog(model);
  const { port, close } = await startServer(handler);
  const document: RegistryDocument = {
    version: 1,
    tenants: [{ id: 'acme', name: 'Acme' }],
    principals: [
      { id: 'automation', tenantId: 'acme', allowedConnectionIds: ['conn'] },
    ],
    backends: [
      {
        id: 'echo',
        title: 'Echo API',
        scope: 'global',
        catalogRef: 'catalog.json',
        catalogChecksum: catalog.checksum,
      },
    ],
    connections: [
      {
        id: 'conn',
        tenantId: 'acme',
        backendId: 'echo',
        baseUrl: `http://127.0.0.1:${port}`,
        network: { allowedProtocols: ['http'], allowLoopback: true },
        auth: { type: 'none' },
        ...(overrides.rateLimitPerMinute !== undefined ||
        overrides.maxResponseBytes !== undefined
          ? {
              policy: {
                ...(overrides.rateLimitPerMinute !== undefined
                  ? { rateLimitPerMinute: overrides.rateLimitPerMinute }
                  : {}),
                ...(overrides.maxResponseBytes !== undefined
                  ? { maxResponseBytes: overrides.maxResponseBytes }
                  : {}),
              },
            }
          : {}),
      },
      {
        id: 'other',
        tenantId: 'acme',
        backendId: 'echo',
        baseUrl: 'http://127.0.0.1:9',
        network: { allowedProtocols: ['http'], allowLoopback: true },
        auth: { type: 'none' },
      },
    ],
  };
  const snapshot = snapshotFromDocument(document, new Map([['catalog.json', catalog]]));
  const principal: PorticoPrincipal = {
    id: 'automation',
    tenantId: 'acme',
    allowedConnectionIds: ['conn'],
  };
  const sessions = new SessionStore();
  const session = sessions.create({ principal, connectionId: 'conn', snapshot });
  const executor = createOperationExecutor({
    limits: new LimitsStore(),
    audit: new MemoryAuditLog(),
    caches: new CacheStore(),
    circuitBreakers: new CircuitBreakerStore({
      failureThreshold: overrides.failureThreshold ?? 5,
    }),
    health: new HealthStore(),
    ...(overrides.validateResponses === true ? { validateResponses: true } : {}),
  });
  return { executor, principal, session, snapshot, catalog, close };
}

function jsonHandler(payload: unknown, status = 200): UpstreamHandler {
  return (_req, res, _body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
}

describe('createOperationExecutor', () => {
  it('renders path and query parameters for a JSON GET', async () => {
    let seenUrl = '';
    const env = await setup((req, res) => {
      seenUrl = req.url ?? '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const result = await env.executor.execute(
      { snapshot: env.snapshot, session: env.session, principal: env.principal },
      { operationId: 'echo.get', arguments: { id: 'a b/c', q: 'hello world' } },
    );
    expect(result.requiresConfirmation).toBe(false);
    if (result.requiresConfirmation) return;
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('application/json');
    expect(result.body).toEqual({ kind: 'json', data: { ok: true } });
    expect(seenUrl).toBe('/echo/a%20b%2Fc?q=hello+world');
    await env.close();
  });

  it('rejects unknown arguments with USAGE', async () => {
    const env = await setup(jsonHandler({ ok: true }));
    const error = await env.executor
      .execute(
        { snapshot: env.snapshot, session: env.session, principal: env.principal },
        { operationId: 'echo.get', arguments: { id: 'x', nope: 1 } },
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(PorticoError);
    if (!(error instanceof PorticoError)) return;
    expect(error.code).toBe('USAGE');
    expect(error.message).toContain('Unknown argument(s): nope.');
    expect(error.message).toContain('Allowed: id, q');
    await env.close();
  });

  it('rejects missing required parameters with USAGE', async () => {
    const env = await setup(jsonHandler({ ok: true }));
    const error = await env.executor
      .execute(
        { snapshot: env.snapshot, session: env.session, principal: env.principal },
        { operationId: 'echo.get', arguments: {} },
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(PorticoError);
    if (!(error instanceof PorticoError)) return;
    expect(error.code).toBe('USAGE');
    expect(error.message).toContain('Missing required parameter(s): id.');
    await env.close();
  });

  it('requires confirmation for write operations and enforces the token', async () => {
    let receivedBody = '';
    const env = await setup((req, res, body) => {
      receivedBody = body.toString('utf8');
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const argumentsValue = { body: { message: 'hello' } };

    const first = await env.executor.execute(
      { snapshot: env.snapshot, session: env.session, principal: env.principal },
      { operationId: 'echo.post', arguments: argumentsValue },
    );
    expect(first.requiresConfirmation).toBe(true);
    if (!first.requiresConfirmation) return;
    expect(first.risk).toBe('write');
    expect(first.message).toBe(
      'Operation "echo.post" requires confirmation before execution.',
    );
    expect(first.token).toBe(
      confirmationTokenFor(env.principal.id, 'echo.post', argumentsValue),
    );

    const executed = await env.executor.execute(
      { snapshot: env.snapshot, session: env.session, principal: env.principal },
      {
        operationId: 'echo.post',
        arguments: argumentsValue,
        confirmationToken: first.token,
      },
    );
    expect(executed.requiresConfirmation).toBe(false);
    if (executed.requiresConfirmation) return;
    expect(executed.status).toBe(201);
    expect(receivedBody).toBe(JSON.stringify({ message: 'hello' }));

    const wrong = await env.executor
      .execute(
        { snapshot: env.snapshot, session: env.session, principal: env.principal },
        {
          operationId: 'echo.post',
          arguments: argumentsValue,
          confirmationToken: 'not-the-token',
        },
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(wrong).toBeInstanceOf(PorticoError);
    if (!(wrong instanceof PorticoError)) return;
    expect(wrong.code).toBe('USAGE');
    expect(wrong.message).toBe(
      'Confirmation token does not match the operation input.',
    );
    await env.close();
  });

  it.each([
    {
      operationId: 'echo.form',
      argumentsValue: { body: { name: 'alice', age: 42 } },
      contentType: 'application/x-www-form-urlencoded',
      expectedBody: 'name=alice&age=42',
    },
    {
      operationId: 'echo.binary',
      argumentsValue: { body: Buffer.from('binary-data').toString('base64') },
      contentType: 'application/octet-stream',
      expectedBody: 'binary-data',
    },
    {
      operationId: 'echo.text',
      argumentsValue: { body: 'plain text' },
      contentType: 'text/plain',
      expectedBody: 'plain text',
    },
  ])(
    'encodes a $operationId request body and reaches upstream correctly',
    async ({ operationId, argumentsValue, contentType, expectedBody }) => {
      let seenContentType = '';
      let seenBody = '';
      const env = await setup((req, res, body) => {
        seenContentType = req.headers['content-type'] ?? '';
        seenBody = body.toString('utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      const result = await env.executor.execute(
        { snapshot: env.snapshot, session: env.session, principal: env.principal },
        { operationId, arguments: argumentsValue },
      );
      expect(result.requiresConfirmation).toBe(false);
      if (result.requiresConfirmation) return;
      expect(result.status).toBe(200);
      expect(seenContentType).toBe(contentType);
      expect(seenBody).toBe(expectedBody);
      await env.close();
    },
  );

  it('encodes a multipart body with string and binary parts', async () => {
    let seenContentType = '';
    let seenBody = '';
    const env = await setup((req, res, body) => {
      seenContentType = req.headers['content-type'] ?? '';
      seenBody = body.toString('utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const result = await env.executor.execute(
      { snapshot: env.snapshot, session: env.session, principal: env.principal },
      {
        operationId: 'echo.multipart',
        arguments: {
          body: {
            note: 'hello',
            file: {
              base64: Buffer.from('file-bytes').toString('base64'),
              filename: 'a.txt',
              contentType: 'text/plain',
            },
          },
        },
      },
    );
    expect(result.requiresConfirmation).toBe(false);
    if (result.requiresConfirmation) return;
    expect(result.status).toBe(200);
    expect(
      seenContentType.startsWith('multipart/form-data; boundary=----portico-'),
    ).toBe(true);
    expect(seenBody).toContain('Content-Disposition: form-data; name="note"');
    expect(seenBody).toContain('hello');
    expect(seenBody).toContain(
      'Content-Disposition: form-data; name="file"; filename="a.txt"',
    );
    expect(seenBody).toContain('Content-Type: text/plain');
    expect(seenBody).toContain('file-bytes');
    const boundary = seenContentType.split('boundary=')[1];
    expect(boundary).toBeDefined();
    expect(seenBody).toContain(`--${boundary}--\r\n`);
    await env.close();
  });

  it('redacts response fields listed in operation redactions plus defaults', async () => {
    const env = await setup(
      jsonHandler({ secret: 'abc', token: 'xyz', ok: true, nested: { apiKey: 'k' } }),
    );
    const result = await env.executor.execute(
      { snapshot: env.snapshot, session: env.session, principal: env.principal },
      { operationId: 'redact.get', arguments: {} },
    );
    expect(result.requiresConfirmation).toBe(false);
    if (result.requiresConfirmation) return;
    expect(result.body).toEqual({
      kind: 'json',
      data: {
        secret: '<redacted>',
        token: '<redacted>',
        ok: true,
        nested: { apiKey: '<redacted>' },
      },
    });
    await env.close();
  });

  it('truncates responses that exceed the connection response limit', async () => {
    const env = await setup(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('a'.repeat(100));
      },
      { maxResponseBytes: 8 },
    );
    const result = await env.executor.execute(
      { snapshot: env.snapshot, session: env.session, principal: env.principal },
      { operationId: 'echo.get', arguments: { id: 'x' } },
    );
    expect(result.requiresConfirmation).toBe(false);
    if (result.requiresConfirmation) return;
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(8);
    expect(result.body?.kind).toBe('text');
    await env.close();
  });

  it('serves eligible GET responses from the response cache', async () => {
    let requests = 0;
    const env = await setup(
      (_req, res) => {
        requests += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      },
      { model: modelWithCache(buildModel()) },
    );
    const context = {
      snapshot: env.snapshot,
      session: env.session,
      principal: env.principal,
    };
    const input = { operationId: 'echo.get', arguments: { id: 'x' } };
    const first = await env.executor.execute(context, input);
    const second = await env.executor.execute(context, input);
    expect(requests).toBe(1);
    expect(second).toEqual(first);
    await env.close();
  });

  it('enforces the per-principal connection rate limit', async () => {
    const env = await setup(jsonHandler({ ok: true }), { rateLimitPerMinute: 1 });
    const context = {
      snapshot: env.snapshot,
      session: env.session,
      principal: env.principal,
    };
    await env.executor.execute(context, {
      operationId: 'echo.get',
      arguments: { id: 'x' },
    });
    const error = await env.executor
      .execute(context, { operationId: 'echo.get', arguments: { id: 'x' } })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(PorticoError);
    if (!(error instanceof PorticoError)) return;
    expect(error.code).toBe('API_ERROR');
    expect(error.message).toBe('Connection rate limit exceeded.');
    expect(error.details).toMatchObject({ retryAfterMs: expect.any(Number) });
    await env.close();
  });

  it('opens the circuit breaker after repeated upstream failures', async () => {
    const env = await setup(jsonHandler({ error: 'boom' }, 500), {
      failureThreshold: 2,
    });
    const context = {
      snapshot: env.snapshot,
      session: env.session,
      principal: env.principal,
    };
    await env.executor
      .execute(context, { operationId: 'echo.get', arguments: { id: 'x' } })
      .catch(() => undefined);
    await env.executor
      .execute(context, { operationId: 'echo.get', arguments: { id: 'x' } })
      .catch(() => undefined);
    const error = await env.executor
      .execute(context, { operationId: 'echo.get', arguments: { id: 'x' } })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(PorticoError);
    if (!(error instanceof PorticoError)) return;
    expect(error.code).toBe('API_ERROR');
    expect(error.message).toBe(
      'Connection circuit breaker is open; refusing the call.',
    );
    await env.close();
  });

  it('optionally validates upstream JSON responses against catalog schemas', async () => {
    const env = await setup(jsonHandler({ nope: 1 }), { validateResponses: true });
    const error = await env.executor
      .execute(
        { snapshot: env.snapshot, session: env.session, principal: env.principal },
        { operationId: 'echo.get', arguments: { id: 'x' } },
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(PorticoError);
    if (!(error instanceof PorticoError)) return;
    expect(error.code).toBe('API_ERROR');
    expect(error.message).toBe('Upstream response failed schema validation.');
    await env.close();
  });

  it('fails softly in batches: per-item errors and successful items', async () => {
    const env = await setup(jsonHandler({ ok: true }));
    const batch = await env.executor.executeBatch(
      { snapshot: env.snapshot, session: env.session, principal: env.principal },
      [
        { operationId: 'no.such.operation', arguments: {} },
        { operationId: 'echo.get', arguments: { id: 'x' } },
      ],
    );
    expect(batch.failed).toBe(1);
    expect(batch.results[0]).toMatchObject({
      index: 0,
      operationId: 'no.such.operation',
      error: { code: 'NOT_FOUND', message: 'Operation not found or not authorized.' },
    });
    expect(batch.results[1]?.result?.status).toBe(200);
    await env.close();
  });

  it('aborts remaining items when a batch fails fast', async () => {
    const env = await setup(jsonHandler({ ok: true }));
    const batch = await env.executor.executeBatch(
      { snapshot: env.snapshot, session: env.session, principal: env.principal },
      [
        { operationId: 'no.such.operation', arguments: {} },
        { operationId: 'echo.get', arguments: { id: 'x' } },
        { operationId: 'echo.get', arguments: { id: 'y' } },
      ],
      { failFast: true },
    );
    expect(batch.results[0]?.error?.code).toBe('NOT_FOUND');
    expect(batch.results[1]?.result?.status).toBe(200);
    expect(batch.results[2]).toMatchObject({
      index: 2,
      operationId: 'echo.get',
      error: { code: 'ABORTED', message: 'Batch aborted after an earlier failure.' },
    });
    expect(batch.failed).toBe(2);
    await env.close();
  });

  it('returns a non-enumerating error for unknown operations and unauthorized connections', async () => {
    const env = await setup(jsonHandler({ ok: true }));
    const unknownOperation = await env.executor
      .execute(
        { snapshot: env.snapshot, session: env.session, principal: env.principal },
        { operationId: 'no.such.operation', arguments: {} },
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    const foreignSession: SessionState = {
      id: 'foreign',
      tenantId: 'acme',
      principalId: 'automation',
      connectionId: 'other',
      registryRevision: env.snapshot.revision,
      catalogChecksum: env.catalog.checksum,
      createdAt: 0,
    };
    const unauthorized = await env.executor
      .execute(
        { snapshot: env.snapshot, session: foreignSession, principal: env.principal },
        { operationId: 'echo.get', arguments: { id: 'x' } },
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(unknownOperation).toBeInstanceOf(PorticoError);
    expect(unauthorized).toBeInstanceOf(PorticoError);
    if (!(unknownOperation instanceof PorticoError)) return;
    if (!(unauthorized instanceof PorticoError)) return;
    expect(unknownOperation.code).toBe('NOT_FOUND');
    expect(unauthorized.code).toBe('NOT_FOUND');
    expect(unknownOperation.message).toBe(unauthorized.message);
    expect(unknownOperation.message).toBe('Operation not found or not authorized.');
    await env.close();
  });
});
