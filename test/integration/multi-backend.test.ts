import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from '../../src/cli/serve';
import { generatePorticoKey } from '../../src/identity/keys';
import { writeRegistryFile } from '../../src/registry/load';
import type { RegistryDocument } from '../../src/registry/types';
import { envName } from '../../src/shared/brand';

const PEPPER = 'multi-backend-test-pepper';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'portico-multi-backend-'));

const ORDERS_CATALOG_SOURCE = path.join(
  __dirname,
  '..',
  'fixtures',
  'analyze',
  'express-orders',
  'analysis',
  'out',
  'catalog.json',
);
const TASKS_CATALOG_SOURCE = path.join(
  __dirname,
  '..',
  'fixtures',
  'analyze',
  'fastapi-tasks',
  'analysis',
  'out',
  'catalog.json',
);

const ACME_ORDERS_TOKEN_ENV = 'ACME_ORDERS_TOKEN';
const GLOBEX_TASKS_TOKEN_ENV = 'GLOBEX_TASKS_TOKEN';

const originalPepper = process.env[envName('KEY_PEPPER')];
const originalAcmeOrdersToken = process.env[ACME_ORDERS_TOKEN_ENV];
const originalGlobexTasksToken = process.env[GLOBEX_TASKS_TOKEN_ENV];

let server: RunningServer;
let acmeToken = '';
let globexToken = '';
let acmeOrdersSecret = '';
let globexTasksSecret = '';
let ordersCatalogChecksum = '';
let tasksCatalogChecksum = '';

const upstreams: http.Server[] = [];

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  rawBody: string;
}

const ordersRequests: RecordedRequest[] = [];
const tasksRequests: RecordedRequest[] = [];

function registryDocument(
  acmeKey: { keyId: string; digest: string },
  globexKey: { keyId: string; digest: string },
  ordersBaseUrl: string,
  tasksBaseUrl: string,
): RegistryDocument {
  return {
    version: 1,
    tenants: [
      { id: 'acme', name: 'Acme' },
      { id: 'globex', name: 'Globex' },
    ],
    principals: [
      {
        id: 'acme-user',
        tenantId: 'acme',
        allowedConnectionIds: ['acme-orders'],
        keyId: acmeKey.keyId,
        keyDigest: acmeKey.digest,
      },
      {
        id: 'globex-user',
        tenantId: 'globex',
        allowedConnectionIds: ['globex-tasks'],
        keyId: globexKey.keyId,
        keyDigest: globexKey.digest,
      },
    ],
    backends: [
      {
        id: 'orders-backend',
        title: 'Express Orders API',
        scope: 'global',
        catalogRef: './orders-catalog.json',
        catalogChecksum: ordersCatalogChecksum,
      },
      {
        id: 'tasks-backend',
        title: 'FastAPI Tasks API',
        scope: 'global',
        catalogRef: './tasks-catalog.json',
        catalogChecksum: tasksCatalogChecksum,
      },
    ],
    connections: [
      {
        id: 'acme-orders',
        tenantId: 'acme',
        backendId: 'orders-backend',
        baseUrl: ordersBaseUrl,
        network: { allowedProtocols: ['http'], allowLoopback: true },
        auth: { type: 'bearer', tokenRef: `env:${ACME_ORDERS_TOKEN_ENV}` },
      },
      {
        id: 'globex-tasks',
        tenantId: 'globex',
        backendId: 'tasks-backend',
        baseUrl: tasksBaseUrl,
        network: { allowedProtocols: ['http'], allowLoopback: true },
        auth: { type: 'bearer', tokenRef: `env:${GLOBEX_TASKS_TOKEN_ENV}` },
      },
    ],
  };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function handleOrders(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url ?? '/';
  if (req.method === 'GET' && url === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }
  if (req.method === 'GET' && url === '/orders') {
    sendJson(res, 200, [
      {
        id: 'ORD-1',
        status: 'confirmed',
        totalCents: 2500,
        items: [{ productId: 'P-1', quantity: 2 }],
      },
    ]);
    return;
  }
  if (req.method === 'GET' && /^\/orders\/[^/]+$/.test(url)) {
    const orderId = decodeURIComponent(url.slice('/orders/'.length));
    sendJson(res, 200, {
      id: orderId,
      status: 'confirmed',
      totalCents: 2500,
      items: [{ productId: 'P-1', quantity: 2 }],
    });
    return;
  }
  if (req.method === 'POST' && url === '/orders') {
    sendJson(res, 201, {
      id: 'ORD-9',
      status: 'pending',
      totalCents: 1234,
      items: [{ productId: 'P-9', quantity: 1 }],
    });
    return;
  }
  if (req.method === 'PATCH' && /^\/orders\/[^/]+$/.test(url)) {
    const orderId = decodeURIComponent(url.slice('/orders/'.length));
    sendJson(res, 200, {
      id: orderId,
      status: 'shipped',
      totalCents: 2500,
      items: [{ productId: 'P-1', quantity: 2 }],
    });
    return;
  }
  if (req.method === 'POST' && url === '/uploads') {
    sendJson(res, 201, { id: 'UP-1', filename: 'receipt.pdf', bytes: 4096 });
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

function handleTasks(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url ?? '/';
  if (req.method === 'GET' && url === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }
  if (req.method === 'GET' && url === '/tasks') {
    sendJson(res, 200, [{ id: 1, title: 'Review PR', completed: false, priority: 2 }]);
    return;
  }
  if (req.method === 'POST' && url === '/tasks') {
    sendJson(res, 201, {
      id: 7,
      title: 'New task',
      completed: false,
      priority: 1,
    });
    return;
  }
  if (req.method === 'GET' && /^\/tasks\/\d+$/.test(url)) {
    const taskId = Number(url.slice('/tasks/'.length));
    sendJson(res, 200, {
      id: taskId,
      title: 'Ship it',
      completed: true,
      priority: 4,
    });
    return;
  }
  if (req.method === 'DELETE' && /^\/tasks\/\d+$/.test(url)) {
    res.writeHead(204);
    res.end();
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

async function startUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  records: RecordedRequest[],
): Promise<number> {
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      records.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        rawBody: Buffer.concat(chunks).toString('utf8'),
      });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, '127.0.0.1', () => resolve());
  });
  upstreams.push(upstream);
  const address = upstream.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

interface McpEnvelope {
  status: number;
  body: unknown;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

let nextRequestId = 0;

async function mcpCall(
  payload: Record<string, unknown>,
  token?: string,
): Promise<McpEnvelope> {
  nextRequestId += 1;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`http://127.0.0.1:${port()}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  nextRequestId += 1;
  const envelope = await mcpCall(
    {
      jsonrpc: '2.0',
      id: nextRequestId,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    token,
  );
  expect(envelope.status).toBe(200);
  const body = envelope.body as {
    result?: ToolResult;
    error?: { code: number; message: string };
  };
  if (body.error !== undefined) {
    throw new Error(
      `unexpected JSON-RPC error: ${body.error.code}: ${body.error.message}`,
    );
  }
  expect(body.result).toBeDefined();
  return body.result as ToolResult;
}

function firstText(result: ToolResult): string {
  const block = result.content[0];
  if (block === undefined || block.type !== 'text') return '';
  return block.text;
}

function resultText(result: ToolResult): string {
  return result.content.map((block) => block.text).join('\n');
}

function port(): number {
  if (server === undefined) throw new Error('server not started');
  return server.port;
}

beforeAll(async () => {
  process.env[envName('KEY_PEPPER')] = PEPPER;
  acmeOrdersSecret = 'acme-orders-secret-token';
  globexTasksSecret = 'globex-tasks-secret-token';
  process.env[ACME_ORDERS_TOKEN_ENV] = acmeOrdersSecret;
  process.env[GLOBEX_TASKS_TOKEN_ENV] = globexTasksSecret;

  const acmeKey = generatePorticoKey(PEPPER);
  const globexKey = generatePorticoKey(PEPPER);
  acmeToken = acmeKey.token;
  globexToken = globexKey.token;

  const ordersCatalogFile = path.join(temporary, 'orders-catalog.json');
  const tasksCatalogFile = path.join(temporary, 'tasks-catalog.json');
  fs.copyFileSync(ORDERS_CATALOG_SOURCE, ordersCatalogFile);
  fs.copyFileSync(TASKS_CATALOG_SOURCE, tasksCatalogFile);
  const ordersCatalog = JSON.parse(fs.readFileSync(ordersCatalogFile, 'utf8')) as {
    checksum: string;
  };
  const tasksCatalog = JSON.parse(fs.readFileSync(tasksCatalogFile, 'utf8')) as {
    checksum: string;
  };
  ordersCatalogChecksum = ordersCatalog.checksum;
  tasksCatalogChecksum = tasksCatalog.checksum;

  const ordersPort = await startUpstream(handleOrders, ordersRequests);
  const tasksPort = await startUpstream(handleTasks, tasksRequests);

  const registryFile = path.join(temporary, 'registry.json');
  writeRegistryFile(
    registryFile,
    registryDocument(
      acmeKey,
      globexKey,
      `http://127.0.0.1:${ordersPort}`,
      `http://127.0.0.1:${tasksPort}`,
    ),
    'json',
  );

  server = await startServer({
    host: '127.0.0.1',
    port: 0,
    authMode: 'bearer',
    registryPath: registryFile,
  });
});

afterAll(async () => {
  if (server !== undefined) await server.close();
  for (const upstream of upstreams) {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
  const restore = (name: string, original: string | undefined): void => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  };
  restore(envName('KEY_PEPPER'), originalPepper);
  restore(ACME_ORDERS_TOKEN_ENV, originalAcmeOrdersToken);
  restore(GLOBEX_TASKS_TOKEN_ENV, originalGlobexTasksToken);
  fs.rmSync(temporary, { recursive: true, force: true });
});

describe('multi-tenant multi-backend execution', () => {
  it('negotiates initialization and lists the fixed tools for both tenants', async () => {
    const init = await mcpCall({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.0.0' },
      },
    });
    expect(init.status).toBe(200);
    expect(init.body).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'mcp-portico', version: expect.any(String) },
      },
    });

    const notification = await mcpCall({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(notification.status).toBe(202);
    expect(notification.body).toBeUndefined();

    const expectedTools = [
      'list_connections',
      'select_connection',
      'get_session',
      'search_operations',
      'describe_operation',
      'call_operation',
      'call_operations',
      'test_connection',
    ];
    for (const token of [acmeToken, globexToken]) {
      const list = await mcpCall(
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        token,
      );
      expect(list.status).toBe(200);
      const tools = (list.body as { result: { tools: Array<{ name: string }> } }).result
        .tools;
      expect(tools.map((tool) => tool.name)).toEqual(expectedTools);
    }
  });

  it('executes acme orders end to end: select, describe, GET and POST', async () => {
    const listed = await callTool(acmeToken, 'list_connections');
    const connections = (
      JSON.parse(firstText(listed)) as {
        connections: Array<{ id: string; backendId: string; baseUrl: string }>;
      }
    ).connections;
    expect(connections).toEqual([
      {
        id: 'acme-orders',
        backendId: 'orders-backend',
        baseUrl: expect.stringContaining('127.0.0.1'),
      },
    ]);

    const selected = await callTool(acmeToken, 'select_connection', {
      connectionId: 'acme-orders',
    });
    const session = (
      JSON.parse(firstText(selected)) as {
        session: {
          tenantId: string;
          connectionId: string;
          catalogChecksum: string;
        };
      }
    ).session;
    expect(session).toMatchObject({
      tenantId: 'acme',
      connectionId: 'acme-orders',
    });
    expect(session.catalogChecksum).toBe(ordersCatalogChecksum);

    const described = (
      JSON.parse(
        firstText(
          await callTool(acmeToken, 'describe_operation', {
            operationId: 'orders.get',
          }),
        ),
      ) as { operation: Record<string, unknown> }
    ).operation;
    expect(described).toMatchObject({
      operationId: 'orders.get',
      method: 'GET',
      path: '/orders/{orderId}',
      risk: 'read',
      available: true,
    });

    const list = await callTool(acmeToken, 'call_operation', {
      operationId: 'orders.list',
    });
    expect(list.isError).toBeFalsy();
    expect(resultText(list)).toContain('"id": "ORD-1"');
    expect(resultText(list)).toMatch(/status: 200/);

    const get = await callTool(acmeToken, 'call_operation', {
      operationId: 'orders.get',
      arguments: { orderId: 'ORD-001' },
    });
    expect(get.isError).toBeFalsy();
    expect(resultText(get)).toContain('"id": "ORD-001"');
    expect(resultText(get)).toMatch(/status: 200/);

    const body = {
      customerEmail: 'buyer@example.com',
      items: [{ productId: 'P-1', quantity: 1 }],
    };
    const first = await callTool(acmeToken, 'call_operation', {
      operationId: 'orders.create',
      arguments: { body },
    });
    expect(first.isError).toBeFalsy();
    const confirmation = JSON.parse(firstText(first)) as {
      operationId: string;
      requiresConfirmation: boolean;
      token: string;
      risk: string;
    };
    expect(confirmation).toMatchObject({
      operationId: 'orders.create',
      requiresConfirmation: true,
      risk: 'write',
    });
    expect(confirmation.token.length).toBeGreaterThan(0);

    const second = await callTool(acmeToken, 'call_operation', {
      operationId: 'orders.create',
      arguments: { body },
      confirmationToken: confirmation.token,
    });
    expect(second.isError).toBeFalsy();
    expect(resultText(second)).toContain('"id": "ORD-9"');
    expect(resultText(second)).toMatch(/status: 201/);

    expect(ordersRequests.length).toBeGreaterThanOrEqual(3);
    for (const request of ordersRequests) {
      expect(request.headers.authorization).toBe(`Bearer ${acmeOrdersSecret}`);
    }
    const post = ordersRequests.find(
      (request) => request.method === 'POST' && request.url === '/orders',
    );
    expect(post).toBeDefined();
    if (post !== undefined) {
      expect(JSON.parse(post.rawBody) as unknown).toEqual(body);
    }
    expect(tasksRequests.some((request) => request.url?.startsWith('/orders'))).toBe(
      false,
    );
  });

  it('executes globex tasks end to end: select, describe, GET and POST', async () => {
    const listed = await callTool(globexToken, 'list_connections');
    const connections = (
      JSON.parse(firstText(listed)) as {
        connections: Array<{ id: string; backendId: string; baseUrl: string }>;
      }
    ).connections;
    expect(connections).toEqual([
      {
        id: 'globex-tasks',
        backendId: 'tasks-backend',
        baseUrl: expect.stringContaining('127.0.0.1'),
      },
    ]);

    const selected = await callTool(globexToken, 'select_connection', {
      connectionId: 'globex-tasks',
    });
    const session = (
      JSON.parse(firstText(selected)) as {
        session: {
          tenantId: string;
          connectionId: string;
          catalogChecksum: string;
        };
      }
    ).session;
    expect(session).toMatchObject({
      tenantId: 'globex',
      connectionId: 'globex-tasks',
    });
    expect(session.catalogChecksum).toBe(tasksCatalogChecksum);

    const described = (
      JSON.parse(
        firstText(
          await callTool(globexToken, 'describe_operation', {
            operationId: 'tasks.get',
          }),
        ),
      ) as { operation: Record<string, unknown> }
    ).operation;
    expect(described).toMatchObject({
      operationId: 'tasks.get',
      method: 'GET',
      path: '/tasks/{taskId}',
      risk: 'read',
      available: true,
    });

    const list = await callTool(globexToken, 'call_operation', {
      operationId: 'tasks.list',
    });
    expect(list.isError).toBeFalsy();
    expect(resultText(list)).toContain('"id": 1');
    expect(resultText(list)).toContain('"title": "Review PR"');
    expect(resultText(list)).toMatch(/status: 200/);

    const get = await callTool(globexToken, 'call_operation', {
      operationId: 'tasks.get',
      arguments: { taskId: 3 },
    });
    expect(get.isError).toBeFalsy();
    expect(resultText(get)).toContain('"id": 3');
    expect(resultText(get)).toContain('"title": "Ship it"');
    expect(resultText(get)).toMatch(/status: 200/);

    const body = { title: 'Write integration test' };
    const first = await callTool(globexToken, 'call_operation', {
      operationId: 'tasks.create',
      arguments: { body },
    });
    expect(first.isError).toBeFalsy();
    const confirmation = JSON.parse(firstText(first)) as {
      operationId: string;
      requiresConfirmation: boolean;
      token: string;
      risk: string;
    };
    expect(confirmation).toMatchObject({
      operationId: 'tasks.create',
      requiresConfirmation: true,
      risk: 'write',
    });
    expect(confirmation.token.length).toBeGreaterThan(0);

    const second = await callTool(globexToken, 'call_operation', {
      operationId: 'tasks.create',
      arguments: { body },
      confirmationToken: confirmation.token,
    });
    expect(second.isError).toBeFalsy();
    expect(resultText(second)).toContain('"id": 7');
    expect(resultText(second)).toMatch(/status: 201/);

    expect(tasksRequests.length).toBeGreaterThanOrEqual(3);
    for (const request of tasksRequests) {
      expect(request.headers.authorization).toBe(`Bearer ${globexTasksSecret}`);
    }
    const post = tasksRequests.find(
      (request) => request.method === 'POST' && request.url === '/tasks',
    );
    expect(post).toBeDefined();
    if (post !== undefined) {
      expect(JSON.parse(post.rawBody) as unknown).toEqual(body);
    }
    expect(ordersRequests.some((request) => request.url?.startsWith('/tasks'))).toBe(
      false,
    );
  });

  it('returns identical errors for cross-tenant and unknown connection selection', async () => {
    const acmeCrossTenant = await callTool(acmeToken, 'select_connection', {
      connectionId: 'globex-tasks',
    });
    const acmeUnknown = await callTool(acmeToken, 'select_connection', {
      connectionId: 'no.such.connection',
    });
    expect(acmeCrossTenant.isError).toBe(true);
    expect(acmeUnknown.isError).toBe(true);
    expect(firstText(acmeCrossTenant)).toBe(firstText(acmeUnknown));
    expect(firstText(acmeCrossTenant)).toBe('Invalid credentials.');

    const globexCrossTenant = await callTool(globexToken, 'select_connection', {
      connectionId: 'acme-orders',
    });
    const globexUnknown = await callTool(globexToken, 'select_connection', {
      connectionId: 'no.such.connection',
    });
    expect(globexCrossTenant.isError).toBe(true);
    expect(globexUnknown.isError).toBe(true);
    expect(firstText(globexCrossTenant)).toBe(firstText(globexUnknown));
    expect(firstText(globexCrossTenant)).toBe(firstText(acmeCrossTenant));
  });

  it("does not enumerate another tenant's operations via describe", async () => {
    await callTool(acmeToken, 'select_connection', {
      connectionId: 'acme-orders',
    });
    const acmeForeign = await callTool(acmeToken, 'describe_operation', {
      operationId: 'tasks.get',
    });
    const acmeUnknown = await callTool(acmeToken, 'describe_operation', {
      operationId: 'no.such.operation',
    });
    expect(acmeForeign.isError).toBe(true);
    expect(acmeUnknown.isError).toBe(true);
    expect(firstText(acmeForeign)).toBe(firstText(acmeUnknown));

    await callTool(globexToken, 'select_connection', {
      connectionId: 'globex-tasks',
    });
    const globexForeign = await callTool(globexToken, 'describe_operation', {
      operationId: 'orders.get',
    });
    const globexUnknown = await callTool(globexToken, 'describe_operation', {
      operationId: 'no.such.operation',
    });
    expect(globexForeign.isError).toBe(true);
    expect(globexUnknown.isError).toBe(true);
    expect(firstText(globexForeign)).toBe(firstText(globexUnknown));

    expect(firstText(acmeForeign)).toBe('Operation not found or not authorized.');
    expect(firstText(acmeForeign)).toBe(firstText(globexForeign));
  });

  it('records tenant-namespaced audit events and proves both backends ran', async () => {
    expect(ordersRequests.length).toBeGreaterThan(0);
    expect(tasksRequests.length).toBeGreaterThan(0);

    const acmeAudit = server.context.audit.forTenant('acme');
    const globexAudit = server.context.audit.forTenant('globex');
    expect(acmeAudit.length).toBeGreaterThan(0);
    expect(globexAudit.length).toBeGreaterThan(0);

    for (const event of acmeAudit) {
      expect(event.tenantId).toBe('acme');
      if (event.outcome === 'success' && event.connectionId !== undefined) {
        expect(event.connectionId).toBe('acme-orders');
      }
      if (event.outcome === 'success' && event.backendId !== undefined) {
        expect(event.backendId).toBe('orders-backend');
      }
    }
    for (const event of globexAudit) {
      expect(event.tenantId).toBe('globex');
      if (event.outcome === 'success' && event.connectionId !== undefined) {
        expect(event.connectionId).toBe('globex-tasks');
      }
      if (event.outcome === 'success' && event.backendId !== undefined) {
        expect(event.backendId).toBe('tasks-backend');
      }
    }

    expect(
      acmeAudit.some(
        (event) =>
          event.action === 'call_operation' &&
          event.outcome === 'success' &&
          event.connectionId === 'acme-orders' &&
          event.backendId === 'orders-backend' &&
          event.operation === 'orders.create',
      ),
    ).toBe(true);
    expect(
      globexAudit.some(
        (event) =>
          event.action === 'call_operation' &&
          event.outcome === 'success' &&
          event.connectionId === 'globex-tasks' &&
          event.backendId === 'tasks-backend' &&
          event.operation === 'tasks.create',
      ),
    ).toBe(true);

    expect(
      acmeAudit.some(
        (event) =>
          event.action === 'select_connection' &&
          event.outcome === 'failure' &&
          event.connectionId === 'globex-tasks' &&
          event.errorCode === 'AUTH',
      ),
    ).toBe(true);
    expect(
      globexAudit.some(
        (event) =>
          event.action === 'select_connection' &&
          event.outcome === 'failure' &&
          event.connectionId === 'acme-orders' &&
          event.errorCode === 'AUTH',
      ),
    ).toBe(true);
  });
});
