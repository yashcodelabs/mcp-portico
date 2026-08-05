import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { PorticoPrincipal } from '../../src/auth/types';
import type { Catalog } from '../../src/catalog/types';
import { writeRegistryFile } from '../../src/registry/load';
import { RuntimeRegistry, snapshotFromDocument } from '../../src/registry/snapshot';
import type { RegistryDocument } from '../../src/registry/types';
import { TenantRuntime } from '../../src/runtime/tenant';
import { PorticoError } from '../../src/shared/errors';
import {
  sampleCatalog,
  TEST_CATALOG_CHECKSUM,
  TEST_CATALOG_REF,
} from '../helpers/registry';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'portico-isolation-test-'));
const REAL_CHECKSUM =
  'sha256:6d58295e29802224dad1624bb8b4c1e22c45433d32f91c69216c76ff5d87ed0d';

afterAll(() => {
  fs.rmSync(temporary, { recursive: true, force: true });
});

function principal(id = 'acme-automation'): PorticoPrincipal {
  return { id, tenantId: 'acme', allowedConnectionIds: ['acme-billing-prod'] };
}

function docWithConnection(
  overrides: Partial<RegistryDocument> = {},
): RegistryDocument {
  return {
    version: 1,
    tenants: [
      { id: 'acme', name: 'Acme' },
      { id: 'globex', name: 'Globex' },
    ],
    principals: [
      {
        id: 'acme-automation',
        tenantId: 'acme',
        allowedConnectionIds: ['acme-billing-prod'],
      },
    ],
    backends: [
      {
        id: 'billing',
        title: 'Billing',
        scope: 'global',
        catalogRef: TEST_CATALOG_REF,
        catalogChecksum: TEST_CATALOG_CHECKSUM,
      },
    ],
    connections: [
      {
        id: 'acme-billing-prod',
        tenantId: 'acme',
        backendId: 'billing',
        baseUrl: 'https://example.com',
        auth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          valueRef: 'env:ACME_KEY',
        },
      },
    ],
    ...overrides,
  };
}

function snapshotFor(document: RegistryDocument, catalog: Catalog, revision = 1) {
  return snapshotFromDocument(
    document,
    new Map([[TEST_CATALOG_REF, catalog]]),
    revision,
  );
}

describe('isolation without an execution runtime', () => {
  it('a backend without a connection grants no principal access', () => {
    const document: RegistryDocument = {
      version: 1,
      tenants: [{ id: 'acme', name: 'Acme' }],
      principals: [{ id: 'automation', tenantId: 'acme', allowedConnectionIds: [] }],
      backends: [
        {
          id: 'billing',
          title: 'Billing',
          scope: 'global',
          catalogRef: TEST_CATALOG_REF,
          catalogChecksum: TEST_CATALOG_CHECKSUM,
        },
      ],
      connections: [],
    };
    const snapshot = snapshotFor(document, sampleCatalog());
    const runtime = new TenantRuntime({ snapshot });
    const automation: PorticoPrincipal = {
      id: 'automation',
      tenantId: 'acme',
      allowedConnectionIds: [],
    };
    expect(runtime.authorizedConnections(automation)).toEqual([]);
    expect(() =>
      runtime.sessions.create({
        principal: automation,
        connectionId: 'acme-billing-prod',
        snapshot,
      }),
    ).toThrow(PorticoError);
  });
});

describe('session invalidation matrix', () => {
  it('invalidates a session when the catalog checksum changes', () => {
    const document = docWithConnection();
    const catalogB = { ...sampleCatalog(), checksum: `sha256:${'b'.repeat(64)}` };
    const first = snapshotFor(document, sampleCatalog(), 1);
    const runtime = new TenantRuntime({ snapshot: first });
    runtime.sessions.create({
      principal: principal(),
      connectionId: 'acme-billing-prod',
      snapshot: first,
    });
    expect(runtime.sessions.count()).toBe(1);
    const documentB = docWithConnection({
      backends: [
        {
          id: 'billing',
          title: 'Billing',
          scope: 'global',
          catalogRef: TEST_CATALOG_REF,
          catalogChecksum: catalogB.checksum,
        },
      ],
    });
    runtime.updateSnapshot(snapshotFor(documentB, catalogB, 1));
    expect(runtime.sessions.count()).toBe(0);
  });

  it('invalidates a session when connection ownership changes', () => {
    const first = snapshotFor(docWithConnection(), sampleCatalog(), 1);
    const runtime = new TenantRuntime({ snapshot: first });
    runtime.sessions.create({
      principal: principal(),
      connectionId: 'acme-billing-prod',
      snapshot: first,
    });
    const reowned = docWithConnection({
      principals: [
        { id: 'acme-automation', tenantId: 'acme', allowedConnectionIds: [] },
      ],
      connections: [
        {
          id: 'acme-billing-prod',
          tenantId: 'globex',
          backendId: 'billing',
          baseUrl: 'https://example.com',
          auth: {
            type: 'apiKey',
            in: 'header',
            name: 'X-API-Key',
            valueRef: 'env:GLOBEX_KEY',
          },
        },
      ],
    });
    runtime.updateSnapshot(snapshotFor(reowned, sampleCatalog(), 1));
    expect(runtime.sessions.count()).toBe(0);
  });

  it('invalidates a session when the principal is revoked', () => {
    const first = snapshotFor(docWithConnection(), sampleCatalog(), 1);
    const runtime = new TenantRuntime({ snapshot: first });
    runtime.sessions.create({
      principal: principal(),
      connectionId: 'acme-billing-prod',
      snapshot: first,
    });
    const revoked = docWithConnection({ principals: [] });
    runtime.updateSnapshot(snapshotFor(revoked, sampleCatalog(), 1));
    expect(runtime.sessions.count()).toBe(0);
  });

  it('invalidates a session on a policy change (revision bump)', () => {
    const first = snapshotFor(docWithConnection(), sampleCatalog(), 1);
    const runtime = new TenantRuntime({ snapshot: first });
    runtime.sessions.create({
      principal: principal(),
      connectionId: 'acme-billing-prod',
      snapshot: first,
    });
    const republished = docWithConnection({
      connections: [
        {
          id: 'acme-billing-prod',
          tenantId: 'acme',
          backendId: 'billing',
          baseUrl: 'https://example.com',
          auth: {
            type: 'apiKey',
            in: 'header',
            name: 'X-API-Key',
            valueRef: 'env:ACME_KEY',
          },
          policy: { maxConcurrency: 1 },
        },
      ],
    });
    runtime.updateSnapshot(snapshotFor(republished, sampleCatalog(), 2));
    expect(runtime.sessions.count()).toBe(0);
  });
});

describe('atomic reload through RuntimeRegistry', () => {
  it('publishes, notifies subscribers, and keeps the old snapshot on invalid candidates', () => {
    const catalogSource = path.join(
      __dirname,
      '..',
      'fixtures',
      'catalog',
      'sample-catalog.json',
    );
    const catalog = path.join(temporary, 'isolation-catalog.json');
    fs.copyFileSync(catalogSource, catalog);
    const registryFile = path.join(temporary, 'isolation-registry.json');
    writeRegistryFile(
      registryFile,
      docWithConnection({
        backends: [
          {
            id: 'billing',
            title: 'Billing',
            scope: 'global',
            catalogRef: catalog,
            catalogChecksum: REAL_CHECKSUM,
          },
        ],
      }),
      'json',
    );

    const registry = new RuntimeRegistry(registryFile);
    const first = registry.publish();
    const runtime = new TenantRuntime({ snapshot: first });
    registry.subscribe((next) => runtime.updateSnapshot(next));
    runtime.sessions.create({
      principal: principal(),
      connectionId: 'acme-billing-prod',
      snapshot: first,
    });
    expect(runtime.sessions.count()).toBe(1);

    // Valid revocation: publish a registry without the connection.
    const revoked = docWithConnection({
      principals: [
        { id: 'acme-automation', tenantId: 'acme', allowedConnectionIds: [] },
      ],
      connections: [],
      backends: [
        {
          id: 'billing',
          title: 'Billing',
          scope: 'global',
          catalogRef: catalog,
          catalogChecksum: REAL_CHECKSUM,
        },
      ],
    });
    writeRegistryFile(registryFile, revoked, 'json');
    const second = registry.publish();
    expect(second.revision).toBe(2);
    expect(runtime.snapshot.revision).toBe(2);
    expect(runtime.sessions.count()).toBe(0);

    // Invalid candidate: publication fails and the previous snapshot stays active.
    const invalid = {
      ...revoked,
      tenants: [...revoked.tenants, { id: 'acme', name: 'Dup' }],
    };
    writeRegistryFile(registryFile, invalid, 'json');
    expect(() => registry.publish()).toThrow();
    expect(runtime.snapshot.revision).toBe(2);
  });
});
