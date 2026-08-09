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

const PEPPER = 'identity-boundaries-integration-pepper';
const UPSTREAM_TOKEN = 'upstream-token-abc';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'portico-identity-bounds-'));
const originalPepper = process.env[envName('KEY_PEPPER')];
const originalUpstreamToken = process.env.ACME_UPSTREAM_TOKEN;

let upstreamA: http.Server;
let upstreamAPort = 0;
let upstreamB: http.Server;
let upstreamBPort = 0;
let foreignHits = 0;
let seenRequests: Array<{
  url: string;
  headers: Record<string, string | undefined>;
  body: string;
}> = [];

let server: RunningServer;
let registryFile = '';
let acmeToken = '';
let globexToken = '';
let acmeKeyId = '';
let catalogChecksum = '';

function model(): NormalizedApiModel {
  return {
    api: { id: 'invoicing', title: 'Invoicing API', version: '1.0.0' },
    securitySchemes: {},
    operations: [
      {
        operationId: 'invoice.get',
        method: 'GET',
        path: '/invoices/{invoiceId}',
        summary: 'Fetch an invoice',
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
            schema: { type: 'object' },
          },
        },
      },
      {
        operationId: 'invoice.headers',
        method: 'GET',
        path: '/headers',
        summary: 'Echo modeled header parameters',
        parameters: [
          {
            in: 'header',
            name: 'authorization',
            required: false,
            schema: { type: 'string' },
          },
          {
            in: 'header',
            name: 'x-mcp-portico-tenant',
            required: false,
            schema: { type: 'string' },
          },
          {
            in: 'header',
            name: 'x-api-key',
            required: false,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': { description: 'OK', contentTypes: ['application/json'] },
        },
      },
      {
        operationId: 'invoice.create',
        method: 'POST',
        path: '/invoices',
        summary: 'Create an invoice',
        requestBody: {
          contentTypes: ['application/json'],
          required: true,
          schema: {
            type: 'object',
            properties: { amount: { type: 'number' } },
            required: ['amount'],
          },
        },
        responses: {
          '201': { description: 'Created', contentTypes: ['application/json'] },
        },
      },
    ],
  };
}

function registryDocument(
  checksum: string,
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
        catalogChecksum: checksum,
      },
    ],
    connections: [
      {
        id: 'acme-billing',
        tenantId: 'acme',
        backendId: 'billing',
        baseUrl,
        network: { allowedProtocols: ['http'], allowLoopback: true },
        auth: { type: 'bearer', tokenRef: 'env:ACME_UPSTREAM_TOKEN' },
      },
      {
        id: 'globex-billing',
        tenantId: 'globex',
        backendId: 'billing',
        baseUrl,
        network: { allowedProtocols: ['http'], allowLoopback: true },
        auth: { type: 'none' },
      },
    ],
  };
}

function port(): number {
  if (server === undefined) throw new Error('server not started');
  return server.port;
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

async function json(
  url: string,
  token?: string,
): Promise<{ status: number; text: string; body: unknown }> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`http://127.0.0.1:${port()}${url}`, { headers });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = text;
  }
  return { status: response.status, text, body };
}

beforeAll(async () => {
  process.env[envName('KEY_PEPPER')] = PEPPER;
  process.env.ACME_UPSTREAM_TOKEN = UPSTREAM_TOKEN;

  const acmeKey = generatePorticoKey(PEPPER);
  const globexKey = generatePorticoKey(PEPPER);
  acmeToken = acmeKey.token;
  globexToken = globexKey.token;
  acmeKeyId = acmeKey.keyId;

  const { catalog } = compileCatalog(model(), undefined, {
    now: new Date('2026-08-09T00:00:00.000Z'),
  });
  catalogChecksum = catalog.checksum;
  fs.writeFileSync(
    path.join(temporary, 'catalog.json'),
    `${JSON.stringify(catalog, null, 2)}\n`,
    'utf8',
  );

  upstreamA = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seenRequests.push({
        url: req.url ?? '/',
        headers: req.headers as Record<string, string | undefined>,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
  });
  await new Promise<void>((resolve) => {
    upstreamA.listen(0, '127.0.0.1', () => resolve());
  });
  upstreamAPort = (upstreamA.address() as { port: number }).port;

  upstreamB = http.createServer((_req, res) => {
    foreignHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ foreign: true }));
  });
  await new Promise<void>((resolve) => {
    upstreamB.listen(0, '127.0.0.1', () => resolve());
  });
  upstreamBPort = (upstreamB.address() as { port: number }).port;

  registryFile = path.join(temporary, 'registry.json');
  writeRegistryFile(
    registryFile,
    registryDocument(
      catalog.checksum,
      acmeKey,
      globexKey,
      `http://127.0.0.1:${upstreamAPort}`,
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
  if (upstreamA !== undefined) {
    await new Promise<void>((resolve) => upstreamA.close(() => resolve()));
  }
  if (upstreamB !== undefined) {
    await new Promise<void>((resolve) => upstreamB.close(() => resolve()));
  }
  if (originalPepper === undefined) delete process.env[envName('KEY_PEPPER')];
  else process.env[envName('KEY_PEPPER')] = originalPepper;
  if (originalUpstreamToken === undefined) delete process.env.ACME_UPSTREAM_TOKEN;
  else process.env.ACME_UPSTREAM_TOKEN = originalUpstreamToken;
  fs.rmSync(temporary, { recursive: true, force: true });
});

describe('identity boundary enforcement', () => {
  it('rejects tenant, principal, connection, and origin override keys in tool arguments', async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      [
        'select_connection',
        { connectionId: 'acme-billing', tenantId: 'globex' },
        'tenantId',
      ],
      [
        'select_connection',
        { connectionId: 'acme-billing', principalId: 'globex-user' },
        'principalId',
      ],
      [
        'call_operation',
        { operationId: 'invoice.get', arguments: {}, baseUrl: 'https://evil.example/' },
        'baseUrl',
      ],
      [
        'call_operation',
        { operationId: 'invoice.get', arguments: {}, origin: 'https://evil.example/' },
        'origin',
      ],
      [
        'call_operation',
        {
          operationId: 'invoice.get',
          arguments: {},
          connectionId: 'globex-billing',
        },
        'connectionId',
      ],
      ['get_session', { principalId: 'globex-user' }, 'principalId'],
      ['list_connections', { tenantId: 'globex' }, 'tenantId'],
      [
        'test_connection',
        { connectionId: 'acme-billing', backendId: 'other' },
        'backendId',
      ],
    ];
    for (const [toolName, args, key] of cases) {
      const result = await callTool(acmeToken, toolName, args);
      expect(result.isError, `${toolName} ${key}`).toBe(true);
      expect(firstText(result), `${toolName} ${key}`).toContain(
        `Invalid arguments for tool "${toolName}"`,
      );
      expect(firstText(result), `${toolName} ${key}`).toContain(key);
    }
  });

  it('rejects identity override keys inside batch items and operation arguments', async () => {
    const selected = await callTool(acmeToken, 'select_connection', {
      connectionId: 'acme-billing',
    });
    expect(selected.isError).not.toBe(true);

    const batch = await callTool(acmeToken, 'call_operations', {
      operations: [
        {
          operationId: 'invoice.get',
          arguments: { invoiceId: 'INV-1' },
          tenantId: 'globex',
        },
      ],
    });
    expect(batch.isError).toBe(true);
    expect(firstText(batch)).toContain('Invalid arguments for tool "call_operations"');

    const nested = await callTool(acmeToken, 'call_operation', {
      operationId: 'invoice.get',
      arguments: { connectionId: 'globex-billing' },
    });
    expect(nested.isError).toBe(true);
    expect(firstText(nested)).toContain('Unknown argument(s): connectionId.');
  });

  it('rejects test_connection paths that escape the connection origin', async () => {
    const absolute = await callTool(acmeToken, 'test_connection', {
      connectionId: 'acme-billing',
      path: `http://127.0.0.1:${upstreamBPort}/`,
    });
    expect(absolute.isError).toBe(true);
    expect(firstText(absolute)).toContain('outside the connection origin');

    const protocolRelative = await callTool(acmeToken, 'test_connection', {
      connectionId: 'acme-billing',
      path: `//127.0.0.1:${upstreamBPort}/`,
    });
    expect(protocolRelative.isError).toBe(true);
    expect(firstText(protocolRelative)).toContain('outside the connection origin');

    const ok = await callTool(acmeToken, 'test_connection', {
      connectionId: 'acme-billing',
      path: '/',
    });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(firstText(ok))).toMatchObject({ ok: true, status: 200 });
    expect(foreignHits).toBe(0);
  });

  it('still rejects cross-tenant connection selection from the credential', async () => {
    const denied = await callTool(globexToken, 'select_connection', {
      connectionId: 'acme-billing',
    });
    expect(denied.isError).toBe(true);
    expect(firstText(denied)).toBe('Invalid credentials.');
  });
});

describe('credential separation', () => {
  it('never lets client-supplied headers replace the connection credential', async () => {
    await callTool(acmeToken, 'select_connection', {
      connectionId: 'acme-billing',
    });
    const before = seenRequests.length;
    const result = await callTool(acmeToken, 'call_operation', {
      operationId: 'invoice.headers',
      arguments: {
        authorization: `Bearer ${acmeToken}`,
        'x-mcp-portico-tenant': 'globex',
        'x-api-key': 'client-supplied-key',
      },
    });
    expect(result.isError).toBeFalsy();

    const request = seenRequests[seenRequests.length - 1];
    expect(request?.url).toBe('/headers');
    // The connection's own upstream credential wins; the client-supplied
    // authorization value and Portico identity headers never reach upstream.
    expect(request?.headers.authorization).toBe(`Bearer ${UPSTREAM_TOKEN}`);
    expect(request?.headers['x-mcp-portico-tenant']).toBeUndefined();
    // Catalog-modeled upstream parameters still pass through.
    expect(request?.headers['x-api-key']).toBe('client-supplied-key');
    expect(seenRequests.length).toBe(before + 1);
  });
});

describe('origin integrity', () => {
  it('keeps absolute-looking path parameter values on the connection origin', async () => {
    await callTool(acmeToken, 'select_connection', {
      connectionId: 'acme-billing',
    });
    const before = seenRequests.length;
    const result = await callTool(acmeToken, 'call_operation', {
      operationId: 'invoice.get',
      arguments: { invoiceId: `http://127.0.0.1:${upstreamBPort}/evil` },
    });
    expect(result.isError).toBeFalsy();
    const request = seenRequests[seenRequests.length - 1];
    expect(request?.url).toBe(
      `/invoices/http%3A%2F%2F127.0.0.1%3A${upstreamBPort}%2Fevil`,
    );
    expect(seenRequests.length).toBe(before + 1);
    expect(foreignHits).toBe(0);
  });
});

describe('audit and inspector isolation', () => {
  it('records client, tenant, principal, connection, backend, checksum, operation, and outcome', () => {
    const authenticate = server.context.audit
      .all()
      .find((event) => event.action === 'authenticate' && event.outcome === 'success');
    expect(authenticate).toMatchObject({
      clientId: acmeKeyId,
      tenantId: 'acme',
      principalId: 'acme-user',
    });

    const call = server.context.audit
      .all()
      .find((event) => event.action === 'call_operation');
    expect(call).toMatchObject({
      clientId: acmeKeyId,
      tenantId: 'acme',
      principalId: 'acme-user',
      connectionId: 'acme-billing',
      backendId: 'billing',
      catalogChecksum: catalogChecksum,
      operation: expect.any(String),
      outcome: expect.stringMatching(/^(success|failure)$/),
    });

    const serialized = JSON.stringify(server.context.audit.all());
    expect(serialized).not.toContain(acmeToken);
    expect(serialized).not.toContain(globexToken);
    expect(serialized).not.toContain(UPSTREAM_TOKEN);
  });

  it('scopes inspector queries to the authenticated tenant', async () => {
    const overview = await json('/inspector/api/overview', acmeToken);
    expect(overview.status).toBe(200);
    expect(overview.text).toContain('acme-billing');
    expect(overview.text).not.toContain('globex-billing');

    const audit = await json('/inspector/api/audit', acmeToken);
    expect(audit.status).toBe(200);
    const events = (audit.body as { events: Array<{ tenantId?: string }> }).events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.tenantId === 'acme')).toBe(true);
    expect(audit.text).not.toContain('globex-billing');
  });
});
