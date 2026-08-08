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

const PEPPER = 'inspector-test-pepper';
const ACME_UPSTREAM_TOKEN = 'upstream-secret-acme';
const GLOBEX_UPSTREAM_KEY = 'upstream-secret-globex';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'portico-inspector-'));
const originalPepper = process.env[envName('KEY_PEPPER')];

let upstream: http.Server;
let upstreamPort = 0;
let server: RunningServer;
let acmeToken = '';
let globexToken = '';

function model(): NormalizedApiModel {
  return {
    api: { id: 'billing', title: 'Billing API', version: '1.0.0' },
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
            schema: {
              type: 'object',
              properties: { id: { type: 'string' }, total: { type: 'number' } },
            },
          },
        },
      },
      {
        operationId: 'invoice.create',
        method: 'POST',
        path: '/invoices',
        summary: 'Create an invoice',
        requestBody: {
          contentTypes: ['application/json'],
          schema: { type: 'object' },
        },
        responses: {
          '201': {
            description: 'Created',
            contentTypes: ['application/json'],
          },
        },
      },
    ],
  };
}

function registryDocument(
  catalogChecksum: string,
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
        catalogChecksum,
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

interface JsonEnvelope {
  status: number;
  body: unknown;
  text: string;
}

function port(): number {
  if (server === undefined) throw new Error('server not started');
  return server.port;
}

async function json(
  method: string,
  url: string,
  token?: string,
): Promise<JsonEnvelope> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`http://127.0.0.1:${port()}${url}`, {
    method,
    headers,
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = text;
  }
  return { status: response.status, body, text };
}

beforeAll(async () => {
  process.env[envName('KEY_PEPPER')] = PEPPER;
  process.env.ACME_UPSTREAM_TOKEN = ACME_UPSTREAM_TOKEN;
  process.env.GLOBEX_UPSTREAM_KEY = GLOBEX_UPSTREAM_KEY;

  const acmeKey = generatePorticoKey(PEPPER);
  const globexKey = generatePorticoKey(PEPPER);
  acmeToken = acmeKey.token;
  globexToken = globexKey.token;

  const catalog = compileCatalog(model(), undefined, {
    now: new Date('2026-08-08T00:00:00.000Z'),
  }).catalog;
  fs.writeFileSync(
    path.join(temporary, 'catalog.json'),
    `${JSON.stringify(catalog, null, 2)}\n`,
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
      catalog.checksum,
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

describe('inspector', () => {
  it('serves the read-only HTML shell without authentication', async () => {
    const response = await json('GET', '/inspector');
    expect(response.status).toBe(200);
    expect(response.text).toContain('MCP Portico inspector');
    expect(response.text).toContain('/inspector/api/overview');
  });

  it('exposes unauthenticated product metadata', async () => {
    const response = await json('GET', '/inspector/api/meta');
    expect(response.status).toBe(200);
    const meta = response.body as {
      product: string;
      version: string;
      authMode: string;
      registryRevision: number;
    };
    expect(meta.product).toBe('mcp-portico');
    expect(meta.authMode).toBe('bearer');
    expect(meta.registryRevision).toBeGreaterThanOrEqual(1);
  });

  it('rejects data endpoints without a valid API key', async () => {
    const missing = await json('GET', '/inspector/api/overview');
    expect(missing.status).toBe(401);
    const invalid = await json('GET', '/inspector/api/overview', 'not-a-key');
    expect(invalid.status).toBe(401);
  });

  it('scopes the overview to the authenticated tenant', async () => {
    const acme = await json('GET', '/inspector/api/overview', acmeToken);
    expect(acme.status).toBe(200);
    const acmeBody = acme.body as {
      tenant: { id: string };
      principal: { id: string };
      summary: { connections: number; operations: number; available: number };
      connections: Array<{ id: string }>;
    };
    expect(acmeBody.tenant.id).toBe('acme');
    expect(acmeBody.principal.id).toBe('acme-user');
    expect(acmeBody.summary.connections).toBe(1);
    expect(acmeBody.summary.operations).toBe(2);
    expect(acmeBody.connections.map((connection) => connection.id)).toEqual([
      'acme-billing',
    ]);
    expect(acme.text).not.toContain('globex-billing');

    const globex = await json('GET', '/inspector/api/overview', globexToken);
    const globexBody = globex.body as {
      tenant: { id: string };
      connections: Array<{ id: string }>;
    };
    expect(globexBody.tenant.id).toBe('globex');
    expect(globexBody.connections.map((connection) => connection.id)).toEqual([
      'globex-billing',
    ]);
    expect(globex.text).not.toContain('acme-billing');
  });

  it('summarizes connections with redacted auth and no secret values', async () => {
    const acme = await json('GET', '/inspector/api/connections', acmeToken);
    const acmeBody = acme.body as {
      connections: Array<{
        id: string;
        authType: string;
        auth: Record<string, string>;
        catalog: { operations: number; available: number };
        health: { status: string };
      }>;
    };
    const acmeConnection = acmeBody.connections[0];
    expect(acmeConnection?.id).toBe('acme-billing');
    expect(acmeConnection?.authType).toBe('bearer');
    expect(acmeConnection?.auth.tokenRef).toBe('env:ACME_UPSTREAM_TOKEN');
    expect(acmeConnection?.catalog.operations).toBe(2);
    expect(acmeConnection?.health?.status ?? 'unknown').toBe('unknown');
    expect(acme.text).not.toContain(ACME_UPSTREAM_TOKEN);

    const globex = await json('GET', '/inspector/api/connections', globexToken);
    const globexBody = globex.body as {
      connections: Array<{ auth: Record<string, string> }>;
    };
    expect(globexBody.connections[0]?.auth.valueRef).toBe('env:GLOBEX_UPSTREAM_KEY');
    expect(globex.text).not.toContain(GLOBEX_UPSTREAM_KEY);
  });

  it('returns a tenant-scoped connection detail with operations and activity', async () => {
    const response = await json(
      'GET',
      '/inspector/api/connections/acme-billing',
      acmeToken,
    );
    expect(response.status).toBe(200);
    const body = response.body as {
      id: string;
      operations: Array<{
        id: string;
        method: string;
        path: string;
        available: boolean;
      }>;
      audit: Array<{ action: string }>;
    };
    expect(body.id).toBe('acme-billing');
    expect(body.operations.map((operation) => operation.id).sort()).toEqual([
      'invoice.create',
      'invoice.get',
    ]);
    const get = body.operations.find((operation) => operation.id === 'invoice.get');
    expect(get?.method).toBe('GET');
    expect(get?.path).toBe('/invoices/{invoiceId}');
    expect(get?.available).toBe(true);
    expect(Array.isArray(body.audit)).toBe(true);
  });

  it('does not enumerate connections outside the tenant', async () => {
    const crossTenant = await json(
      'GET',
      '/inspector/api/connections/globex-billing',
      acmeToken,
    );
    const unknown = await json(
      'GET',
      '/inspector/api/connections/does-not-exist',
      acmeToken,
    );
    expect(crossTenant.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(crossTenant.text).toBe(unknown.text);
  });

  it('runs a safe connection test and records tenant-scoped audit', async () => {
    const response = await json(
      'POST',
      '/inspector/api/connections/acme-billing/test',
      acmeToken,
    );
    expect(response.status).toBe(200);
    const body = response.body as { probe: { ok: boolean; status: number } };
    expect(body.probe.ok).toBe(true);
    expect(body.probe.status).toBe(200);

    const acmeAudit = server.context.audit.forTenant('acme');
    expect(acmeAudit.map((event) => event.action)).toContain('test_connection');
    const globexAudit = server.context.audit.forTenant('globex');
    expect(globexAudit.some((event) => event.connectionId === 'acme-billing')).toBe(
      false,
    );
  });

  it('rejects a connection test outside the tenant', async () => {
    const response = await json(
      'POST',
      '/inspector/api/connections/globex-billing/test',
      acmeToken,
    );
    expect(response.status).toBe(404);
  });

  it('serves tenant-filtered audit activity', async () => {
    const response = await json('GET', '/inspector/api/audit', acmeToken);
    expect(response.status).toBe(200);
    const body = response.body as {
      events: Array<{ tenantId?: string; connectionId?: string }>;
    };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.every((event) => event.tenantId === 'acme')).toBe(true);
    expect(body.events.some((event) => event.connectionId === 'globex-billing')).toBe(
      false,
    );
  });
});
