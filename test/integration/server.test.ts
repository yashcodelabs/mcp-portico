import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from '../../src/cli/serve';
import { CATALOG_CHECKSUM_EXCLUDE, checksum } from '../../src/catalog/canonical';
import type { Catalog } from '../../src/catalog/types';
import { generatePorticoKey } from '../../src/identity/keys';
import { writeRegistryFile } from '../../src/registry/load';
import type { RegistryDocument } from '../../src/registry/types';
import { envName, PACKAGE_NAME } from '../../src/shared/brand';
import { PorticoError } from '../../src/shared/errors';

const running: RunningServer[] = [];
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'portico-server-test-'));
const originalToken = process.env.PORTICO_SERVER_TEST_TOKEN;
const PEPPER = 'server-test-pepper';
const originalPepper = process.env[envName('KEY_PEPPER')];

afterEach(async () => {
  for (const server of running.splice(0)) {
    await server.close();
  }
});

async function startTestServer(
  options: Partial<{ host: string; port: number; authMode: 'none' | 'bearer' }> = {},
): Promise<RunningServer> {
  const server = await startServer({
    host: options.host ?? '127.0.0.1',
    port: options.port ?? 0,
    authMode: options.authMode ?? 'none',
  });
  running.push(server);
  return server;
}

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

function loopbackRegistry(): { file: string; checksum: string } {
  const catalog = bearerCatalog();
  const key = generatePorticoKey(PEPPER);
  const catalogFile = path.join(temporary, 'server-catalog.json');
  fs.writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  const document: RegistryDocument = {
    version: 1,
    tenants: [{ id: 'acme', name: 'Acme' }],
    principals: [
      {
        id: 'acme-automation',
        tenantId: 'acme',
        allowedConnectionIds: ['probe-connection'],
        keyId: key.keyId,
        keyDigest: key.digest,
      },
    ],
    backends: [
      {
        id: 'probe-backend',
        title: 'Probe',
        scope: 'global',
        catalogRef: catalogFile,
        catalogChecksum: catalog.checksum,
      },
    ],
    connections: [
      {
        id: 'probe-connection',
        tenantId: 'acme',
        backendId: 'probe-backend',
        baseUrl: 'http://127.0.0.1:9',
        network: {
          allowedProtocols: ['http'],
          allowLoopback: true,
        },
        auth: { type: 'bearer', tokenRef: 'env:PORTICO_SERVER_TEST_TOKEN' },
      },
    ],
  };
  const file = path.join(temporary, 'server-registry.json');
  writeRegistryFile(file, document, 'json');
  return { file, checksum: catalog.checksum };
}

beforeAll(() => {
  process.env.PORTICO_SERVER_TEST_TOKEN = 'server-test-token';
  process.env[envName('KEY_PEPPER')] = PEPPER;
});

afterAll(() => {
  if (originalToken === undefined) delete process.env.PORTICO_SERVER_TEST_TOKEN;
  else process.env.PORTICO_SERVER_TEST_TOKEN = originalToken;
  if (originalPepper === undefined) delete process.env[envName('KEY_PEPPER')];
  else process.env[envName('KEY_PEPPER')] = originalPepper;
  fs.rmSync(temporary, { recursive: true, force: true });
});

describe('Phase 1 HTTP server', () => {
  it('serves health information on /healthz', async () => {
    const server = await startTestServer();
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.name).toBe(PACKAGE_NAME);
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
  });

  it('returns 404 for unknown paths', async () => {
    const server = await startTestServer();
    const response = await fetch(`http://127.0.0.1:${server.port}/unknown`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 405 for non-GET methods on /healthz', async () => {
    const server = await startTestServer();
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`, {
      method: 'POST',
    });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, POST');
  });

  it('refuses non-loopback binding in unauthenticated mode', async () => {
    const error = await startServer({
      host: '0.0.0.0',
      port: 0,
      authMode: 'none',
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PorticoError);
    expect((error as PorticoError).code).toBe('CONFIG_ERROR');
  });

  it('requires a registry before binding once an identity mode is configured', async () => {
    await expect(
      startServer({ host: '0.0.0.0', port: 0, authMode: 'bearer' }),
    ).rejects.toThrow(PorticoError);
  });

  it('loads and validates a registry at startup and reports its revision', async () => {
    const { file } = loopbackRegistry();
    const server = await startServer({
      host: '127.0.0.1',
      port: 0,
      authMode: 'bearer',
      registryPath: file,
    });
    running.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    const body = (await response.json()) as {
      registryRevision: number;
      authMode: string;
    };
    expect(body.registryRevision).toBe(1);
    expect(body.authMode).toBe('bearer');
  });

  it('refuses unauthenticated mode when a tenant-aware registry is configured', async () => {
    const { file } = loopbackRegistry();
    let thrown: unknown;
    try {
      await startServer({
        host: '127.0.0.1',
        port: 0,
        authMode: 'none',
        registryPath: file,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PorticoError);
    expect((thrown as PorticoError).code).toBe('CONFIG_ERROR');
    expect((thrown as PorticoError).message).toContain('synthetic');
  });

  it('refuses to start with bearer auth and no registry', async () => {
    await expect(
      startServer({ host: '127.0.0.1', port: 0, authMode: 'bearer' }),
    ).rejects.toThrow(PorticoError);
  });

  it('refuses to start when the registry is invalid', async () => {
    const invalid: RegistryDocument = {
      version: 1,
      tenants: [
        { id: 'acme', name: 'Acme' },
        { id: 'acme', name: 'Duplicate' },
      ],
      principals: [],
      backends: [],
      connections: [],
    };
    const file = path.join(temporary, 'invalid-registry.json');
    writeRegistryFile(file, invalid, 'json');
    await expect(
      startServer({
        host: '127.0.0.1',
        port: 0,
        authMode: 'bearer',
        registryPath: file,
      }),
    ).rejects.toThrow(PorticoError);
  });
});
