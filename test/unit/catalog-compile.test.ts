import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalize } from '../../src/catalog/canonical';
import { compileCatalog, CompileError } from '../../src/catalog/compile';
import type { NormalizedApiModel, PolicyOverlay } from '../../src/catalog/types';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'catalog');
const FIXED_NOW = new Date('2026-08-03T00:00:00.000Z');

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURES, file), 'utf8')) as T;
}

function modelWith(
  ...overrides: Array<Partial<NormalizedApiModel>>
): NormalizedApiModel {
  return {
    api: { id: 'x', title: 'X API', version: '1.0.0' },
    securitySchemes: {},
    operations: [],
    ...Object.assign({}, ...overrides),
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

describe('catalog compilation', () => {
  it('matches the golden catalog byte-for-byte', () => {
    const model = readJson<NormalizedApiModel>('sample-api-model.json');
    const overlay = readJson<PolicyOverlay>('sample-overlay.json');
    const { catalog } = compileCatalog(model, overlay, {
      sourceType: 'manual',
      now: FIXED_NOW,
    });
    const golden = readFileSync(path.join(FIXTURES, 'sample-catalog.json'), 'utf8');
    expect(JSON.stringify(catalog, null, 2) + '\n').toBe(golden);
  });

  it('is deterministic for identical inputs', () => {
    const model = readJson<NormalizedApiModel>('sample-api-model.json');
    const overlay = readJson<PolicyOverlay>('sample-overlay.json');
    const a = compileCatalog(model, overlay, { now: FIXED_NOW }).catalog;
    const b = compileCatalog(model, overlay, { now: FIXED_NOW }).catalog;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('varies only by generatedAt across compile times', () => {
    const model = readJson<NormalizedApiModel>('sample-api-model.json');
    const a = compileCatalog(model, undefined, {
      now: new Date('2026-01-01T00:00:00.000Z'),
    }).catalog;
    const b = compileCatalog(model, undefined, {
      now: new Date('2026-02-01T00:00:00.000Z'),
    }).catalog;
    expect(a.provenance.generatedAt).not.toBe(b.provenance.generatedAt);
    const exclude = (key: string, path: string): boolean =>
      key === 'checksum' || path === 'provenance.generatedAt';
    expect(canonicalize(a, exclude)).toBe(canonicalize(b, exclude));
  });

  it('generates deterministic operation IDs', () => {
    const { catalog, warnings } = compileCatalog(
      modelWith({
        operations: [
          {
            method: 'GET',
            path: '/invoices/{invoiceId}',
            parameters: [{ in: 'path', name: 'invoiceId', required: true }],
            responses: {},
          },
        ],
      }),
      undefined,
      { now: FIXED_NOW },
    );
    expect(Object.keys(catalog.operations)).toEqual(['invoices.get']);
    expect(warnings.some((warning) => warning.code === 'GENERATED_OPERATION_ID')).toBe(
      true,
    );
  });

  it('reports duplicate generated and explicit operation IDs', () => {
    const duplicateGenerated = modelWith({
      operations: [
        { method: 'GET', path: '/invoices/{a}', responses: {} },
        { method: 'GET', path: '/invoices/{b}', responses: {} },
      ],
    });
    expect(compileIssues(() => compileCatalog(duplicateGenerated))).toContain(
      'DUPLICATE_OPERATION_ID',
    );

    const duplicateExplicit = modelWith({
      operations: [
        { operationId: 'same.op', method: 'GET', path: '/a', responses: {} },
        { operationId: 'same.op', method: 'POST', path: '/b', responses: {} },
      ],
    });
    expect(compileIssues(() => compileCatalog(duplicateExplicit))).toContain(
      'DUPLICATE_OPERATION_ID',
    );
  });

  it('infers risk and confirmation from the HTTP method', () => {
    const { catalog } = compileCatalog(
      modelWith({
        operations: [
          { method: 'GET', path: '/a', responses: {} },
          { method: 'POST', path: '/b', responses: {} },
          { method: 'DELETE', path: '/c', responses: {} },
        ],
      }),
      undefined,
      { now: FIXED_NOW },
    );
    expect(catalog.operations['a.get']).toMatchObject({
      risk: 'read',
      confirmation: 'never',
    });
    expect(catalog.operations['b.post']).toMatchObject({
      risk: 'write',
      confirmation: 'write',
    });
    expect(catalog.operations['c.delete']).toMatchObject({
      risk: 'destructive',
      confirmation: 'destructive',
    });
  });

  it('applies overlay annotations, limits, and restrictions', () => {
    const model = readJson<NormalizedApiModel>('sample-api-model.json');
    const overlay = readJson<PolicyOverlay>('sample-overlay.json');
    const { catalog } = compileCatalog(model, overlay, { now: FIXED_NOW });

    const read = catalog.operations['invoice.get'] as Record<string, unknown>;
    expect(read.description).toBe('Fetch a single invoice (policy-reviewed)');
    expect(read.cache).toEqual({ eligible: true, ttlSeconds: 300 });
    expect(read.redactions).toEqual([{ fields: ['customerEmail'] }]);

    expect(catalog.operations['invoices.post']).toMatchObject({
      maxRequestBytes: 262144,
      timeoutMs: 5000,
    });

    expect(catalog.operations['invoice.delete']?.enabled).toBe(false);
    expect(catalog.operations['invoice.delete']?.available).toBe(true);
  });

  it('overlays cannot invent operations', () => {
    const overlay: PolicyOverlay = {
      overlayVersion: '1.0',
      operations: { 'ghost.op': { risk: 'read' } },
    };
    const issues = compileIssues(() =>
      compileCatalog(
        modelWith({ operations: [{ method: 'GET', path: '/a', responses: {} }] }),
        overlay,
      ),
    );
    expect(issues).toContain('OVERLAY_UNKNOWN_OPERATION');
  });

  it('overlays cannot change method or path', () => {
    const overlay = {
      overlayVersion: '1.0',
      operations: { 'a.get': { method: 'POST', path: '/other' } },
    } as unknown as PolicyOverlay;
    const issues = compileIssues(() =>
      compileCatalog(
        modelWith({ operations: [{ method: 'GET', path: '/a', responses: {} }] }),
        overlay,
      ),
    );
    expect(issues).toContain('INVALID_OVERLAY');
  });

  it('disables operations with unsupported security schemes and warns', () => {
    const model = readJson<NormalizedApiModel>('sample-api-model.json');
    const { catalog, warnings } = compileCatalog(model, undefined, { now: FIXED_NOW });
    expect(catalog.operations['report.run']?.available).toBe(false);
    expect(
      warnings.some((warning) => warning.code === 'UNSUPPORTED_SECURITY_SCHEME'),
    ).toBe(true);
  });

  it('fails closed on unresolved security schemes', () => {
    const unresolved = modelWith({
      operations: [
        { method: 'GET', path: '/a', responses: {}, security: [['missing']] },
      ],
    });
    expect(compileIssues(() => compileCatalog(unresolved))).toContain(
      'UNRESOLVED_SECURITY_SCHEME',
    );
  });

  it('fails closed on unsupported request content types', () => {
    const xml = modelWith({
      operations: [
        {
          method: 'POST',
          path: '/a',
          responses: {},
          requestBody: { contentTypes: ['application/xml'] },
        },
      ],
    });
    expect(compileIssues(() => compileCatalog(xml))).toContain(
      'UNSUPPORTED_CONTENT_TYPE',
    );
  });

  it('fails closed on unsafe paths', () => {
    for (const unsafePath of ['../evil', '/a b', '/x/{id', '/x/}']) {
      const issues = compileIssues(() =>
        compileCatalog(
          modelWith({
            operations: [{ method: 'GET', path: unsafePath, responses: {} }],
          }),
        ),
      );
      expect(issues).toContain('UNSAFE_PATH');
    }
  });

  it('rejects an empty normalized model', () => {
    expect(
      compileIssues(() => compileCatalog(modelWith({ operations: [] }))),
    ).toContain('EMPTY_MODEL');
  });
});
