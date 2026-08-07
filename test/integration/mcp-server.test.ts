import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from '../../src/cli/serve';
import { compileCatalog } from '../../src/catalog/compile';
import type { NormalizedApiModel } from '../../src/catalog/types';
import { generatePorticoKey } from '../../src/identity/keys';
import { writeRegistryFile } from '../../src/registry/load';
import type { RegistryDocument } from '../../src/registry/types';
import { envName } from '../../src/shared/brand';

const PEPPER = 'test-pepper';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'portico-mcp-test-'));
const originalPepper = process.env[envName('KEY_PEPPER')];

let upstream: http.Server;
let upstreamPort = 0;
let lastPostRaw = '';
let server: RunningServer;
let acmeToken = '';
let globexToken = '';

function acmeModel(): NormalizedApiModel {
  return {
    api: { id: 'invoicing', title: 'Invoicing API', version: '1.0.0' },
    securitySchemes: {},
    operations: [
      {
        operationId: 'invoice.get',
        method: 'GET',
        path: '/invoices/{invoiceId}',
        summary: 'Fetch an invoice',
        description: 'Returns a single invoice by id.',
        tags: ['invoices'],
        parameters: [
          {
            in: 'path',
            name: 'invoiceId',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'OK',
            contentTypes: ['application/json'],
            schema: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                total: { type: 'number' },
              },
            },
          },
        },
      },
      {
        operationId: 'invoice.create',
        method: 'POST',
        path: '/invoices',
        summary: 'Create an invoice',
        description: 'Creates a new invoice.',
        tags: ['invoices'],
        requestBody: {
          contentTypes: ['application/json'],
          required: true,
          schema: {
            type: 'object',
            properties: {
              amount: { type: 'number' },
              currency: { type: 'string' },
            },
            required: ['amount'],
          },
        },
        responses: {
          '201': {
            description: 'Created',
            contentTypes: ['application/json'],
            schema: {
              type: 'object',
              properties: {
                created: { type: 'boolean' },
                received: { type: 'string' },
              },
            },
          },
        },
      },
      {
        operationId: 'invoice.delete',
        method: 'DELETE',
        path: '/invoices/{invoiceId}',
        summary: 'Delete an invoice',
        tags: ['invoices'],
        parameters: [
          {
            in: 'path',
            name: 'invoiceId',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: { '204': { description: 'Deleted' } },
      },
    ],
  };
}

/** Globex catalog: a different API so acme operations are "unknown" there. */
function globexModel(): NormalizedApiModel {
  return {
    api: { id: 'globex-api', title: 'Globex API', version: '1.0.0' },
    securitySchemes: {},
    operations: [
      {
        operationId: 'widget.list',
        method: 'GET',
        path: '/widgets',
        summary: 'List widgets',
        tags: ['widgets'],
        responses: {
          '200': {
            description: 'OK',
            contentTypes: ['application/json'],
          },
        },
      },
    ],
  };
}

function registryDocument(
  acmeCatalogChecksum: string,
  globexCatalogChecksum: string,
  acmeKey: { keyId: string; digest: string },
  globexKey: { keyId: string; digest: string },
  baseUrl: string,
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
        allowedConnectionIds: ['acme-billing'],
        keyId: acmeKey.keyId,
        keyDigest: acmeKey.digest,
      },
      {
        id: 'globex-user',
        tenantId: 'globex',
        allowedConnectionIds: ['globex-billing'],
        keyId: globexKey.keyId,
        keyDigest: globexKey.digest,
      },
    ],
    backends: [
      {
        id: 'billing',
        title: 'Billing API',
        scope: 'global',
        catalogRef: './catalog.json',
        catalogChecksum: acmeCatalogChecksum,
      },
      {
        id: 'globex-backend',
        title: 'Globex API',
        scope: 'global',
        catalogRef: './globex-catalog.json',
        catalogChecksum: globexCatalogChecksum,
      },
    ],
    connections: [
      {
        id: 'acme-billing',
        tenantId: 'acme',
        backendId: 'billing',
        baseUrl,
        network: { allowedProtocols: ['http'], allowLoopback: true },
        auth: { type: 'none' },
      },
      {
        id: 'globex-billing',
        tenantId: 'globex',
        backendId: 'globex-backend',
        baseUrl,
        network: { allowedProtocols: ['http'], allowLoopback: true },
        auth: { type: 'none' },
      },
    ],
  };
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

function port(): number {
  if (server === undefined) throw new Error('server not started');
  return server.port;
}

beforeAll(async () => {
  process.env[envName('KEY_PEPPER')] = PEPPER;

  const acmeKey = generatePorticoKey(PEPPER);
  const globexKey = generatePorticoKey(PEPPER);
  acmeToken = acmeKey.token;
  globexToken = globexKey.token;

  const acmeCatalog = compileCatalog(acmeModel(), undefined, {
    now: new Date('2026-08-07T00:00:00.000Z'),
  }).catalog;
  const globexCatalog = compileCatalog(globexModel(), undefined, {
    now: new Date('2026-08-07T00:00:00.000Z'),
  }).catalog;
  fs.writeFileSync(
    path.join(temporary, 'catalog.json'),
    `${JSON.stringify(acmeCatalog, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(temporary, 'globex-catalog.json'),
    `${JSON.stringify(globexCatalog, null, 2)}\n`,
    'utf8',
  );

  upstream = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && url === '/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'up' }));
      return;
    }
    if (req.method === 'GET' && url.startsWith('/invoices/')) {
      const invoiceId = decodeURIComponent(url.slice('/invoices/'.length));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: invoiceId, total: 42 }));
      return;
    }
    if (req.method === 'POST' && url === '/invoices') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        lastPostRaw = Buffer.concat(chunks).toString('utf8');
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ created: true, received: lastPostRaw }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, '127.0.0.1', () => resolve());
  });
  const address = upstream.address();
  upstreamPort = typeof address === 'object' && address !== null ? address.port : 0;

  const registryFile = path.join(temporary, 'registry.json');
  writeRegistryFile(
    registryFile,
    registryDocument(
      acmeCatalog.checksum,
      globexCatalog.checksum,
      acmeKey,
      globexKey,
      `http://127.0.0.1:${upstreamPort}`,
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
  if (upstream !== undefined) {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
  if (originalPepper === undefined) delete process.env[envName('KEY_PEPPER')];
  else process.env[envName('KEY_PEPPER')] = originalPepper;
  fs.rmSync(temporary, { recursive: true, force: true });
});

describe('MCP server transport', () => {
  it('negotiates initialization and lists the 8 fixed tools', async () => {
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

    const list = await mcpCall(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      acmeToken,
    );
    expect(list.status).toBe(200);
    const tools = (list.body as { result: { tools: Array<{ name: string }> } }).result
      .tools;
    expect(tools).toHaveLength(8);
    expect(tools.map((tool) => tool.name)).toEqual([
      'list_connections',
      'select_connection',
      'get_session',
      'search_operations',
      'describe_operation',
      'call_operation',
      'call_operations',
      'test_connection',
    ]);
  });

  it('returns JSON-RPC errors for malformed and unknown requests', async () => {
    const raw = await fetch(`http://127.0.0.1:${port()}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(raw.status).toBe(400);
    expect(await raw.json()).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700 },
    });

    const unknown = await mcpCall(
      { jsonrpc: '2.0', id: 99, method: 'bogus/method' },
      acmeToken,
    );
    expect(unknown.status).toBe(200);
    expect(unknown.body).toMatchObject({
      jsonrpc: '2.0',
      id: 99,
      error: { code: -32601 },
    });
  });

  it('rejects invalid credentials and cross-tenant selection', async () => {
    const bad = await mcpCall(
      { jsonrpc: '2.0', id: 10, method: 'tools/list' },
      'mpp_deadbeefdeadbeef_short',
    );
    expect(bad.status).toBe(401);
    expect(bad.body).toMatchObject({
      jsonrpc: '2.0',
      id: 10,
      error: { code: -32001, message: 'Invalid credentials.' },
    });

    const denied = await callTool(globexToken, 'select_connection', {
      connectionId: 'acme-billing',
    });
    expect(denied.isError).toBe(true);
    expect(firstText(denied)).toBe('Invalid credentials.');
  });

  it('requires an active session before session-scoped tools', async () => {
    const result = await callTool(globexToken, 'get_session');
    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe('No active session; select a connection first.');
  });

  it('discovers, selects, and inspects a connection session', async () => {
    const listed = await callTool(acmeToken, 'list_connections');
    const connections = (
      JSON.parse(firstText(listed)) as {
        connections: Array<{
          id: string;
          backendId: string;
          baseUrl: string;
        }>;
      }
    ).connections;
    expect(connections).toEqual([
      {
        id: 'acme-billing',
        backendId: 'billing',
        baseUrl: expect.stringContaining('127.0.0.1'),
      },
    ]);

    const selected = await callTool(acmeToken, 'select_connection', {
      connectionId: 'acme-billing',
    });
    const session = (
      JSON.parse(firstText(selected)) as {
        session: {
          id: string;
          tenantId: string;
          connectionId: string;
          catalogChecksum: string;
        };
      }
    ).session;
    expect(session).toMatchObject({
      tenantId: 'acme',
      connectionId: 'acme-billing',
    });
    expect(session.id).toEqual(expect.any(String));
    expect(session.catalogChecksum).toEqual(expect.any(String));

    const current = (
      JSON.parse(firstText(await callTool(acmeToken, 'get_session'))) as {
        session: { id: string };
      }
    ).session;
    expect(current.id).toBe(session.id);

    const byTag = (
      JSON.parse(
        firstText(await callTool(acmeToken, 'search_operations', { tag: 'invoices' })),
      ) as { operations: Array<{ operationId: string }> }
    ).operations;
    expect(byTag.map((operation) => operation.operationId).sort()).toEqual([
      'invoice.create',
      'invoice.delete',
      'invoice.get',
    ]);

    const byQuery = (
      JSON.parse(
        firstText(await callTool(acmeToken, 'search_operations', { query: 'fetch' })),
      ) as { operations: Array<{ operationId: string }> }
    ).operations;
    expect(byQuery.map((operation) => operation.operationId)).toEqual(['invoice.get']);

    const described = (
      JSON.parse(
        firstText(
          await callTool(acmeToken, 'describe_operation', {
            operationId: 'invoice.get',
          }),
        ),
      ) as { operation: Record<string, unknown> }
    ).operation;
    expect(described).toMatchObject({
      operationId: 'invoice.get',
      method: 'GET',
      path: '/invoices/{invoiceId}',
      risk: 'read',
      available: true,
    });
  });

  it('executes a read operation and returns the upstream JSON', async () => {
    const result = await callTool(acmeToken, 'call_operation', {
      operationId: 'invoice.get',
      arguments: { invoiceId: 'INV-001' },
    });
    expect(result.isError).toBeFalsy();
    const text = result.content.map((block) => block.text).join('\n');
    expect(text).toContain('"id": "INV-001"');
    expect(text).toContain('"total": 42');
    expect(text).toMatch(/status: 200/);
  });

  it('requires confirmation for write operations and executes with the token', async () => {
    const body = { amount: 12.5, currency: 'USD' };
    const first = await callTool(acmeToken, 'call_operation', {
      operationId: 'invoice.create',
      arguments: { body },
    });
    expect(first.isError).toBeFalsy();
    const confirmation = JSON.parse(firstText(first)) as {
      operationId: string;
      requiresConfirmation: boolean;
      token: string;
      risk: string;
      message: string;
    };
    expect(confirmation).toMatchObject({
      operationId: 'invoice.create',
      requiresConfirmation: true,
      risk: 'write',
    });
    expect(typeof confirmation.token).toBe('string');
    expect(confirmation.token.length).toBeGreaterThan(0);

    const second = await callTool(acmeToken, 'call_operation', {
      operationId: 'invoice.create',
      arguments: { body },
      confirmationToken: confirmation.token,
    });
    expect(second.isError).toBeFalsy();
    const text = second.content.map((block) => block.text).join('\n');
    expect(text).toContain('"created": true');
    expect(JSON.parse(lastPostRaw) as unknown).toEqual(body);
  });

  it('runs a bounded batch with per-item failures', async () => {
    const result = await callTool(acmeToken, 'call_operations', {
      operations: [
        { operationId: 'invoice.get', arguments: { invoiceId: 'INV-002' } },
        { operationId: 'no.such.operation' },
      ],
    });
    expect(result.isError).toBeFalsy();
    const batch = JSON.parse(firstText(result)) as {
      failed: number;
      results: Array<{
        index: number;
        operationId: string;
        result?: unknown;
        error?: { code: string; message: string };
      }>;
    };
    expect(batch.failed).toBe(1);
    expect(batch.results).toHaveLength(2);
    expect(batch.results[0]).toMatchObject({
      index: 0,
      operationId: 'invoice.get',
    });
    expect(batch.results[0]?.result).toBeDefined();
    expect(batch.results[1]).toMatchObject({
      index: 1,
      operationId: 'no.such.operation',
    });
    expect(batch.results[1]?.error).toEqual({
      code: 'NOT_FOUND',
      message: 'Operation not found or not authorized.',
    });
  });

  it('probes a connection under its network policy', async () => {
    const result = await callTool(acmeToken, 'test_connection', {
      connectionId: 'acme-billing',
      path: '/',
    });
    expect(result.isError).toBeFalsy();
    const probe = JSON.parse(firstText(result)) as {
      ok: boolean;
      status: number;
      durationMs: number;
      bytes: number;
      finalUrl: string;
      truncated: boolean;
      redirected: boolean;
    };
    expect(probe).toMatchObject({ ok: true, status: 200 });
    expect(probe.durationMs).toEqual(expect.any(Number));
    expect(probe.bytes).toBeGreaterThan(0);
    expect(probe.finalUrl).toContain('127.0.0.1');
  });

  it('returns the same generic message for unknown and unauthorized operations', async () => {
    const acmeUnknown = await callTool(acmeToken, 'describe_operation', {
      operationId: 'no.such.operation',
    });
    expect(acmeUnknown.isError).toBe(true);
    expect(firstText(acmeUnknown)).toBe('Operation not found or not authorized.');

    // Globex can select its own connection, but acme's invoice.get is not in
    // its catalog: the message must not reveal that the operation exists.
    await callTool(globexToken, 'select_connection', {
      connectionId: 'globex-billing',
    });
    const globexDenied = await callTool(globexToken, 'describe_operation', {
      operationId: 'invoice.get',
    });
    expect(globexDenied.isError).toBe(true);
    expect(firstText(globexDenied)).toBe(firstText(acmeUnknown));
  });
});
