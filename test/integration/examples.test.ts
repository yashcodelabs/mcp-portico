import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from '../../src/cli/serve';
import { loadCatalog } from '../../src/catalog/load';
import { generatePorticoKey } from '../../src/identity/keys';
import { importOpenApi } from '../../src/importers/openapi/import';
import { writeRegistryFile } from '../../src/registry/load';
import { buildRegistrySnapshot } from '../../src/registry/snapshot';
import type { RegistryDocument } from '../../src/registry/types';
import { envName } from '../../src/shared/brand';

const PEPPER = 'examples-test-pepper';
const ACME_UPSTREAM_TOKEN = 'upstream-secret-acme';
const GLOBEX_UPSTREAM_KEY = 'upstream-secret-globex';
const IMPORT_NOW = new Date('2026-08-08T00:00:00.000Z');

const EXAMPLES = path.join(__dirname, '..', '..', 'examples');
const PETSTORE_SPEC = path.join(EXAMPLES, 'apis', 'petstore.openapi.yaml');
const PETSTORE_CATALOG = path.join(EXAMPLES, 'apis', 'petstore.catalog.json');
const BILLING_CATALOG = path.join(EXAMPLES, 'sample-catalog.json');
const SAMPLE_REGISTRY = path.join(EXAMPLES, 'sample-registry.yaml');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'portico-examples-test-'));
const originalPepper = process.env[envName('KEY_PEPPER')];

let upstream: http.Server;
let upstreamPort = 0;
let server: RunningServer;
let acmeToken = '';
let globexToken = '';
let lastRequest: {
  method: string;
  url: string;
  authorization: string;
  body: string;
} = { method: '', url: '', authorization: '', body: '' };

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

function registryDocument(
  petstoreChecksum: string,
  billingChecksum: string,
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
        allowedConnectionIds: ['acme-petstore'],
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
        id: 'petstore',
        title: 'Petstore Lite API',
        scope: 'global',
        catalogRef: './petstore-catalog.json',
        catalogChecksum: petstoreChecksum,
      },
      {
        id: 'billing',
        title: 'Billing API',
        scope: 'global',
        catalogRef: './billing-catalog.json',
        catalogChecksum: billingChecksum,
      },
    ],
    connections: [
      {
        id: 'acme-petstore',
        tenantId: 'acme',
        backendId: 'petstore',
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
        auth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          valueRef: 'env:GLOBEX_UPSTREAM_KEY',
        },
      },
    ],
  };
}

beforeAll(async () => {
  process.env[envName('KEY_PEPPER')] = PEPPER;
  process.env.ACME_UPSTREAM_TOKEN = ACME_UPSTREAM_TOKEN;
  process.env.GLOBEX_UPSTREAM_KEY = GLOBEX_UPSTREAM_KEY;

  const acmeKey = generatePorticoKey(PEPPER);
  const globexKey = generatePorticoKey(PEPPER);
  acmeToken = acmeKey.token;
  globexToken = globexKey.token;

  fs.copyFileSync(PETSTORE_CATALOG, path.join(temporary, 'petstore-catalog.json'));
  fs.copyFileSync(BILLING_CATALOG, path.join(temporary, 'billing-catalog.json'));

  upstream = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const authorization = req.headers.authorization ?? '';
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      lastRequest = {
        method: req.method ?? '',
        url,
        authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      if (req.method === 'GET' && (url === '/pets' || url.startsWith('/pets?'))) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify([
            { id: 1, name: 'Rex', tag: 'dog' },
            { id: 2, name: 'Milo', tag: 'cat' },
          ]),
        );
        return;
      }
      if (req.method === 'POST' && url === '/pets') {
        const parsed = JSON.parse(lastRequest.body) as {
          name: string;
          tag?: string;
        };
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 3, name: parsed.name, tag: parsed.tag }));
        return;
      }
      if (req.method === 'GET' && url.startsWith('/pets/')) {
        const petId = decodeURIComponent(url.slice('/pets/'.length));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: petId, name: 'Rex', tag: 'dog' }));
        return;
      }
      if (req.method === 'DELETE' && url.startsWith('/pets/')) {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'GET' && url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
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
      loadCatalog(PETSTORE_CATALOG).catalog.checksum,
      loadCatalog(BILLING_CATALOG).catalog.checksum,
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
  delete process.env.ACME_UPSTREAM_TOKEN;
  delete process.env.GLOBEX_UPSTREAM_KEY;
  fs.rmSync(temporary, { recursive: true, force: true });
});

describe('documented walkthrough artifacts', () => {
  it('imports the petstore spec into a deterministic catalog matching the checked-in artifact', async () => {
    const { catalog, report } = await importOpenApi(PETSTORE_SPEC, {
      apiId: 'petstore',
      sourceType: 'openapi',
      now: IMPORT_NOW,
    });
    expect(report.api.id).toBe('petstore');
    expect(report.summary.operations).toBe(5);
    expect(Object.keys(catalog.operations).sort()).toEqual([
      'health.get',
      'pets.create',
      'pets.delete',
      'pets.get',
      'pets.list',
    ]);
    expect(catalog.securitySchemes.bearerAuth).toEqual({
      type: 'http',
      scheme: 'bearer',
    });
    expect(catalog.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);

    const checkedIn = loadCatalog(PETSTORE_CATALOG).catalog;
    expect(checkedIn.checksum).toBe(catalog.checksum);
  });

  it('loads the checked-in petstore catalog with the documented operations', () => {
    const { catalog, index } = loadCatalog(PETSTORE_CATALOG);
    expect(index.ids().sort()).toEqual([
      'health.get',
      'pets.create',
      'pets.delete',
      'pets.get',
      'pets.list',
    ]);
    expect(catalog.operations['pets.list']?.security[0]).toEqual(['bearerAuth']);
    expect(catalog.operations['pets.create']?.risk).toBe('write');
    expect(catalog.operations['pets.delete']?.risk).toBe('destructive');
    expect(catalog.operations['health.get']?.security).toEqual([]);
  });

  it('builds a snapshot from the sample registry, proving every pinned checksum matches', () => {
    const snapshot = buildRegistrySnapshot(SAMPLE_REGISTRY);
    expect(snapshot.document.tenants.map((tenant) => tenant.id).sort()).toEqual([
      'acme',
      'globex',
    ]);
    expect(snapshot.document.backends.map((backend) => backend.id).sort()).toEqual([
      'billing',
      'petstore',
    ]);
    expect(snapshot.document.connections).toHaveLength(7);
    const authTypes = new Set(
      snapshot.document.connections.map((connection) => connection.auth.type),
    );
    expect([...authTypes].sort()).toEqual([
      'apiKey',
      'basic',
      'bearer',
      'none',
      'staticHeaders',
    ]);
    expect(
      snapshot.document.connections.filter(
        (connection) => connection.auth.type === 'bearer',
      ),
    ).toHaveLength(2);
    for (const backend of snapshot.document.backends) {
      expect(snapshot.catalogForBackend(backend.id)).toBeDefined();
    }
  });
});

describe('documented MCP session', () => {
  it('drives initialize, tools/list, select_connection, and call_operation against the loopback petstore', async () => {
    const init = await mcpCall(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'examples-test', version: '0.0.0' },
        },
      },
      acmeToken,
    );
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

    const notification = await mcpCall(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      acmeToken,
    );
    expect(notification.status).toBe(202);

    const list = await mcpCall(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      acmeToken,
    );
    expect(list.status).toBe(200);
    const tools = (list.body as { result: { tools: Array<{ name: string }> } }).result
      .tools;
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

    const selected = await callTool(acmeToken, 'select_connection', {
      connectionId: 'acme-petstore',
    });
    const session = (
      JSON.parse(firstText(selected)) as {
        session: { tenantId: string; connectionId: string };
      }
    ).session;
    expect(session).toMatchObject({
      tenantId: 'acme',
      connectionId: 'acme-petstore',
    });

    const listed = await callTool(acmeToken, 'call_operation', {
      operationId: 'pets.list',
      arguments: { limit: 2 },
    });
    expect(listed.isError).toBeFalsy();
    const listedText = listed.content.map((block) => block.text).join('\n');
    expect(listedText).toContain('"name": "Rex"');
    expect(listedText).toContain('"name": "Milo"');
    expect(listedText).toContain('status: 200');
    expect(lastRequest).toMatchObject({
      method: 'GET',
      url: '/pets?limit=2',
      authorization: `Bearer ${ACME_UPSTREAM_TOKEN}`,
    });

    const body = { name: 'Rex', tag: 'dog' };
    const first = await callTool(acmeToken, 'call_operation', {
      operationId: 'pets.create',
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
      operationId: 'pets.create',
      requiresConfirmation: true,
      risk: 'write',
    });
    expect(confirmation.token.length).toBeGreaterThan(0);

    const second = await callTool(acmeToken, 'call_operation', {
      operationId: 'pets.create',
      arguments: { body },
      confirmationToken: confirmation.token,
    });
    expect(second.isError).toBeFalsy();
    const createdText = second.content.map((block) => block.text).join('\n');
    expect(createdText).toContain('"name": "Rex"');
    expect(createdText).toContain('status: 201');
    expect(lastRequest).toMatchObject({
      method: 'POST',
      url: '/pets',
      authorization: `Bearer ${ACME_UPSTREAM_TOKEN}`,
    });
    expect(JSON.parse(lastRequest.body) as unknown).toEqual(body);
  });

  it('keeps tenant sessions isolated with non-enumerating errors', async () => {
    const crossTenant = await callTool(globexToken, 'select_connection', {
      connectionId: 'acme-petstore',
    });
    const unknown = await callTool(globexToken, 'select_connection', {
      connectionId: 'no-such-connection',
    });
    expect(crossTenant.isError).toBe(true);
    expect(unknown.isError).toBe(true);
    expect(firstText(crossTenant)).toBe(firstText(unknown));
    expect(firstText(crossTenant)).toBe('Invalid credentials.');

    await callTool(globexToken, 'select_connection', {
      connectionId: 'globex-billing',
    });
    const denied = await callTool(globexToken, 'describe_operation', {
      operationId: 'pets.list',
    });
    const acmeUnknown = await callTool(acmeToken, 'describe_operation', {
      operationId: 'no.such.operation',
    });
    expect(denied.isError).toBe(true);
    expect(firstText(denied)).toBe(firstText(acmeUnknown));
    expect(firstText(denied)).toBe('Operation not found or not authorized.');
  });

  it('serves the tenant-scoped inspector documented in the walkthrough', async () => {
    const shell = await fetch(`http://127.0.0.1:${port()}/inspector`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('MCP Portico inspector');

    const overview = await fetch(`http://127.0.0.1:${port()}/inspector/api/overview`, {
      headers: { authorization: `Bearer ${acmeToken}` },
    });
    expect(overview.status).toBe(200);
    const body = (await overview.json()) as {
      tenant: { id: string };
      connections: Array<{ id: string }>;
    };
    expect(body.tenant.id).toBe('acme');
    expect(body.connections.map((connection) => connection.id)).toEqual([
      'acme-petstore',
    ]);
  });
});
