import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CompileError } from '../../src/catalog/compile';
import { loadCatalog } from '../../src/catalog/load';
import type { Catalog, PolicyOverlay } from '../../src/catalog/types';
import { importOpenApi } from '../../src/importers/openapi/import';
import type { ImportOptions } from '../../src/importers/openapi/types';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'analyze');
const FIXED_NOW = new Date('2026-08-07T00:00:00.000Z');

interface GoldenFixture {
  name: string;
  apiId: string;
  rootConfidence: number;
}

const GOLDEN: GoldenFixture[] = [
  { name: 'express-orders', apiId: 'orders', rootConfidence: 0.85 },
  { name: 'fastapi-tasks', apiId: 'tasks', rootConfidence: 0.9 },
  {
    name: 'express-orders-unresolved',
    apiId: 'orders-unresolved',
    rootConfidence: 0.7,
  },
];

function out(name: string, file: string): string {
  return path.join(FIXTURES, name, 'analysis', 'out', file);
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function importFixture(
  name: string,
  apiId: string,
  options: Partial<ImportOptions> = {},
) {
  return importOpenApi(out(name, 'openapi.yaml'), {
    apiId,
    sourceType: 'ai',
    now: FIXED_NOW,
    overlay: readJson<PolicyOverlay>(out(name, 'overlay.json')),
    ...options,
  });
}

describe('AI-analysis fixture artifacts', () => {
  it.each(GOLDEN)(
    'compiles the $name golden artifacts into a matching AI catalog',
    async ({ name, apiId, rootConfidence }) => {
      const golden = readJson<Catalog>(out(name, 'catalog.json'));
      const { catalog } = await importFixture(name, apiId);

      expect(catalog.provenance.sourceType).toBe('ai');
      expect(catalog.provenance.confidence).toBe(rootConfidence);
      expect(catalog.checksum).toBe(golden.checksum);
      expect(Object.keys(catalog.operations).sort()).toEqual(
        Object.keys(golden.operations).sort(),
      );

      // The persisted golden artifact must load, validate, and re-checksum.
      expect(() => loadCatalog(out(name, 'catalog.json'))).not.toThrow();
    },
  );

  it('marks every express-orders and fastapi-tasks operation available', async () => {
    for (const { name, apiId } of GOLDEN.slice(0, 2)) {
      const { catalog } = await importFixture(name, apiId);
      for (const operation of Object.values(catalog.operations)) {
        expect(operation.available).toBe(true);
      }
    }
  });

  it('gates unresolved-auth and low-confidence operations in the unresolved fixture', async () => {
    const { catalog } = await importFixture(
      'express-orders-unresolved',
      'orders-unresolved',
    );

    expect(catalog.operations['orders.get']?.available).toBe(false);
    expect(catalog.operations['orders.update']?.available).toBe(false);
    for (const id of ['orders.list', 'orders.create', 'uploads.create', 'health.get']) {
      expect(catalog.operations[id]?.available).toBe(true);
    }

    const warnings = catalog.provenance.warnings ?? [];
    const unresolved = warnings.find(
      (warning) => warning.code === 'UNRESOLVED_AUTHORIZATION',
    );
    const lowConfidence = warnings.find((warning) => warning.code === 'LOW_CONFIDENCE');
    expect(unresolved?.message).toContain('orders.get');
    expect(lowConfidence?.message).toContain('orders.update');
  });

  it('imports each fixture deterministically with a stable checksum', async () => {
    for (const { name, apiId } of GOLDEN) {
      const golden = readJson<Catalog>(out(name, 'catalog.json'));
      const first = await importFixture(name, apiId);
      const second = await importFixture(name, apiId);

      expect(second.catalog.checksum).toBe(first.catalog.checksum);
      expect(JSON.stringify(second.catalog)).toBe(JSON.stringify(first.catalog));
      expect(first.catalog.checksum).toBe(golden.checksum);
    }
  });

  it('keeps parseable review reports with the documented shape', () => {
    for (const { name } of GOLDEN) {
      const report = readJson<{
        reportVersion: string;
        apiId: string;
        coverage: { discoveredRoutes: number };
        auth: unknown;
        schemas: unknown;
        confidence: { overall: number };
      }>(out(name, 'review-report.json'));

      expect(report.reportVersion).toBe('1.0');
      expect(typeof report.apiId).toBe('string');
      expect(report.coverage.discoveredRoutes).toBeGreaterThan(0);
      expect(report.auth).toBeDefined();
      expect(report.schemas).toBeDefined();
      expect(typeof report.confidence.overall).toBe('number');
    }
  });

  it('rejects an overlay that invents an operation for express-orders', async () => {
    const overlay = readJson<PolicyOverlay>(out('express-orders', 'overlay.json'));
    overlay.operations['orders.invented'] = { enabled: true };

    const error = await importFixture('express-orders', 'orders', {
      overlay,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CompileError);
    expect((error as CompileError).issues.map((issue) => issue.code)).toContain(
      'OVERLAY_UNKNOWN_OPERATION',
    );
  });
});
