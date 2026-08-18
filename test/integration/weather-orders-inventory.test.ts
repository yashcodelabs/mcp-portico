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
  'weather-orders-inventory',
);
const APIS = path.join(USE_CASE, 'apis');
const IMPORT_NOW = new Date('2026-08-09T00:00:00.000Z');

const fixtures = [
  {
    id: 'weather',
    spec: path.join(APIS, 'open-meteo.openapi.yaml'),
    catalog: path.join(APIS, 'open-meteo.catalog.json'),
    operationIds: ['weather.forecast'],
  },
  {
    id: 'orders',
    spec: path.join(APIS, 'orders.openapi.yaml'),
    catalog: path.join(APIS, 'orders.catalog.json'),
    operationIds: ['orders.list'],
  },
  {
    id: 'inventory',
    spec: path.join(APIS, 'inventory.openapi.yaml'),
    catalog: path.join(APIS, 'inventory.catalog.json'),
    operationIds: ['inventory.list'],
  },
] as const;

describe('weather-orders-inventory use-case artifacts', () => {
  it('keeps the checked-in catalogs aligned with their OpenAPI sources', async () => {
    for (const fixture of fixtures) {
      const imported = await importOpenApi(fixture.spec, {
        apiId: fixture.id,
        sourceType: 'openapi',
        now: IMPORT_NOW,
      });
      const checkedIn = loadCatalog(fixture.catalog).catalog;
      expect(Object.keys(imported.catalog.operations)).toEqual(fixture.operationIds);
      expect(checkedIn.checksum).toBe(imported.catalog.checksum);
      expect(checkedIn.provenance.sourceChecksum).toBe(
        imported.catalog.provenance.sourceChecksum,
      );
      for (const operationId of fixture.operationIds) {
        expect(checkedIn.operations[operationId]).toMatchObject({
          risk: 'read',
          confirmation: 'never',
          enabled: true,
          available: true,
        });
      }
    }
  });

  it('pins public weather and private fulfillment connections to the catalogs', () => {
    const snapshot = buildRegistrySnapshot(path.join(USE_CASE, 'registry.yaml'));
    expect(snapshot.document.principals[0]?.allowedConnectionIds).toEqual([
      'weather',
      'orders',
      'inventory',
    ]);
    expect(snapshot.document.connections).toMatchObject([
      { id: 'weather', baseUrl: 'https://api.open-meteo.com' },
      { id: 'orders', baseUrl: 'http://127.0.0.1:4030' },
      { id: 'inventory', baseUrl: 'http://127.0.0.1:4040' },
    ]);
    expect(snapshot.document.backends).toHaveLength(3);
    for (const backend of snapshot.document.backends) {
      expect(snapshot.catalogForBackend(backend.id)).toBeDefined();
    }
  });
});
