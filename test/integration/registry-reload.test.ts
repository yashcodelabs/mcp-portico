import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CATALOG_CHECKSUM_EXCLUDE, checksum } from '../../src/catalog/canonical';
import type { Catalog } from '../../src/catalog/types';
import { generatePorticoKey } from '../../src/identity/keys';
import { writeRegistryFile } from '../../src/registry/load';
import type { RegistryDocument } from '../../src/registry/types';
import { envName } from '../../src/shared/brand';
import { startServer, type RunningServer } from '../../src/cli/serve';

const PEPPER = 'reload-test-pepper';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'portico-reload-test-'));

const originalPepper = process.env[envName('KEY_PEPPER')];
const originalUpstreamToken = process.env.RELOAD_UPSTREAM_TOKEN;

let catalogChecksum = '';
let registryFile = '';
let server: RunningServer;
let key1: ReturnType<typeof generatePorticoKey>;
let key2: ReturnType<typeof generatePorticoKey>;

function bearerCatalog(): Catalog {
  const catalog: Catalog = {
    catalogVersion: '2.0',
    api: { id: 'reload', title: 'Reload API', version: '1.0' },
    provenance: { sourceType: 'manual' },
    checksum: '',
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    operations: {
      'reload.get': {
        enabled: true,
        available: true,
        method: 'GET',
        path: '/reload',
        risk: 'read',
        confirmation: 'never',
        timeoutMs: 30000,
        maxRequestBytes: 10485760,
        maxResponseBytes: 10485760,
        maxConcurrency: 4,
        security: [['bearer']],
      },
    },
  };
  catalog.checksum = checksum(catalog, CATALOG_CHECKSUM_EXCLUDE);
  return catalog;
}

function registryDocument(principalKey: {
  keyId: string;
  digest: string;
}): RegistryDocument {
  return {
    version: 1,
    tenants: [{ id: 'acme', name: 'Acme' }],
    principals: [
      {
        id: 'acme-user',
        tenantId: 'acme',
        allowedConnectionIds: ['acme-conn'],
        keyId: principalKey.keyId,
        keyDigest: principalKey.digest,
      },
    ],
    backends: [
      {
        id: 'reload-backend',
        title: 'Reload',
        scope: 'global',
        catalogRef: path.join(temporary, 'reload-catalog.json'),
        catalogChecksum,
      },
    ],
    connections: [
      {
        id: 'acme-conn',
        tenantId: 'acme',
        backendId: 'reload-backend',
        baseUrl: 'http://127.0.0.1:9',
        network: {
          allowedProtocols: ['http'],
          allowLoopback: true,
        },
        auth: { type: 'bearer', tokenRef: 'env:RELOAD_UPSTREAM_TOKEN' },
      },
    ],
  };
}

async function mcpList(token: string): Promise<{ status: number }> {
  const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  return { status: response.status };
}

async function healthzRevision(): Promise<number | undefined> {
  const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
  const body = (await response.json()) as { registryRevision?: number };
  return body.registryRevision;
}

async function waitForRevision(expected: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await healthzRevision()) === expected) return;
    if (Date.now() > deadline) {
      throw new Error(`registry revision did not reach ${expected}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  process.env[envName('KEY_PEPPER')] = PEPPER;
  process.env.RELOAD_UPSTREAM_TOKEN = 'upstream-secret-token';
  key1 = generatePorticoKey(PEPPER);
  key2 = generatePorticoKey(PEPPER);

  const catalog = bearerCatalog();
  catalogChecksum = catalog.checksum;
  fs.writeFileSync(
    path.join(temporary, 'reload-catalog.json'),
    `${JSON.stringify(catalog, null, 2)}\n`,
    'utf8',
  );
  registryFile = path.join(temporary, 'reload-registry.json');
  writeRegistryFile(registryFile, registryDocument(key1), 'json');

  server = await startServer({
    host: '127.0.0.1',
    port: 0,
    authMode: 'bearer',
    registryPath: registryFile,
  });
});

afterAll(async () => {
  await server.close();
  if (originalPepper === undefined) delete process.env[envName('KEY_PEPPER')];
  else process.env[envName('KEY_PEPPER')] = originalPepper;
  if (originalUpstreamToken === undefined) delete process.env.RELOAD_UPSTREAM_TOKEN;
  else process.env.RELOAD_UPSTREAM_TOKEN = originalUpstreamToken;
  fs.rmSync(temporary, { recursive: true, force: true });
});

describe('registry reload', () => {
  it('accepts the original key and reports revision 1', async () => {
    expect(await mcpList(key1.token)).toMatchObject({ status: 200 });
    expect(await healthzRevision()).toBe(1);
  });

  it('activates a newly created key and revokes the old one after reload', async () => {
    fs.writeFileSync(
      registryFile,
      `${JSON.stringify(registryDocument(key2), null, 2)}\n`,
      'utf8',
    );
    await waitForRevision(2);

    expect(await mcpList(key2.token)).toMatchObject({ status: 200 });
    expect(await mcpList(key1.token)).toMatchObject({ status: 401 });
  });

  it('keeps the previous snapshot when the reload candidate is invalid', async () => {
    const invalid: RegistryDocument = {
      ...registryDocument(key2),
      principals: [
        {
          id: 'acme-user',
          tenantId: 'acme',
          allowedConnectionIds: ['acme-conn'],
        },
      ],
    };
    fs.writeFileSync(registryFile, `${JSON.stringify(invalid, null, 2)}\n`, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await healthzRevision()).toBe(2);
    expect(await mcpList(key2.token)).toMatchObject({ status: 200 });
  });
});
