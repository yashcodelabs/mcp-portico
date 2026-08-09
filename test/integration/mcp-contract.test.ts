/**
 * Deterministic MCP interoperability contract tests (roadmap P2.2).
 *
 * The suite is client-neutral: every scenario is driven by hand-written
 * JSON-RPC messages against fixture backends started in-process, with fixed
 * request ids and stable assertions. It never depends on a model provider,
 * agent framework, vendor UI, or MCP SDK.
 *
 * Each scenario runs against every supported transport profile:
 * - direct-http:  client -> Portico over plain loopback HTTP (local);
 * - proxied-http: client -> in-test reverse proxy -> Portico (remote
 *   deployment topology with a TLS-terminating intermediary).
 *
 * Coverage: initialization, capability negotiation, discovery, calls,
 * errors, cancellation/session cleanup, request ordering, pagination-sized
 * requests, unknown optional fields, and non-enumerating authorization
 * failures, plus binary responses, attachments, confirmations, bulk calls,
 * and upstream failures that the contract specifies.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from '../../src/cli/serve';
import { CATALOG_CHECKSUM_EXCLUDE, checksum } from '../../src/catalog/canonical';
import type { Catalog, CatalogOperation } from '../../src/catalog/types';
import { generatePorticoKey } from '../../src/identity/keys';
import { writeRegistryFile } from '../../src/registry/load';
import type { NetworkPolicy, RegistryDocument } from '../../src/registry/types';
import { envName } from '../../src/shared/brand';

const PEPPER = 'mcp-contract-test-pepper';
const TEMPORARY = fs.mkdtempSync(path.join(os.tmpdir(), 'portico-mcp-contract-'));
const ORIGINAL_PEPPER = process.env[envName('KEY_PEPPER')];

const BINARY_PAYLOAD = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
]);

const FIXED_TOOL_NAMES = [
  'list_connections',
  'select_connection',
  'get_session',
  'search_operations',
  'describe_operation',
  'call_operation',
  'call_operations',
  'test_connection',
] as const;

const PROFILES = [{ name: 'direct-http' }, { name: 'proxied-http' }] as const;

interface PrincipalKeys {
  keyId: string;
  digest: string;
  token: string;
}

const KEYS: Record<string, PrincipalKeys> = {
  acme: generatePorticoKey(PEPPER),
  globex: generatePorticoKey(PEPPER),
  fresh: generatePorticoKey(PEPPER),
  reload: generatePorticoKey(PEPPER),
  revoke: generatePorticoKey(PEPPER),
};

type OperationSeed = Omit<
  CatalogOperation,
  'method' | 'path' | 'risk' | 'confirmation'
>;

const BASE_OPERATION: OperationSeed = {
  enabled: true,
  available: true,
  timeoutMs: 30_000,
  maxRequestBytes: 10 * 1024 * 1024,
  maxResponseBytes: 10 * 1024 * 1024,
  maxConcurrency: 4,
  security: [],
};

/** Acme contract catalog: reads, writes, deletes, binary, multipart, failures. */
function contractCatalog(): Catalog {
  const catalog: Catalog = {
    catalogVersion: '2.0',
    api: { id: 'contract-api', title: 'Contract API', version: '1.0.0' },
    provenance: { sourceType: 'manual' },
    checksum: '',
    securitySchemes: {},
    operations: {
      'widget.get': {
        ...BASE_OPERATION,
        method: 'GET',
        path: '/widgets/{widgetId}',
        risk: 'read',
        confirmation: 'never',
        summary: 'Fetch a widget',
        description: 'Returns one widget by id.',
        tags: ['widgets'],
        request: {
          parameters: {
            path: [
              {
                in: 'path',
                name: 'widgetId',
                required: true,
                schema: { type: 'string' },
              },
            ],
          },
        },
        responses: {
          '200': { description: 'OK', contentTypes: ['application/json'] },
        },
      },
      'widget.create': {
        ...BASE_OPERATION,
        method: 'POST',
        path: '/widgets',
        risk: 'write',
        confirmation: 'write',
        summary: 'Create a widget',
        description: 'Creates a new widget.',
        tags: ['widgets'],
        request: {
          body: {
            kind: 'json',
            contentTypes: ['application/json'],
            required: true,
            schema: {
              type: 'object',
              properties: { name: { type: 'string' } },
              required: ['name'],
            },
          },
        },
        responses: {
          '201': { description: 'Created', contentTypes: ['application/json'] },
        },
      },
      'widget.delete': {
        ...BASE_OPERATION,
        method: 'DELETE',
        path: '/widgets/{widgetId}',
        risk: 'destructive',
        confirmation: 'destructive',
        summary: 'Delete a widget',
        tags: ['widgets'],
        request: {
          parameters: {
            path: [
              {
                in: 'path',
                name: 'widgetId',
                required: true,
                schema: { type: 'string' },
              },
            ],
          },
        },
        responses: { '204': { description: 'Deleted' } },
      },
      'blob.get': {
        ...BASE_OPERATION,
        method: 'GET',
        path: '/blob',
        risk: 'read',
        confirmation: 'never',
        summary: 'Fetch a binary blob',
        description: 'Returns a fixed binary payload.',
        tags: ['files'],
        responses: {
          '200': {
            description: 'Binary',
            contentTypes: ['application/octet-stream'],
          },
        },
      },
      'upload.file': {
        ...BASE_OPERATION,
        method: 'POST',
        path: '/upload',
        risk: 'write',
        confirmation: 'never',
        summary: 'Upload a file',
        description: 'Uploads a multipart attachment.',
        tags: ['files'],
        request: {
          body: { kind: 'multipart', contentTypes: ['multipart/form-data'] },
        },
        responses: {
          '200': { description: 'Echo', contentTypes: ['application/json'] },
        },
      },
      'fail.get': {
        ...BASE_OPERATION,
        method: 'GET',
        path: '/fail',
        risk: 'read',
        confirmation: 'never',
        summary: 'Always fails upstream',
        tags: ['ops'],
        responses: {
          '500': {
            description: 'Upstream failure',
            contentTypes: ['application/json'],
          },
        },
      },
      'slow.get': {
        ...BASE_OPERATION,
        method: 'GET',
        path: '/slow',
        risk: 'read',
        confirmation: 'never',
        summary: 'Never responds',
        timeoutMs: 300,
        tags: ['ops'],
        responses: {
          '200': { description: 'OK', contentTypes: ['application/json'] },
        },
      },
    },
  };
  catalog.checksum = checksum(catalog, CATALOG_CHECKSUM_EXCLUDE);
  return catalog;
}

/** Globex catalog: a disjoint API so acme operations are "unknown" there. */
function globexCatalog(): Catalog {
  const catalog: Catalog = {
    catalogVersion: '2.0',
    api: { id: 'globex-api', title: 'Globex API', version: '1.0.0' },
    provenance: { sourceType: 'manual' },
    checksum: '',
    securitySchemes: {},
    operations: {
      'globex.widget.list': {
        ...BASE_OPERATION,
        method: 'GET',
        path: '/globex-widgets',
        risk: 'read',
        confirmation: 'never',
        summary: 'List globex widgets',
        tags: ['globex'],
        responses: {
          '200': { description: 'OK', contentTypes: ['application/json'] },
        },
      },
    },
  };
  catalog.checksum = checksum(catalog, CATALOG_CHECKSUM_EXCLUDE);
  return catalog;
}

function registryDocument(
  baseUrl: string,
  contractChecksum: string,
  globexChecksum: string,
  includeRevokeConnection: boolean,
): RegistryDocument {
  const network: NetworkPolicy = {
    allowedProtocols: ['http'],
    allowLoopback: true,
  };
  const connections: RegistryDocument['connections'] = [
    {
      id: 'acme-billing',
      tenantId: 'acme',
      backendId: 'contract-backend',
      baseUrl,
      network,
      auth: { type: 'none' },
    },
    {
      id: 'globex-billing',
      tenantId: 'globex',
      backendId: 'globex-backend',
      baseUrl,
      network,
      auth: { type: 'none' },
    },
    ...(includeRevokeConnection
      ? [
          {
            id: 'revoke-conn',
            tenantId: 'acme',
            backendId: 'contract-backend',
            baseUrl,
            network,
            auth: { type: 'none' },
          },
        ]
      : []),
  ];
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
        keyId: KEYS.acme.keyId,
        keyDigest: KEYS.acme.digest,
      },
      {
        id: 'globex-user',
        tenantId: 'globex',
        allowedConnectionIds: ['globex-billing'],
        keyId: KEYS.globex.keyId,
        keyDigest: KEYS.globex.digest,
      },
      {
        id: 'fresh-user',
        tenantId: 'acme',
        allowedConnectionIds: ['acme-billing'],
        keyId: KEYS.fresh.keyId,
        keyDigest: KEYS.fresh.digest,
      },
      {
        id: 'reload-user',
        tenantId: 'acme',
        allowedConnectionIds: ['acme-billing'],
        keyId: KEYS.reload.keyId,
        keyDigest: KEYS.reload.digest,
      },
      {
        id: 'revoke-user',
        tenantId: 'acme',
        allowedConnectionIds: includeRevokeConnection ? ['revoke-conn'] : [],
        keyId: KEYS.revoke.keyId,
        keyDigest: KEYS.revoke.digest,
      },
    ],
    backends: [
      {
        id: 'contract-backend',
        title: 'Contract API',
        scope: 'global',
        catalogRef: './contract-catalog.json',
        catalogChecksum: contractChecksum,
      },
      {
        id: 'globex-backend',
        title: 'Globex API',
        scope: 'global',
        catalogRef: './globex-catalog.json',
        catalogChecksum: globexChecksum,
      },
    ],
    connections,
  };
}

interface McpEnvelope {
  status: number;
  raw: string;
  body: unknown;
}

interface TextContent {
  type: 'text';
  text: string;
}

interface ToolResult {
  content: TextContent[];
  isError?: boolean;
}

let nextRequestId = 0;

async function mcpRequest(
  baseUrl: string,
  payload: Record<string, unknown>,
  token?: string,
): Promise<McpEnvelope> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const raw = await response.text();
  let body: unknown;
  try {
    body = raw === '' ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    body = raw;
  }
  return { status: response.status, raw, body };
}

function firstText(result: ToolResult): string {
  const block = result.content[0];
  if (block === undefined || block.type !== 'text') return '';
  return block.text;
}

async function callTool(
  baseUrl: string,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  nextRequestId += 1;
  const envelope = await mcpRequest(
    baseUrl,
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

interface Harness {
  profile: string;
  baseUrl: string;
  registryFile: string;
  contractChecksum: string;
  globexChecksum: string;
  server: RunningServer;
  proxy?: http.Server;
  publish(): void;
  close(): Promise<void>;
}

let upstream: http.Server;
let upstreamPort = 0;

async function startHarness(profile: string): Promise<Harness> {
  const directory = path.join(TEMPORARY, profile);
  fs.mkdirSync(directory, { recursive: true });
  const contract = contractCatalog();
  const globex = globexCatalog();
  fs.writeFileSync(
    path.join(directory, 'contract-catalog.json'),
    `${JSON.stringify(contract, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(directory, 'globex-catalog.json'),
    `${JSON.stringify(globex, null, 2)}\n`,
    'utf8',
  );
  const registryFile = path.join(directory, 'registry.json');
  writeRegistryFile(
    registryFile,
    registryDocument(
      `http://127.0.0.1:${upstreamPort}`,
      contract.checksum,
      globex.checksum,
      true,
    ),
    'json',
  );
  let server: RunningServer;
  try {
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      authMode: 'bearer',
      registryPath: registryFile,
    });
  } catch (error) {
    throw error;
  }

  let baseUrl = `http://127.0.0.1:${server.port}`;
  let proxy: http.Server | undefined;
  if (profile === 'proxied-http') {
    proxy = http.createServer((req, res) => {
      const headers = { ...req.headers, host: `127.0.0.1:${server.port}` };
      const forward = http.request(
        {
          host: '127.0.0.1',
          port: server.port,
          path: req.url ?? '/',
          method: req.method,
          headers,
        },
        (upstreamResponse) => {
          res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(res);
        },
      );
      forward.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(forward);
    });
    await new Promise<void>((resolve) => {
      proxy.listen(0, '127.0.0.1', () => resolve());
    });
    const proxyAddress = proxy.address();
    const proxyPort =
      typeof proxyAddress === 'object' && proxyAddress !== null ? proxyAddress.port : 0;
    baseUrl = `http://127.0.0.1:${proxyPort}`;
  }

  return {
    profile,
    baseUrl,
    registryFile,
    contractChecksum: contract.checksum,
    globexChecksum: globex.checksum,
    server,
    proxy,
    publish: () => {
      server.context.registry?.publish();
    },
    close: async () => {
      if (proxy !== undefined) {
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
      await server.close();
    },
  };
}

beforeAll(async () => {
  process.env[envName('KEY_PEPPER')] = PEPPER;

  upstream = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (req.method === 'GET' && url === '/') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'up' }));
        return;
      }
      if (req.method === 'GET' && url.startsWith('/widgets/')) {
        const widgetId = decodeURIComponent(url.slice('/widgets/'.length));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: widgetId, total: 42 }));
        return;
      }
      if (req.method === 'POST' && url === '/widgets') {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ created: true, received: raw.toString('utf8') }));
        return;
      }
      if (req.method === 'GET' && url === '/blob') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(BINARY_PAYLOAD);
        return;
      }
      if (req.method === 'POST' && url === '/upload') {
        const contentType = req.headers['content-type'] ?? '';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            contentType,
            boundary: contentType.includes('boundary='),
            filenamePresent: raw.includes(Buffer.from('filename="report.bin"')),
            partBytesPresent: raw.includes(Buffer.from([1, 2, 3, 4])),
          }),
        );
        return;
      }
      if (req.method === 'GET' && url === '/fail') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom' }));
        return;
      }
      if (req.method === 'GET' && url === '/slow') {
        // Never respond; the client-side timeout closes the connection.
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
});

afterAll(async () => {
  if (upstream !== undefined) {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
  if (ORIGINAL_PEPPER === undefined) {
    delete process.env[envName('KEY_PEPPER')];
  } else {
    process.env[envName('KEY_PEPPER')] = ORIGINAL_PEPPER;
  }
  fs.rmSync(TEMPORARY, { recursive: true, force: true });
});

describe.each(PROFILES)('MCP interoperability contract ($name)', ({ name }) => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness(name);
  });

  afterAll(async () => {
    if (harness !== undefined) await harness.close();
  });

  const acme = KEYS.acme.token;
  const globex = KEYS.globex.token;

  it('negotiates initialization with the fixed protocol version', async () => {
    const envelope = await mcpRequest(harness.baseUrl, {
      jsonrpc: '2.0',
      id: 'init-1',
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'contract-client', version: '1.0.0' },
      },
    });
    expect(envelope.status).toBe(200);
    expect(envelope.body).toMatchObject({
      jsonrpc: '2.0',
      id: 'init-1',
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'mcp-portico', version: expect.any(String) },
      },
    });
  });

  it('negotiates capabilities without depending on client version or vendor fields', async () => {
    const envelope = await mcpRequest(harness.baseUrl, {
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {
          prompts: {},
          logging: {},
          experimental: { vendorFlag: true },
        },
        clientInfo: { name: 'generic-host', version: '9.9.9' },
        _meta: { trace: 'abc' },
        vendorExtension: { anything: true },
      },
    });
    expect(envelope.status).toBe(200);
    const result = (
      envelope.body as {
        result: {
          protocolVersion: string;
          capabilities: Record<string, unknown>;
          serverInfo: { name: string };
        };
      }
    ).result;
    expect(result.protocolVersion).toBe('2025-06-18');
    expect(result.capabilities).toEqual({ tools: {}, resources: {} });
    expect(result.serverInfo.name).toBe('mcp-portico');
  });

  it('acknowledges notifications with empty 202 responses', async () => {
    const notifications: Array<Record<string, unknown>> = [
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      {
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 'init-1', reason: 'user' },
      },
      { jsonrpc: '2.0', method: 'some/future/notification', params: {} },
    ];
    for (const payload of notifications) {
      const envelope = await mcpRequest(harness.baseUrl, payload);
      expect(envelope.status).toBe(202);
      expect(envelope.raw).toBe('');
    }
  });

  it('discovers the fixed toolset in stable order with schemas', async () => {
    const envelope = await mcpRequest(
      harness.baseUrl,
      { jsonrpc: '2.0', id: 10, method: 'tools/list' },
      acme,
    );
    expect(envelope.status).toBe(200);
    const tools = (
      envelope.body as {
        result: {
          tools: Array<{
            name: string;
            description: string;
            inputSchema: Record<string, unknown>;
          }>;
        };
      }
    ).result.tools;
    expect(tools.map((tool) => tool.name)).toEqual([...FIXED_TOOL_NAMES]);
    for (const tool of tools) {
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
    }
    const selectSchema = tools.find((tool) => tool.name === 'select_connection')
      ?.inputSchema as { required?: string[] };
    expect(selectSchema.required).toEqual(['connectionId']);
  });

  it('ignores cursor, limit, and meta fields on discovery', async () => {
    const plain = await mcpRequest(
      harness.baseUrl,
      { jsonrpc: '2.0', id: 11, method: 'tools/list' },
      acme,
    );
    const withCursor = await mcpRequest(
      harness.baseUrl,
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/list',
        params: { cursor: 'abc', _meta: { trace: 'x' } },
      },
      acme,
    );
    expect(withCursor.status).toBe(200);
    expect(withCursor.body).toEqual(plain.body);

    const resourcesPlain = await mcpRequest(
      harness.baseUrl,
      { jsonrpc: '2.0', id: 13, method: 'resources/list' },
      acme,
    );
    const resourcesPaged = await mcpRequest(
      harness.baseUrl,
      {
        jsonrpc: '2.0',
        id: 13,
        method: 'resources/list',
        params: { limit: 1, cursor: 'abc' },
      },
      acme,
    );
    expect(resourcesPaged.body).toEqual(resourcesPlain.body);
  });

  it('lists and reads tenant-scoped resources', async () => {
    const listed = await mcpRequest(
      harness.baseUrl,
      { jsonrpc: '2.0', id: 20, method: 'resources/list' },
      acme,
    );
    expect(listed.status).toBe(200);
    const resources = (listed.body as { result: { resources: Array<{ uri: string }> } })
      .result.resources;
    expect(resources.map((resource) => resource.uri)).toEqual([
      'mcp-portico://usage',
      'mcp-portico://apis',
      'mcp-portico://apis/acme-billing',
    ]);

    const usage = await mcpRequest(
      harness.baseUrl,
      {
        jsonrpc: '2.0',
        id: 21,
        method: 'resources/read',
        params: { uri: 'mcp-portico://usage' },
      },
      acme,
    );
    expect(usage.status).toBe(200);
    const usageText = (
      usage.body as {
        result: { contents: Array<{ text: string }> };
      }
    ).result.contents[0]?.text;
    expect(usageText).toBeDefined();
    const usagePayload = JSON.parse(usageText ?? '{}') as {
      tenantId: string;
      registryRevision: number;
    };
    expect(usagePayload.tenantId).toBe('acme');
    expect(usagePayload.registryRevision).toEqual(expect.any(Number));

    const apis = await mcpRequest(
      harness.baseUrl,
      {
        jsonrpc: '2.0',
        id: 22,
        method: 'resources/read',
        params: { uri: 'mcp-portico://apis' },
      },
      acme,
    );
    const apisText = (apis.body as { result: { contents: Array<{ text: string }> } })
      .result.contents[0]?.text;
    const apisPayload = JSON.parse(apisText ?? '{}') as {
      tenantId: string;
      connections: Array<{
        id: string;
        catalog: { apiId: string };
      }>;
    };
    expect(apisPayload.tenantId).toBe('acme');
    expect(apisPayload.connections).toHaveLength(1);
    expect(apisPayload.connections[0]).toMatchObject({
      id: 'acme-billing',
      catalog: { apiId: 'contract-api' },
    });

    const single = await mcpRequest(
      harness.baseUrl,
      {
        jsonrpc: '2.0',
        id: 23,
        method: 'resources/read',
        params: { uri: 'mcp-portico://apis/acme-billing' },
      },
      acme,
    );
    const singleText = (
      single.body as { result: { contents: Array<{ text: string }> } }
    ).result.contents[0]?.text;
    const singlePayload = JSON.parse(singleText ?? '{}') as {
      connection: {
        catalog: {
          operations: Array<{ operationId: string; method: string }>;
        };
      };
    };
    expect(singlePayload.connection.catalog.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operationId: 'widget.get', method: 'GET' }),
        expect.objectContaining({
          operationId: 'widget.create',
          method: 'POST',
        }),
        expect.objectContaining({
          operationId: 'widget.delete',
          method: 'DELETE',
        }),
      ]),
    );

    const unknown = await mcpRequest(
      harness.baseUrl,
      {
        jsonrpc: '2.0',
        id: 24,
        method: 'resources/read',
        params: { uri: 'mcp-portico://no.such.resource' },
      },
      acme,
    );
    expect(unknown.body).toMatchObject({
      jsonrpc: '2.0',
      id: 24,
      error: { code: -32602, message: 'Unknown resource' },
    });
  });

  it('rejects malformed and invalid requests deterministically', async () => {
    const cases: Array<{ body: string; code: number }> = [
      { body: '{not json', code: -32700 },
      { body: '[]', code: -32600 },
      { body: '{"jsonrpc":"2.0"}', code: -32600 },
      { body: '{"jsonrpc":"1.0","id":1,"method":"initialize"}', code: -32600 },
      {
        body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":[]}',
        code: -32600,
      },
    ];
    for (const item of cases) {
      const response = await fetch(`${harness.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: item.body,
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        id: null;
        error: { code: number };
      };
      expect(body.id).toBeNull();
      expect(body.error.code).toBe(item.code);
    }
  });

  it('reports unknown methods and tools with JSON-RPC errors', async () => {
    const unknownMethod = await mcpRequest(
      harness.baseUrl,
      { jsonrpc: '2.0', id: 30, method: 'bogus/method' },
      acme,
    );
    expect(unknownMethod.status).toBe(200);
    expect(unknownMethod.body).toMatchObject({
      jsonrpc: '2.0',
      id: 30,
      error: { code: -32601, message: 'Method not found' },
    });

    const unknownTool = await mcpRequest(
      harness.baseUrl,
      {
        jsonrpc: '2.0',
        id: 31,
        method: 'tools/call',
        params: { name: 'no.such.tool', arguments: {} },
      },
      acme,
    );
    expect(unknownTool.body).toMatchObject({
      id: 31,
      error: { code: -32602, message: 'Unknown tool' },
    });

    const missingName = await mcpRequest(
      harness.baseUrl,
      {
        jsonrpc: '2.0',
        id: 32,
        method: 'tools/call',
        params: { arguments: {} },
      },
      acme,
    );
    expect(missingName.body).toMatchObject({
      id: 32,
      error: { code: -32602, message: 'Invalid params' },
    });

    const arrayArguments = await mcpRequest(
      harness.baseUrl,
      {
        jsonrpc: '2.0',
        id: 33,
        method: 'tools/call',
        params: { name: 'list_connections', arguments: [] },
      },
      acme,
    );
    expect(arrayArguments.body).toMatchObject({
      id: 33,
      error: { code: -32602, message: 'Invalid params' },
    });
  });

  it('fails authentication identically for missing, malformed, and unknown credentials', async () => {
    const missing = await mcpRequest(harness.baseUrl, {
      jsonrpc: '2.0',
      id: 40,
      method: 'tools/list',
    });
    const malformed = await mcpRequest(
      harness.baseUrl,
      { jsonrpc: '2.0', id: 40, method: 'tools/list' },
      'not-a-key',
    );
    const unknown = await mcpRequest(
      harness.baseUrl,
      { jsonrpc: '2.0', id: 40, method: 'tools/list' },
      'mpp_deadbeefdeadbeef_shortsecret',
    );
    for (const envelope of [missing, malformed, unknown]) {
      expect(envelope.status).toBe(401);
      expect(envelope.body).toMatchObject({
        jsonrpc: '2.0',
        id: 40,
        error: {
          code: -32001,
          message: 'Invalid credentials.',
          data: { code: 'AUTH' },
        },
      });
    }
    expect(missing.body).toEqual(malformed.body);
    expect(malformed.body).toEqual(unknown.body);
  });

  it('rejects unsupported HTTP methods with an Allow header', async () => {
    const response = await fetch(`${harness.baseUrl}/mcp`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, POST');
  });

  it('requires a session before session-scoped tools', async () => {
    const cases: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: 'get_session', args: {} },
      { name: 'search_operations', args: {} },
      { name: 'describe_operation', args: {} },
      { name: 'call_operation', args: { operationId: 'widget.get' } },
      { name: 'call_operations', args: { operations: [] } },
    ];
    for (const item of cases) {
      const result = await callTool(
        harness.baseUrl,
        KEYS.fresh.token,
        item.name,
        item.args,
      );
      expect(result.isError).toBe(true);
      expect(firstText(result)).toBe('No active session; select a connection first.');
    }
  });

  it('discovers connections, selects a session, and inspects the catalog', async () => {
    const listed = await callTool(harness.baseUrl, acme, 'list_connections');
    const connections = (
      JSON.parse(firstText(listed)) as {
        connections: Array<{ id: string; backendId: string; baseUrl: string }>;
      }
    ).connections;
    expect(connections).toEqual([
      {
        id: 'acme-billing',
        backendId: 'contract-backend',
        baseUrl: expect.stringContaining('127.0.0.1'),
      },
    ]);

    const selected = await callTool(harness.baseUrl, acme, 'select_connection', {
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
      JSON.parse(firstText(await callTool(harness.baseUrl, acme, 'get_session'))) as {
        session: { id: string };
      }
    ).session;
    expect(current.id).toBe(session.id);

    const byTag = (
      JSON.parse(
        firstText(
          await callTool(harness.baseUrl, acme, 'search_operations', {
            tag: 'widgets',
          }),
        ),
      ) as { operations: Array<{ operationId: string }> }
    ).operations;
    expect(byTag.map((operation) => operation.operationId).sort()).toEqual([
      'widget.create',
      'widget.delete',
      'widget.get',
    ]);

    const byRisk = (
      JSON.parse(
        firstText(
          await callTool(harness.baseUrl, acme, 'search_operations', {
            risk: 'write',
          }),
        ),
      ) as { operations: Array<{ operationId: string }> }
    ).operations;
    expect(byRisk.map((operation) => operation.operationId).sort()).toEqual([
      'upload.file',
      'widget.create',
    ]);

    const byQuery = (
      JSON.parse(
        firstText(
          await callTool(harness.baseUrl, acme, 'search_operations', {
            query: 'binary',
          }),
        ),
      ) as { operations: Array<{ operationId: string }> }
    ).operations;
    expect(byQuery.map((operation) => operation.operationId)).toEqual(['blob.get']);

    const described = (
      JSON.parse(
        firstText(
          await callTool(harness.baseUrl, acme, 'describe_operation', {
            operationId: 'widget.get',
          }),
        ),
      ) as { operation: Record<string, unknown> }
    ).operation;
    expect(described).toMatchObject({
      operationId: 'widget.get',
      method: 'GET',
      path: '/widgets/{widgetId}',
      risk: 'read',
      available: true,
    });
  });

  it('executes a read operation against the fixture backend', async () => {
    await callTool(harness.baseUrl, acme, 'select_connection', {
      connectionId: 'acme-billing',
    });
    const result = await callTool(harness.baseUrl, acme, 'call_operation', {
      operationId: 'widget.get',
      arguments: { widgetId: 'W-1' },
    });
    expect(result.isError).toBeFalsy();
    const text = result.content.map((block) => block.text).join('\n');
    expect(text).toContain('"id": "W-1"');
    expect(text).toContain('"total": 42');
    expect(text).toMatch(/status: 200/);
  });

  it('enforces deterministic confirmations for write and destructive operations', async () => {
    await callTool(harness.baseUrl, acme, 'select_connection', {
      connectionId: 'acme-billing',
    });
    const args = {
      operationId: 'widget.create',
      arguments: { body: { name: 'gadget' } },
    };

    const first = await callTool(harness.baseUrl, acme, 'call_operation', args);
    expect(first.isError).toBeFalsy();
    const confirmation = JSON.parse(firstText(first)) as {
      operationId: string;
      requiresConfirmation: boolean;
      token: string;
      risk: string;
      message: string;
    };
    expect(confirmation).toMatchObject({
      operationId: 'widget.create',
      requiresConfirmation: true,
      risk: 'write',
    });
    expect(confirmation.token).toEqual(expect.any(String));

    const repeated = await callTool(harness.baseUrl, acme, 'call_operation', args);
    const repeatedToken = (JSON.parse(firstText(repeated)) as { token: string }).token;
    expect(repeatedToken).toBe(confirmation.token);

    const wrong = await callTool(harness.baseUrl, acme, 'call_operation', {
      ...args,
      confirmationToken: 'deadbeef',
    });
    expect(wrong.isError).toBe(true);
    expect(firstText(wrong)).toBe(
      'Confirmation token does not match the operation input.',
    );

    const executed = await callTool(harness.baseUrl, acme, 'call_operation', {
      ...args,
      confirmationToken: confirmation.token,
    });
    expect(executed.isError).toBeFalsy();
    const text = executed.content.map((block) => block.text).join('\n');
    expect(text).toContain('"created": true');
    expect(text).toMatch(/status: 201/);

    const destructive = await callTool(harness.baseUrl, acme, 'call_operation', {
      operationId: 'widget.delete',
      arguments: { widgetId: 'W-9' },
    });
    const destructiveConfirmation = JSON.parse(firstText(destructive)) as {
      requiresConfirmation: boolean;
      risk: string;
    };
    expect(destructiveConfirmation).toMatchObject({
      requiresConfirmation: true,
      risk: 'destructive',
    });
  });

  it('returns binary responses as base64 text with content type', async () => {
    await callTool(harness.baseUrl, acme, 'select_connection', {
      connectionId: 'acme-billing',
    });
    const result = await callTool(harness.baseUrl, acme, 'call_operation', {
      operationId: 'blob.get',
    });
    expect(result.isError).toBeFalsy();
    const encoded = JSON.parse(firstText(result)) as {
      contentType: string;
      base64: string;
    };
    expect(encoded.contentType).toBe('application/octet-stream');
    expect(Buffer.from(encoded.base64, 'base64')).toEqual(BINARY_PAYLOAD);
    const metadata = result.content.map((block) => block.text).join('\n');
    expect(metadata).toMatch(/status: 200/);
    expect(metadata).toContain('contentType: application/octet-stream');
  });

  it('uploads multipart attachments with base64 parts', async () => {
    await callTool(harness.baseUrl, acme, 'select_connection', {
      connectionId: 'acme-billing',
    });
    const result = await callTool(harness.baseUrl, acme, 'call_operation', {
      operationId: 'upload.file',
      arguments: {
        body: {
          file: {
            base64: Buffer.from([1, 2, 3, 4]).toString('base64'),
            filename: 'report.bin',
            contentType: 'application/octet-stream',
          },
          note: 'hello',
        },
      },
    });
    expect(result.isError).toBeFalsy();
    const echo = JSON.parse(firstText(result)) as {
      contentType: string;
      boundary: boolean;
      filenamePresent: boolean;
      partBytesPresent: boolean;
    };
    expect(echo.contentType.startsWith('multipart/form-data; boundary=')).toBe(true);
    expect(echo.boundary).toBe(true);
    expect(echo.filenamePresent).toBe(true);
    expect(echo.partBytesPresent).toBe(true);
  });

  it('runs bounded batches in request order with per-item results', async () => {
    await callTool(harness.baseUrl, acme, 'select_connection', {
      connectionId: 'acme-billing',
    });
    const result = await callTool(harness.baseUrl, acme, 'call_operations', {
      operations: [
        {
          operationId: 'widget.get',
          arguments: { widgetId: 'B-1' },
          futureField: true,
        },
        { operationId: 'no.such.operation' },
        {
          operationId: 'widget.create',
          arguments: { body: { name: 'batch-widget' } },
        },
      ],
    });
    expect(result.isError).toBeFalsy();
    const batch = JSON.parse(firstText(result)) as {
      failed: number;
      results: Array<{
        index: number;
        operationId: string;
        result?: unknown;
        confirmation?: { requiresConfirmation: boolean; risk: string };
        error?: { code: string; message: string };
      }>;
    };
    expect(batch.failed).toBe(1);
    expect(batch.results).toHaveLength(3);
    expect(batch.results.map((item) => item.index)).toEqual([0, 1, 2]);
    expect(batch.results[0]).toMatchObject({
      index: 0,
      operationId: 'widget.get',
    });
    expect(batch.results[0]?.result).toBeDefined();
    expect(batch.results[1]?.error).toEqual({
      code: 'NOT_FOUND',
      message: 'Operation not found or not authorized.',
    });
    expect(batch.results[2]?.confirmation).toMatchObject({
      requiresConfirmation: true,
      risk: 'write',
    });
  });

  it('surfaces upstream HTTP failures and timeouts', async () => {
    await callTool(harness.baseUrl, acme, 'select_connection', {
      connectionId: 'acme-billing',
    });
    const failed = await callTool(harness.baseUrl, acme, 'call_operation', {
      operationId: 'fail.get',
    });
    expect(failed.isError).toBeFalsy();
    const failedText = failed.content.map((block) => block.text).join('\n');
    expect(failedText).toContain('"error": "boom"');
    expect(failedText).toMatch(/status: 500/);

    const timedOut = await callTool(harness.baseUrl, acme, 'call_operation', {
      operationId: 'slow.get',
    });
    expect(timedOut.isError).toBe(true);
    expect(firstText(timedOut)).toBe('Upstream request timed out.');
  });

  it('probes a connection under its network policy', async () => {
    const result = await callTool(harness.baseUrl, acme, 'test_connection', {
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
    expect(probe).toMatchObject({
      ok: true,
      status: 200,
      truncated: false,
      redirected: false,
    });
    expect(probe.durationMs).toEqual(expect.any(Number));
    expect(probe.bytes).toBeGreaterThan(0);
    expect(probe.finalUrl).toContain('127.0.0.1');
  });

  it('keeps authorization failures non-enumerating across tenants', async () => {
    await callTool(harness.baseUrl, acme, 'select_connection', {
      connectionId: 'acme-billing',
    });

    const unknownConnection = await callTool(
      harness.baseUrl,
      acme,
      'select_connection',
      { connectionId: 'no.such.connection' },
    );
    const unauthorizedConnection = await callTool(
      harness.baseUrl,
      globex,
      'select_connection',
      { connectionId: 'acme-billing' },
    );
    expect(unknownConnection.isError).toBe(true);
    expect(unauthorizedConnection.isError).toBe(true);
    expect(firstText(unknownConnection)).toBe('Invalid credentials.');
    expect(firstText(unauthorizedConnection)).toBe(firstText(unknownConnection));

    const globexListed = (
      JSON.parse(
        firstText(await callTool(harness.baseUrl, globex, 'list_connections')),
      ) as { connections: Array<{ id: string }> }
    ).connections;
    expect(globexListed.map((connection) => connection.id)).toEqual(['globex-billing']);

    await callTool(harness.baseUrl, globex, 'select_connection', {
      connectionId: 'globex-billing',
    });

    const unknownOperation = await callTool(
      harness.baseUrl,
      acme,
      'describe_operation',
      { operationId: 'no.such.operation' },
    );
    const crossTenantOperation = await callTool(
      harness.baseUrl,
      globex,
      'describe_operation',
      { operationId: 'widget.get' },
    );
    expect(unknownOperation.isError).toBe(true);
    expect(crossTenantOperation.isError).toBe(true);
    expect(firstText(unknownOperation)).toBe('Operation not found or not authorized.');
    expect(firstText(crossTenantOperation)).toBe(firstText(unknownOperation));

    const unknownCall = await callTool(harness.baseUrl, acme, 'call_operation', {
      operationId: 'no.such.operation',
    });
    const crossTenantCall = await callTool(harness.baseUrl, globex, 'call_operation', {
      operationId: 'widget.get',
    });
    expect(firstText(crossTenantCall)).toBe(firstText(unknownCall));

    const unknownProbe = await callTool(harness.baseUrl, acme, 'test_connection', {
      connectionId: 'no.such.connection',
    });
    const crossTenantProbe = await callTool(
      harness.baseUrl,
      globex,
      'test_connection',
      { connectionId: 'acme-billing' },
    );
    expect(firstText(crossTenantProbe)).toBe(firstText(unknownProbe));

    const unknownResource = await mcpRequest(
      harness.baseUrl,
      {
        jsonrpc: '2.0',
        id: 90,
        method: 'resources/read',
        params: { uri: 'mcp-portico://no.such.resource' },
      },
      acme,
    );
    const crossTenantResource = await mcpRequest(
      harness.baseUrl,
      {
        jsonrpc: '2.0',
        id: 90,
        method: 'resources/read',
        params: { uri: 'mcp-portico://apis/acme-billing' },
      },
      globex,
    );
    expect(unknownResource.body).toEqual(crossTenantResource.body);
    expect(crossTenantResource.body).toMatchObject({
      jsonrpc: '2.0',
      id: 90,
      error: { code: -32602, message: 'Unknown resource' },
    });
  });

  it('echoes request ids and preserves per-request ordering', async () => {
    const sequential: Array<{ id: string | number; method: string }> = [
      { id: 'seq-a', method: 'initialize' },
      { id: 21, method: 'tools/list' },
      { id: 'seq-b', method: 'tools/list' },
    ];
    for (const request of sequential) {
      const envelope = await mcpRequest(
        harness.baseUrl,
        {
          jsonrpc: '2.0',
          id: request.id,
          method: request.method,
          params: {},
        },
        acme,
      );
      expect(envelope.status).toBe(200);
      expect((envelope.body as { id: unknown }).id).toBe(request.id);
    }

    const ids = [101, 102, 103, 104, 105];
    const concurrent = await Promise.all(
      ids.map((id) =>
        mcpRequest(harness.baseUrl, { jsonrpc: '2.0', id, method: 'tools/list' }, acme),
      ),
    );
    const byId = new Map(
      concurrent.map((envelope) => [
        (envelope.body as { id: unknown }).id,
        envelope.body,
      ]),
    );
    for (const id of ids) {
      const body = byId.get(id);
      expect(body).toBeDefined();
      expect((body as { id: unknown }).id).toBe(id);
      expect((body as { result: { tools: unknown[] } }).result.tools).toHaveLength(8);
    }
  });

  it('returns identical full result sets for pagination-sized requests', async () => {
    await callTool(harness.baseUrl, acme, 'select_connection', {
      connectionId: 'acme-billing',
    });
    const variants: Array<Record<string, unknown>> = [
      { query: 'widget' },
      { query: 'widget', limit: 1 },
      { query: 'widget', page: 2 },
      { query: 'widget', cursor: 'abc' },
      { query: 'widget', _meta: { trace: 'x' } },
    ];
    const texts: string[] = [];
    for (const args of variants) {
      const result = await callTool(harness.baseUrl, acme, 'search_operations', args);
      texts.push(firstText(result));
    }
    for (const text of texts) expect(text).toBe(texts[0]);
    const operations = (
      JSON.parse(texts[0] ?? '') as {
        operations: Array<{ operationId: string }>;
      }
    ).operations;
    expect(operations.map((operation) => operation.operationId)).toEqual([
      'widget.create',
      'widget.delete',
      'widget.get',
    ]);
  });

  it('ignores unknown optional fields while keeping operation arguments strict', async () => {
    const plain = await callTool(harness.baseUrl, acme, 'list_connections');
    const extended = await callTool(harness.baseUrl, acme, 'list_connections', {
      futureFlag: true,
      extras: [1, 2],
    });
    expect(firstText(extended)).toBe(firstText(plain));

    const envelope = await mcpRequest(
      harness.baseUrl,
      {
        jsonrpc: '2.0',
        id: 60,
        method: 'tools/call',
        params: {
          name: 'list_connections',
          arguments: {},
          _meta: { trace: 'x' },
        },
      },
      acme,
    );
    expect(envelope.status).toBe(200);
    expect(
      (envelope.body as { result: { content: TextContent[] } }).result.content,
    ).toHaveLength(1);

    await callTool(harness.baseUrl, acme, 'select_connection', {
      connectionId: 'acme-billing',
    });
    const rejected = await callTool(harness.baseUrl, acme, 'call_operation', {
      operationId: 'widget.get',
      arguments: { widgetId: 'W-1', sneaky: 'x' },
    });
    expect(rejected.isError).toBe(true);
    expect(firstText(rejected)).toBe('Unknown argument(s): sneaky. Allowed: widgetId.');
  });

  it('acknowledges cancellation notifications without side effects', async () => {
    await callTool(harness.baseUrl, acme, 'select_connection', {
      connectionId: 'acme-billing',
    });
    const before = await callTool(harness.baseUrl, acme, 'get_session');
    expect(before.isError).toBeFalsy();

    const cancelled = await mcpRequest(harness.baseUrl, {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 999, reason: 'user' },
    });
    expect(cancelled.status).toBe(202);
    expect(cancelled.raw).toBe('');

    const after = await callTool(harness.baseUrl, acme, 'get_session');
    expect(after.isError).toBeFalsy();
    expect(firstText(after)).toBe(firstText(before));
  });

  it('cleans up the active session after a registry reload', async () => {
    await callTool(harness.baseUrl, KEYS.reload.token, 'select_connection', {
      connectionId: 'acme-billing',
    });
    const before = await callTool(harness.baseUrl, KEYS.reload.token, 'get_session');
    expect(before.isError).toBeFalsy();

    harness.publish();

    const after = await callTool(harness.baseUrl, KEYS.reload.token, 'get_session');
    expect(after.isError).toBe(true);
    expect(firstText(after)).toBe('No active session; select a connection first.');

    const reselected = await callTool(
      harness.baseUrl,
      KEYS.reload.token,
      'select_connection',
      { connectionId: 'acme-billing' },
    );
    expect(reselected.isError).toBeFalsy();
  });

  it('cleans up sessions and discovery after revocation', async () => {
    await callTool(harness.baseUrl, KEYS.revoke.token, 'select_connection', {
      connectionId: 'revoke-conn',
    });
    const before = await callTool(harness.baseUrl, KEYS.revoke.token, 'get_session');
    expect(before.isError).toBeFalsy();

    writeRegistryFile(
      harness.registryFile,
      registryDocument(
        `http://127.0.0.1:${upstreamPort}`,
        harness.contractChecksum,
        harness.globexChecksum,
        false,
      ),
      'json',
    );
    harness.publish();

    const listed = await callTool(
      harness.baseUrl,
      KEYS.revoke.token,
      'list_connections',
    );
    const connections = (
      JSON.parse(firstText(listed)) as { connections: Array<{ id: string }> }
    ).connections;
    expect(connections).toEqual([]);

    const after = await callTool(harness.baseUrl, KEYS.revoke.token, 'get_session');
    expect(after.isError).toBe(true);
    expect(firstText(after)).toBe('No active session; select a connection first.');

    const reselect = await callTool(
      harness.baseUrl,
      KEYS.revoke.token,
      'select_connection',
      { connectionId: 'revoke-conn' },
    );
    expect(reselect.isError).toBe(true);
    expect(firstText(reselect)).toBe('Invalid credentials.');
  });
});
