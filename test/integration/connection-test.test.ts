import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { executeProbe } from '../../src/security/probe';
import { buildRegistrySnapshot } from '../../src/registry/snapshot';
import { writeRegistryFile } from '../../src/registry/load';
import { CATALOG_CHECKSUM_EXCLUDE, checksum } from '../../src/catalog/canonical';
import type { Catalog } from '../../src/catalog/types';
import type { RegistryDocument } from '../../src/registry/types';
import { PorticoError } from '../../src/shared/errors';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'portico-probe-test-'));
const originalToken = process.env.PORTICO_TEST_TOKEN;

let server: http.Server;
let port = 0;
let registryFile: string;
let catalogChecksum = '';

function bearerCatalog(): Catalog {
  const catalog: Catalog = {
    catalogVersion: '2.0',
    api: { id: 'probe', title: 'Probe API', version: '1.0' },
    provenance: { sourceType: 'manual' },
    checksum: '',
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer' },
    },
    operations: {
      'probe.get': {
        enabled: true,
        available: true,
        method: 'GET',
        path: '/probe',
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

function registryDocument(baseUrl: string): RegistryDocument {
  return {
    version: 1,
    tenants: [{ id: 'acme', name: 'Acme' }],
    principals: [],
    backends: [
      {
        id: 'probe-backend',
        title: 'Probe',
        scope: 'global',
        catalogRef: path.join(temporary, 'probe-catalog.json'),
        catalogChecksum,
      },
    ],
    connections: [
      {
        id: 'probe-connection',
        tenantId: 'acme',
        backendId: 'probe-backend',
        baseUrl,
        network: {
          allowedProtocols: ['http'],
          allowLoopback: true,
          redirects: 'same-origin',
        },
        auth: { type: 'bearer', tokenRef: 'env:PORTICO_TEST_TOKEN' },
      },
    ],
  };
}

beforeAll(async () => {
  process.env.PORTICO_TEST_TOKEN = 'probe-secret-token';
  const catalog = bearerCatalog();
  catalogChecksum = catalog.checksum;
  fs.writeFileSync(
    path.join(temporary, 'probe-catalog.json'),
    `${JSON.stringify(catalog, null, 2)}\n`,
    'utf8',
  );

  server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/probe' });
      res.end();
      return;
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(10_000));
      return;
    }
    if (req.url === '/hang') {
      // Never respond.
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ auth, url: req.url }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
  registryFile = path.join(temporary, 'probe-registry.json');
  writeRegistryFile(registryFile, registryDocument(`http://127.0.0.1:${port}`), 'json');
});

afterAll(async () => {
  if (originalToken === undefined) delete process.env.PORTICO_TEST_TOKEN;
  else process.env.PORTICO_TEST_TOKEN = originalToken;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(temporary, { recursive: true, force: true });
});

describe('connection probe', () => {
  it('builds a valid snapshot for the probe registry', () => {
    const snapshot = buildRegistrySnapshot(registryFile);
    expect(snapshot.connection('probe-connection')?.backendId).toBe('probe-backend');
  });

  it('probes a reachable connection with auth injected and headers redacted', async () => {
    const result = await executeProbe({
      url: new URL(`http://127.0.0.1:${port}/probe`),
      auth: { type: 'bearer', tokenRef: 'env:PORTICO_TEST_TOKEN' },
      network: {
        allowedProtocols: ['http'],
        allowLoopback: true,
      },
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.finalUrl.endsWith('/probe')).toBe(true);
  });

  it('follows same-origin redirects when the policy allows them', async () => {
    const result = await executeProbe({
      url: new URL(`http://127.0.0.1:${port}/redirect`),
      auth: { type: 'bearer', tokenRef: 'env:PORTICO_TEST_TOKEN' },
      network: {
        allowedProtocols: ['http'],
        allowLoopback: true,
        redirects: 'same-origin',
      },
    });
    expect(result.redirected).toBe(true);
    expect(result.status).toBe(200);
    expect(result.finalUrl.endsWith('/probe')).toBe(true);
  });

  it('does not follow redirects by default', async () => {
    const result = await executeProbe({
      url: new URL(`http://127.0.0.1:${port}/redirect`),
      auth: { type: 'bearer', tokenRef: 'env:PORTICO_TEST_TOKEN' },
      network: { allowedProtocols: ['http'], allowLoopback: true },
    });
    expect(result.redirected).toBe(false);
    expect(result.status).toBe(302);
  });

  it('fails cleanly on timeout', async () => {
    const result = await executeProbe({
      url: new URL(`http://127.0.0.1:${port}/hang`),
      auth: { type: 'bearer', tokenRef: 'env:PORTICO_TEST_TOKEN' },
      network: { allowedProtocols: ['http'], allowLoopback: true },
      timeoutMs: 200,
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('REQUEST_FAILED');
  });

  it('truncates oversized responses', async () => {
    const result = await executeProbe({
      url: new URL(`http://127.0.0.1:${port}/big`),
      auth: { type: 'bearer', tokenRef: 'env:PORTICO_TEST_TOKEN' },
      network: { allowedProtocols: ['http'], allowLoopback: true },
      maxResponseBytes: 100,
    });
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeGreaterThan(100);
  });

  it('refuses loopback destinations without permission', async () => {
    await expect(
      executeProbe({
        url: new URL(`http://127.0.0.1:${port}/probe`),
        auth: { type: 'bearer', tokenRef: 'env:PORTICO_TEST_TOKEN' },
        network: { allowedProtocols: ['http'] },
      }),
    ).rejects.toThrow(PorticoError);
  });
});
