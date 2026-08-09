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

const PEPPER = 'use-cases-test-pepper';
const SUPPORT_UPSTREAM_TOKEN = 'upstream-secret-support';
const FINANCE_UPSTREAM_KEY = 'upstream-secret-finance';
const IMPORT_NOW = new Date('2026-08-09T00:00:00.000Z');

const USE_CASES = path.join(__dirname, '..', '..', 'examples', 'use-cases');
const SUPPORT_SPEC = path.join(USE_CASES, 'apis', 'support.openapi.yaml');
const SUPPORT_CATALOG = path.join(USE_CASES, 'apis', 'support.catalog.json');
const FINANCE_SPEC = path.join(USE_CASES, 'apis', 'finance.openapi.yaml');
const FINANCE_CATALOG = path.join(USE_CASES, 'apis', 'finance.catalog.json');
const USE_CASE_REGISTRY = path.join(USE_CASES, 'registry.yaml');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'portico-use-cases-test-'));
const originalPepper = process.env[envName('KEY_PEPPER')];

let upstream: http.Server;
let server: RunningServer;
let mcpToken = '';
let lastRequest: {
  method: string;
  url: string;
  authorization: string;
  headers: http.IncomingHttpHeaders;
  body: string;
} = { method: '', url: '', authorization: '', headers: {}, body: '' };
let invoicePosts = 0;

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

async function initializeSession(token: string): Promise<void> {
  const init = await mcpCall(
    {
      jsonrpc: '2.0',
      id: nextRequestId,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'use-cases-test', version: '0.0.0' },
      },
    },
    token,
  );
  expect(init.status).toBe(200);
  const notification = await mcpCall(
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    token,
  );
  expect(notification.status).toBe(202);
}

function registryDocument(
  supportChecksum: string,
  financeChecksum: string,
  key: { keyId: string; digest: string },
  baseUrl: string,
): RegistryDocument {
  return {
    version: 1,
    tenants: [{ id: 'acme', name: 'Acme' }],
    principals: [
      {
        id: 'acme-agent',
        tenantId: 'acme',
        allowedConnectionIds: ['acme-support', 'acme-finance'],
        keyId: key.keyId,
        keyDigest: key.digest,
      },
    ],
    backends: [
      {
        id: 'support',
        title: 'Support Desk API',
        scope: 'global',
        catalogRef: './support-catalog.json',
        catalogChecksum: supportChecksum,
      },
      {
        id: 'finance',
        title: 'Finance API',
        scope: 'global',
        catalogRef: './finance-catalog.json',
        catalogChecksum: financeChecksum,
      },
    ],
    connections: [
      {
        id: 'acme-support',
        tenantId: 'acme',
        backendId: 'support',
        baseUrl,
        network: { allowedProtocols: ['http'], allowLoopback: true },
        auth: { type: 'bearer', tokenRef: 'env:ACME_SUPPORT_TOKEN' },
      },
      {
        id: 'acme-finance',
        tenantId: 'acme',
        backendId: 'finance',
        baseUrl,
        network: { allowedProtocols: ['http'], allowLoopback: true },
        auth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          valueRef: 'env:ACME_FINANCE_KEY',
        },
      },
    ],
  };
}

beforeAll(async () => {
  process.env[envName('KEY_PEPPER')] = PEPPER;
  process.env.ACME_SUPPORT_TOKEN = SUPPORT_UPSTREAM_TOKEN;
  process.env.ACME_FINANCE_KEY = FINANCE_UPSTREAM_KEY;

  const key = generatePorticoKey(PEPPER);
  mcpToken = key.token;

  fs.copyFileSync(SUPPORT_CATALOG, path.join(temporary, 'support-catalog.json'));
  fs.copyFileSync(FINANCE_CATALOG, path.join(temporary, 'finance-catalog.json'));

  upstream = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      lastRequest = {
        method: req.method ?? '',
        url,
        authorization: req.headers.authorization ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      const json = (status: number, data: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.method === 'GET' && url.startsWith('/tickets?')) {
        json(200, [
          {
            id: 'T-1',
            subject: 'Login issue',
            status: 'open',
            priority: 'high',
            customerId: 'C-1',
          },
        ]);
        return;
      }
      if (req.method === 'GET' && url.startsWith('/tickets/')) {
        const ticketId = decodeURIComponent(url.slice('/tickets/'.length));
        json(200, {
          id: ticketId,
          subject: 'Login issue',
          status: 'open',
          customerId: 'C-1',
        });
        return;
      }
      if (req.method === 'GET' && url.startsWith('/customers/')) {
        const customerId = decodeURIComponent(url.slice('/customers/'.length));
        json(200, {
          id: customerId,
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          plan: 'enterprise',
        });
        return;
      }
      if (req.method === 'GET' && url.startsWith('/invoices?')) {
        json(200, [
          {
            id: 'INV-1',
            customerId: 'C-1',
            amount: 120,
            currency: 'USD',
            status: 'open',
          },
        ]);
        return;
      }
      if (req.method === 'POST' && url === '/invoices') {
        invoicePosts += 1;
        const parsed = JSON.parse(lastRequest.body) as {
          customerId?: string;
          amount?: number;
          currency?: string;
        };
        json(201, {
          id: 'INV-2',
          customerId: parsed.customerId,
          amount: parsed.amount,
          currency: parsed.currency,
          status: 'open',
        });
        return;
      }
      if (req.method === 'GET' && url.startsWith('/invoices/')) {
        const invoiceId = decodeURIComponent(url.slice('/invoices/'.length));
        json(200, {
          id: invoiceId,
          customerId: 'C-1',
          amount: 120,
          currency: 'USD',
          status: 'open',
        });
        return;
      }
      if (req.method === 'GET' && url === '/reports/usage') {
        json(200, {
          generatedAt: '2026-08-09T00:00:00.000Z',
          totals: { invoices: 12 },
        });
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
  const upstreamPort =
    typeof address === 'object' && address !== null ? address.port : 0;

  const registryFile = path.join(temporary, 'registry.json');
  writeRegistryFile(
    registryFile,
    registryDocument(
      loadCatalog(SUPPORT_CATALOG).catalog.checksum,
      loadCatalog(FINANCE_CATALOG).catalog.checksum,
      key,
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
  delete process.env.ACME_SUPPORT_TOKEN;
  delete process.env.ACME_FINANCE_KEY;
  fs.rmSync(temporary, { recursive: true, force: true });
});

describe('use-case fixture artifacts', () => {
  it('compiles the support and finance specs into the checked-in catalogs', async () => {
    const support = await importOpenApi(SUPPORT_SPEC, {
      apiId: 'support',
      sourceType: 'openapi',
      now: IMPORT_NOW,
    });
    expect(support.report.api.id).toBe('support');
    expect(Object.keys(support.catalog.operations).sort()).toEqual([
      'customers.get',
      'tickets.get',
      'tickets.list',
    ]);
    expect(loadCatalog(SUPPORT_CATALOG).catalog.checksum).toBe(
      support.catalog.checksum,
    );
    expect(loadCatalog(SUPPORT_CATALOG).catalog.provenance.sourceChecksum).toBe(
      support.catalog.provenance.sourceChecksum,
    );

    const finance = await importOpenApi(FINANCE_SPEC, {
      apiId: 'finance',
      sourceType: 'openapi',
      now: IMPORT_NOW,
    });
    expect(Object.keys(finance.catalog.operations).sort()).toEqual([
      'invoices.get',
      'invoices.list',
      'invoices.post',
      'reports.run',
    ]);
    expect(loadCatalog(FINANCE_CATALOG).catalog.checksum).toBe(
      finance.catalog.checksum,
    );
    expect(loadCatalog(FINANCE_CATALOG).catalog.provenance.sourceChecksum).toBe(
      finance.catalog.provenance.sourceChecksum,
    );
  });

  it('records read risk for support and finance reads and write confirmation for the invoice create', () => {
    const support = loadCatalog(SUPPORT_CATALOG).catalog;
    for (const id of ['tickets.list', 'tickets.get', 'customers.get']) {
      expect(support.operations[id]?.risk).toBe('read');
      expect(support.operations[id]?.confirmation).toBe('never');
    }
    const finance = loadCatalog(FINANCE_CATALOG).catalog;
    for (const id of ['invoices.list', 'invoices.get', 'reports.run']) {
      expect(finance.operations[id]?.risk).toBe('read');
    }
    expect(finance.operations['invoices.post']).toMatchObject({
      risk: 'write',
      confirmation: 'write',
    });
  });

  it('builds the documented use-case registry with matching catalog checksums', () => {
    const snapshot = buildRegistrySnapshot(USE_CASE_REGISTRY);
    expect(snapshot.document.backends.map((backend) => backend.id).sort()).toEqual([
      'finance',
      'support',
    ]);
    expect(snapshot.document.connections).toHaveLength(2);
    for (const backend of snapshot.document.backends) {
      expect(snapshot.catalogForBackend(backend.id)).toBeDefined();
    }
  });
});

describe('documented support-agent flow', () => {
  it('discovers and calls ticket operations through the fixed toolset', async () => {
    await initializeSession(mcpToken);

    const list = await mcpCall(
      { jsonrpc: '2.0', id: nextRequestId, method: 'tools/list' },
      mcpToken,
    );
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

    const selected = await callTool(mcpToken, 'select_connection', {
      connectionId: 'acme-support',
    });
    const session = (
      JSON.parse(firstText(selected)) as { session: { connectionId: string } }
    ).session;
    expect(session.connectionId).toBe('acme-support');

    const search = await callTool(mcpToken, 'search_operations', {
      query: 'ticket',
    });
    const found = (
      JSON.parse(firstText(search)) as {
        operations: Array<{ operationId: string }>;
      }
    ).operations;
    expect(found.map((operation) => operation.operationId).sort()).toEqual([
      'tickets.get',
      'tickets.list',
    ]);

    const listed = await callTool(mcpToken, 'call_operation', {
      operationId: 'tickets.list',
      arguments: { status: 'open', limit: 5 },
    });
    const listedText = listed.content.map((block) => block.text).join('\n');
    expect(listedText).toContain('"subject": "Login issue"');
    expect(listedText).toContain('status: 200');
    expect(lastRequest).toMatchObject({
      method: 'GET',
      url: '/tickets?status=open&limit=5',
      authorization: `Bearer ${SUPPORT_UPSTREAM_TOKEN}`,
    });

    const detail = await callTool(mcpToken, 'call_operation', {
      operationId: 'tickets.get',
      arguments: { ticketId: 'T-1' },
    });
    expect(detail.content.map((block) => block.text).join('\n')).toContain(
      '"id": "T-1"',
    );

    const profile = await callTool(mcpToken, 'call_operation', {
      operationId: 'customers.get',
      arguments: { customerId: 'C-1' },
    });
    const profileText = profile.content.map((block) => block.text).join('\n');
    expect(profileText).toContain('"name": "Ada Lovelace"');
    expect(lastRequest.url).toBe('/customers/C-1');
  });
});

describe('documented finance-agent flow', () => {
  it('reads approved internal data without exposing the backend origin', async () => {
    await initializeSession(mcpToken);
    await callTool(mcpToken, 'select_connection', {
      connectionId: 'acme-finance',
    });

    const described = await callTool(mcpToken, 'describe_operation', {
      operationId: 'invoices.get',
    });
    const describedText = firstText(described);
    expect(JSON.parse(describedText)).toMatchObject({
      operation: { method: 'GET' },
    });
    expect(describedText).not.toContain('127.0.0.1');

    const listed = await callTool(mcpToken, 'call_operation', {
      operationId: 'invoices.list',
      arguments: { status: 'open' },
    });
    const listedText = listed.content.map((block) => block.text).join('\n');
    expect(listedText).toContain('"id": "INV-1"');
    expect(listedText).toContain('status: 200');
    expect(lastRequest).toMatchObject({
      method: 'GET',
      url: '/invoices?status=open',
    });
    expect(lastRequest.headers['x-api-key']).toBe(FINANCE_UPSTREAM_KEY);
  });
});

describe('documented workflow-confirmation flow', () => {
  it('requires a confirmation token before the write reaches the backend', async () => {
    await initializeSession(mcpToken);
    await callTool(mcpToken, 'select_connection', {
      connectionId: 'acme-finance',
    });

    const body = { customerId: 'C-1', amount: 42.5, currency: 'USD' };
    const first = await callTool(mcpToken, 'call_operation', {
      operationId: 'invoices.post',
      arguments: { body },
    });
    const confirmation = JSON.parse(firstText(first)) as {
      operationId: string;
      requiresConfirmation: boolean;
      token: string;
      risk: string;
      message: string;
    };
    expect(confirmation).toMatchObject({
      operationId: 'invoices.post',
      requiresConfirmation: true,
      risk: 'write',
    });
    expect(confirmation.message).toBe(
      'Operation "invoices.post" requires confirmation before execution.',
    );
    expect(confirmation.token.length).toBeGreaterThan(0);
    expect(invoicePosts).toBe(0);

    const second = await callTool(mcpToken, 'call_operation', {
      operationId: 'invoices.post',
      arguments: { body },
      confirmationToken: confirmation.token,
    });
    const secondText = second.content.map((block) => block.text).join('\n');
    expect(secondText).toContain('"id": "INV-2"');
    expect(secondText).toContain('status: 201');
    expect(invoicePosts).toBe(1);
    expect(lastRequest).toMatchObject({ method: 'POST', url: '/invoices' });
    expect(JSON.parse(lastRequest.body) as unknown).toEqual(body);
  });
});
