import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { compileCatalog, CompileError } from '../../src/catalog/compile';
import { loadCatalog } from '../../src/catalog/load';
import { validateCatalog } from '../../src/catalog/validate';
import type { Catalog, NormalizedApiModel } from '../../src/catalog/types';
import { PorticoError } from '../../src/shared/errors';

const GOLDEN = path.join(__dirname, '..', 'fixtures', 'catalog', 'sample-catalog.json');
const FIXED_NOW = new Date('2026-08-03T00:00:00.000Z');

function model(operations: NormalizedApiModel['operations']): NormalizedApiModel {
  return {
    api: { id: 'x', title: 'X API', version: '1.0.0' },
    securitySchemes: {},
    operations,
  };
}

function compileIssues(fn: () => unknown): string[] {
  try {
    fn();
    return [];
  } catch (error) {
    if (error instanceof CompileError) return error.issues.map((issue) => issue.code);
    throw error;
  }
}

describe('catalog semantic validation', () => {
  it('accepts the golden catalog', () => {
    const { catalog } = loadCatalog(GOLDEN);
    expect(validateCatalog(catalog)).toEqual([]);
  });

  it('detects checksum mismatches when content changes', () => {
    const { catalog } = loadCatalog(GOLDEN);
    const mutated: Catalog = JSON.parse(JSON.stringify(catalog)) as Catalog;
    (mutated.operations['invoice.get'] as Record<string, unknown>).summary = 'tampered';
    const issues = validateCatalog(mutated);
    expect(issues.some((issue) => issue.code === 'CHECKSUM_MISMATCH')).toBe(true);
  });

  it('rejects path parameters that are not declared', () => {
    const issues = compileIssues(() =>
      compileCatalog(
        model([
          {
            operationId: 'x.get',
            method: 'GET',
            path: '/invoices/{invoiceId}',
            responses: {},
          },
        ]),
        undefined,
        { now: FIXED_NOW },
      ),
    );
    expect(issues).toContain('UNDECLARED_PATH_PARAMETER');
  });

  it('rejects path parameters that are not required', () => {
    const issues = compileIssues(() =>
      compileCatalog(
        model([
          {
            operationId: 'x.get',
            method: 'GET',
            path: '/invoices/{invoiceId}',
            parameters: [{ in: 'path', name: 'invoiceId', required: false }],
            responses: {},
          },
        ]),
        undefined,
        { now: FIXED_NOW },
      ),
    );
    expect(issues).toContain('INVALID_PARAMETER');
  });

  it('rejects invalid response statuses', () => {
    const issues = compileIssues(() =>
      compileCatalog(
        model([
          {
            operationId: 'x.get',
            method: 'GET',
            path: '/x',
            responses: { '20X': {} },
          },
        ]),
        undefined,
        { now: FIXED_NOW },
      ),
    );
    expect(issues).toContain('INVALID_RESPONSE_STATUS');
  });

  it('rejects unsupported response content types', () => {
    const issues = compileIssues(() =>
      compileCatalog(
        model([
          {
            operationId: 'x.get',
            method: 'GET',
            path: '/x',
            responses: { '200': { contentTypes: ['application/pdf'] } },
          },
        ]),
        undefined,
        { now: FIXED_NOW },
      ),
    );
    expect(issues).toContain('UNSUPPORTED_CONTENT_TYPE');
  });

  it('rejects catalogs that do not match the schema via loadCatalog', () => {
    const invalid = path.join(
      __dirname,
      '..',
      'fixtures',
      'catalog',
      'invalid',
      'unknown-field.json',
    );
    let caught: unknown;
    try {
      loadCatalog(invalid);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PorticoError);
    expect((caught as PorticoError).code).toBe('CONFIG_ERROR');
  });
});
