import type { Catalog, CatalogOperation } from '../../src/catalog/types';
import type { RegistryDocument } from '../../src/registry/types';
import {
  snapshotFromDocument,
  type RegistrySnapshot,
} from '../../src/registry/snapshot';

export const TEST_CATALOG_CHECKSUM = `sha256:${'a'.repeat(64)}`;
export const TEST_CATALOG_REF = 'catalog.json';

export function sampleCatalog(): Catalog {
  const operation = (partial: Partial<CatalogOperation>): CatalogOperation => ({
    enabled: true,
    available: true,
    method: 'GET',
    path: '/invoices/{id}',
    risk: 'read',
    confirmation: 'never',
    timeoutMs: 30000,
    maxRequestBytes: 10485760,
    maxResponseBytes: 10485760,
    maxConcurrency: 4,
    security: [['apiKey']],
    ...partial,
  });
  return {
    catalogVersion: '2.0',
    api: { id: 'billing', title: 'Billing API', version: '1.0' },
    provenance: { sourceType: 'manual' },
    checksum: TEST_CATALOG_CHECKSUM,
    securitySchemes: {
      apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
    },
    operations: {
      'invoice.get': operation({}),
      'invoices.post': operation({
        method: 'POST',
        path: '/invoices',
        risk: 'write',
        confirmation: 'write',
        timeoutMs: 5000,
        maxRequestBytes: 262144,
        request: {
          body: { kind: 'json', contentTypes: ['application/json'] },
        },
      }),
      'invoice.delete': operation({
        method: 'DELETE',
        path: '/invoices/{id}',
        risk: 'destructive',
        confirmation: 'destructive',
        enabled: false,
      }),
    },
  };
}

export function sampleRegistryDoc(
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
      {
        id: 'globex-automation',
        tenantId: 'globex',
        allowedConnectionIds: ['globex-billing-prod'],
      },
    ],
    backends: [
      {
        id: 'billing',
        title: 'Billing API',
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
          valueRef: 'env:ACME_BILLING_API_KEY',
        },
      },
      {
        id: 'globex-billing-prod',
        tenantId: 'globex',
        backendId: 'billing',
        baseUrl: 'https://example.com',
        auth: {
          type: 'apiKey',
          in: 'query',
          name: 'api_key',
          valueRef: 'env:GLOBEX_BILLING_API_KEY',
        },
      },
    ],
    ...overrides,
  };
}

export function sampleSnapshot(revision = 1): RegistrySnapshot {
  return snapshotFromDocument(
    sampleRegistryDoc(),
    new Map([[TEST_CATALOG_REF, sampleCatalog()]]),
    revision,
  );
}
