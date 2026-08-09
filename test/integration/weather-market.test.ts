import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadCatalog } from '../../src/catalog/load';
import { importOpenApi } from '../../src/importers/openapi/import';
import { buildRegistrySnapshot } from '../../src/registry/snapshot';

const USE_CASE = path.join(
  __dirname,
  '..',
  '..',
  'examples',
  'use-cases',
  'weather-market',
);
const IMPORT_NOW = new Date('2026-08-09T00:00:00.000Z');

const APIS = [
  {
    id: 'weather',
    spec: 'open-meteo.openapi.yaml',
    catalog: 'open-meteo.catalog.json',
    operationIds: ['weather.forecast'],
  },
  {
    id: 'crypto-market',
    spec: 'coingecko.openapi.yaml',
    catalog: 'coingecko.catalog.json',
    operationIds: ['market.simple_price'],
  },
  {
    id: 'fx',
    spec: 'frankfurter.openapi.yaml',
    catalog: 'frankfurter.catalog.json',
    operationIds: ['fx.latest'],
  },
] as const;

describe('weather-market use-case artifacts', () => {
  it('compiles each public API spec into its checked-in catalog', async () => {
    for (const api of APIS) {
      const imported = await importOpenApi(path.join(USE_CASE, 'apis', api.spec), {
        apiId: api.id,
        sourceType: 'openapi',
        now: IMPORT_NOW,
      });
      const checkedIn = loadCatalog(path.join(USE_CASE, 'apis', api.catalog));

      expect(Object.keys(imported.catalog.operations).sort()).toEqual(
        [...api.operationIds].sort(),
      );
      expect(checkedIn.catalog.checksum).toBe(imported.catalog.checksum);
      expect(checkedIn.catalog.provenance.sourceChecksum).toBe(
        imported.catalog.provenance.sourceChecksum,
      );
      for (const operationId of api.operationIds) {
        expect(checkedIn.catalog.operations[operationId]).toMatchObject({
          enabled: true,
          available: true,
          risk: 'read',
          confirmation: 'never',
        });
      }
    }
  });

  it('builds one tenant-scoped registry with three independent connections', () => {
    const snapshot = buildRegistrySnapshot(path.join(USE_CASE, 'registry.yaml'));

    expect(snapshot.document.tenants).toEqual([
      { id: 'local-research', name: 'Local Research' },
    ]);
    expect(snapshot.document.principals[0]?.allowedConnectionIds).toEqual([
      'weather',
      'crypto-market',
      'fx',
    ]);
    expect(
      snapshot.document.connections.map((connection) => connection.baseUrl),
    ).toEqual([
      'https://api.open-meteo.com',
      'https://api.coingecko.com',
      'https://api.frankfurter.dev',
    ]);
    expect(snapshot.document.backends).toHaveLength(3);
    for (const backend of snapshot.document.backends) {
      expect(snapshot.catalogForBackend(backend.id)).toBeDefined();
    }
  });
});
