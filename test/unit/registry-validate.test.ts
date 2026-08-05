import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildRegistrySnapshot,
  snapshotFromDocument,
} from '../../src/registry/snapshot';
import type { RegistryValidationIssue } from '../../src/registry/validate';
import type { RegistryDocument } from '../../src/registry/types';
import { PorticoError } from '../../src/shared/errors';
import {
  sampleCatalog,
  sampleRegistryDoc,
  TEST_CATALOG_REF,
} from '../helpers/registry';

function issuesFor(document: RegistryDocument): RegistryValidationIssue[] {
  try {
    snapshotFromDocument(document, new Map([[TEST_CATALOG_REF, sampleCatalog()]]));
  } catch (error) {
    if (error instanceof PorticoError) {
      const details = error.details as { issues?: RegistryValidationIssue[] };
      return details.issues ?? [];
    }
    throw error;
  }
  return [];
}

function expectIssue(document: RegistryDocument, expectedCode: string): void {
  const issues = issuesFor(document);
  expect(issues.map((item) => item.code)).toContain(expectedCode);
}

describe('registry semantic validation', () => {
  it('accepts a valid registry with two tenants sharing a global backend', () => {
    expect(issuesFor(sampleRegistryDoc())).toEqual([]);
  });

  it('rejects duplicate ids in any namespace', () => {
    expectIssue(
      sampleRegistryDoc({
        tenants: [
          { id: 'acme', name: 'Acme' },
          { id: 'acme', name: 'Duplicate' },
        ],
      }),
      'DUPLICATE_ID',
    );
  });

  it('rejects a principal allowlisting a connection owned by another tenant', () => {
    expectIssue(
      sampleRegistryDoc({
        principals: [
          {
            id: 'acme-automation',
            tenantId: 'acme',
            allowedConnectionIds: ['globex-billing-prod'],
          },
        ],
      }),
      'CROSS_TENANT_ALLOWLIST',
    );
  });

  it('rejects a tenant-scoped backend referenced by another tenant', () => {
    expectIssue(
      sampleRegistryDoc({
        backends: [
          {
            id: 'acme-ledger',
            title: 'Acme Ledger',
            scope: 'tenant',
            ownerTenantId: 'acme',
            catalogRef: TEST_CATALOG_REF,
            catalogChecksum: sampleCatalog().checksum,
          },
        ],
        connections: [
          {
            id: 'globex-ledger-prod',
            tenantId: 'globex',
            backendId: 'acme-ledger',
            baseUrl: 'https://example.com',
            auth: { type: 'none' },
          },
        ],
      }),
      'CROSS_TENANT_BACKEND',
    );
  });

  it('rejects a global backend that declares an owner', () => {
    expectIssue(
      sampleRegistryDoc({
        backends: [
          {
            id: 'billing',
            title: 'Billing',
            scope: 'global',
            ownerTenantId: 'acme',
            catalogRef: TEST_CATALOG_REF,
            catalogChecksum: sampleCatalog().checksum,
          },
        ],
        connections: [],
      }),
      'GLOBAL_BACKEND_WITH_OWNER',
    );
  });

  it('rejects a tenant-scoped backend without an owner', () => {
    expectIssue(
      sampleRegistryDoc({
        backends: [
          {
            id: 'acme-ledger',
            title: 'Acme Ledger',
            scope: 'tenant',
            catalogRef: TEST_CATALOG_REF,
            catalogChecksum: sampleCatalog().checksum,
          },
        ],
        connections: [],
      }),
      'TENANT_BACKEND_WITHOUT_OWNER',
    );
  });

  it('rejects connections referencing unknown backends and tenants', () => {
    expectIssue(
      sampleRegistryDoc({
        connections: [
          {
            id: 'ghost-connection',
            tenantId: 'ghost-tenant',
            backendId: 'ghost-backend',
            baseUrl: 'https://example.com',
            auth: { type: 'none' },
          },
        ],
      }),
      'UNKNOWN_BACKEND',
    );
  });

  it('rejects a catalog checksum mismatch', () => {
    expectIssue(
      sampleRegistryDoc({
        backends: [
          {
            id: 'billing',
            title: 'Billing',
            scope: 'global',
            catalogRef: TEST_CATALOG_REF,
            catalogChecksum: `sha256:${'0'.repeat(64)}`,
          },
        ],
        connections: [],
      }),
      'CATALOG_CHECKSUM_MISMATCH',
    );
  });

  it('reports a catalog that cannot be loaded', () => {
    expectIssue(
      sampleRegistryDoc({
        backends: [
          {
            id: 'billing',
            title: 'Billing',
            scope: 'global',
            catalogRef: 'missing-catalog.json',
            catalogChecksum: sampleCatalog().checksum,
          },
        ],
        connections: [],
      }),
      'CATALOG_LOAD_FAILED',
    );
  });

  it('rejects a connection policy that raises catalog limits', () => {
    expectIssue(
      sampleRegistryDoc({
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
            policy: { timeoutMs: 60000 },
          },
        ],
      }),
      'NON_MONOTONIC_POLICY',
    );
  });

  it('rejects a connection policy that relaxes confirmation', () => {
    expectIssue(
      sampleRegistryDoc({
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
            policy: { confirmation: 'never' },
          },
        ],
      }),
      'NON_MONOTONIC_POLICY',
    );
  });

  it('rejects a policy that disables an unknown operation', () => {
    expectIssue(
      sampleRegistryDoc({
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
            policy: { disabledOperations: ['ghost.operation'] },
          },
        ],
      }),
      'UNKNOWN_OPERATION',
    );
  });

  it('accepts a policy restricted to catalog-known content types', () => {
    const document = sampleRegistryDoc();
    const acmeConnection = document.connections[0];
    if (acmeConnection !== undefined) {
      acmeConnection.policy = { allowedContentTypes: ['application/json'] };
    }
    expect(issuesFor(document)).toEqual([]);
  });

  it('rejects allowedContentTypes the catalog does not define', () => {
    expectIssue(
      sampleRegistryDoc({
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
            policy: { allowedContentTypes: ['application/xml'] },
          },
        ],
      }),
      'NON_MONOTONIC_POLICY',
    );
  });

  it('rejects unsafe static headers', () => {
    expectIssue(
      sampleRegistryDoc({
        connections: [
          {
            id: 'acme-billing-prod',
            tenantId: 'acme',
            backendId: 'billing',
            baseUrl: 'https://example.com',
            auth: { type: 'none' },
            staticHeaders: { host: 'evil.example' },
          },
        ],
      }),
      'UNSAFE_STATIC_HEADER',
    );
  });

  it('rejects destinations the network policy does not permit', () => {
    expectIssue(
      sampleRegistryDoc({
        connections: [
          {
            id: 'acme-billing-prod',
            tenantId: 'acme',
            backendId: 'billing',
            baseUrl: 'http://10.0.0.5',
            network: { allowedProtocols: ['http'] },
            auth: { type: 'none' },
          },
        ],
      }),
      'UNSAFE_DESTINATION',
    );
  });

  it('rejects connections whose auth cannot satisfy the catalog', () => {
    expectIssue(
      sampleRegistryDoc({
        connections: [
          {
            id: 'acme-billing-prod',
            tenantId: 'acme',
            backendId: 'billing',
            baseUrl: 'https://example.com',
            auth: { type: 'bearer', tokenRef: 'env:ACME_TOKEN' },
          },
        ],
      }),
      'AUTH_INCOMPATIBLE',
    );
  });
});

describe('registry fixture files', () => {
  const fixtureRoot = path.join(__dirname, '..', 'fixtures', 'registry');

  it('builds a snapshot from the valid fixture', () => {
    const snapshot = buildRegistrySnapshot(
      path.join(fixtureRoot, 'valid', 'registry.json'),
    );
    expect(snapshot.revision).toBe(1);
    expect(
      snapshot.connectionsForPrincipal(snapshot.principal('acme-automation')!),
    ).toHaveLength(1);
  });

  const expectedCodes: Record<string, string> = {
    'duplicate-ids.json': 'DUPLICATE_ID',
    'cross-tenant-principal.json': 'CROSS_TENANT_ALLOWLIST',
    'cross-tenant-private-backend.json': 'CROSS_TENANT_BACKEND',
    'missing-backend.json': 'UNKNOWN_BACKEND',
    'checksum-mismatch.json': 'CATALOG_CHECKSUM_MISMATCH',
    'non-monotonic-policy.json': 'NON_MONOTONIC_POLICY',
    'unsafe-static-header.json': 'UNSAFE_STATIC_HEADER',
    'unsafe-destination.json': 'UNSAFE_DESTINATION',
    'global-backend-owner.json': 'GLOBAL_BACKEND_WITH_OWNER',
    'tenant-backend-no-owner.json': 'TENANT_BACKEND_WITHOUT_OWNER',
    'unknown-operation-policy.json': 'UNKNOWN_OPERATION',
    'non-monotonic-content-types.json': 'NON_MONOTONIC_POLICY',
    'auth-incompatible.json': 'AUTH_INCOMPATIBLE',
  };

  for (const [file, expectedCode] of Object.entries(expectedCodes)) {
    it(`rejects ${file} with ${expectedCode}`, () => {
      let thrown: unknown;
      try {
        buildRegistrySnapshot(path.join(fixtureRoot, 'invalid', file));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PorticoError);
      const details = (thrown as PorticoError).details as {
        issues: RegistryValidationIssue[];
      };
      expect(details.issues.map((item) => item.code)).toContain(expectedCode);
    });
  }

  it('rejects bad-secret-ref.json at the schema level', () => {
    let thrown: unknown;
    try {
      buildRegistrySnapshot(path.join(fixtureRoot, 'invalid', 'bad-secret-ref.json'));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PorticoError);
    expect((thrown as PorticoError).code).toBe('CONFIG_ERROR');
  });
});
