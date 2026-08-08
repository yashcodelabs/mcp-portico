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

  it('keeps operations available when at least one OR security alternative is supported', () => {
    const { catalog, warnings } = compileCatalog(
      modelWith({
        securitySchemes: {
          apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
          oauth2: { type: 'oauth2' },
        },
        operations: [
          {
            method: 'GET',
            path: '/a',
            responses: {},
            security: [['apiKey'], ['oauth2']],
          },
          {
            method: 'GET',
            path: '/b',
            responses: {},
            security: [['oauth2'], []],
          },
          {
            method: 'GET',
            path: '/c',
            responses: {},
            security: [['oauth2', 'apiKey']],
          },
        ],
      }),
      undefined,
      { now: FIXED_NOW },
    );
    // OR semantics: the apiKey alternative keeps /a executable; the empty
    // alternative keeps /b executable; /c requires both schemes AND-ed, so
    // the unsupported oauth2 still disables it.
    expect(catalog.operations['a.get']?.available).toBe(true);
    expect(catalog.operations['b.get']?.available).toBe(true);
    expect(catalog.operations['c.get']?.available).toBe(false);
    const unsupported = warnings.filter(
      (warning) => warning.code === 'UNSUPPORTED_SECURITY_SCHEME',
    );
    expect(unsupported).toHaveLength(3);
    expect(
      unsupported.filter((warning) =>
        warning.message.includes(
          'operation stays available through a supported alternative',
        ),
      ),
    ).toHaveLength(2);
    expect(
      unsupported.some((warning) =>
        warning.message.includes('operation is unavailable'),
      ),
    ).toBe(true);
  });

  it('fails closed on out-of-range AI confidence even for manual models', () => {
    const issues = compileIssues(() =>
      compileCatalog(
        modelWith({
          operations: [
            {
              method: 'GET',
              path: '/a',
              responses: {},
              aiConfidence: 2,
            },
          ],
        }),
      ),
    );
    expect(issues).toContain('INVALID_AI_CONFIDENCE');
  });

  it('gates operations whose required request body is unsupported', () => {
    const { catalog, warnings } = compileCatalog(
      modelWith({
        operations: [
          {
            method: 'POST',
            path: '/a',
            responses: {},
            requiredBodyUnsupported: true,
          },
        ],
      }),
      undefined,
      { now: FIXED_NOW },
    );
    expect(catalog.operations['a.post']?.available).toBe(false);
    expect(
      warnings.some((warning) => warning.code === 'UNSUPPORTED_REQUIRED_BODY'),
    ).toBe(true);
  });

  it('sanitizes protected overlay headers out of the catalog', () => {
    const overlay: PolicyOverlay = {
      overlayVersion: '1.0',
      operations: {
        'a.get': {
          headers: {
            Authorization: 'Bearer secret-token',
            'X-API-Key': 'api-key-value',
            'X-Trace-Id': 'trace-123',
          },
        },
      },
    };
    const { catalog, warnings } = compileCatalog(
      modelWith({
        operations: [{ method: 'GET', path: '/a', responses: {} }],
      }),
      overlay,
      { now: FIXED_NOW },
    );
    expect(catalog.operations['a.get']?.headers).toEqual({ 'X-Trace-Id': 'trace-123' });
    const sanitized = warnings.filter(
      (warning) => warning.code === 'SANITIZED_PROTECTED_HEADER',
    );
    expect(sanitized.map((warning) => warning.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Authorization'),
        expect.stringContaining('X-API-Key'),
      ]),
    );
  });

  it('redacts credential-shaped example values before compilation', () => {
    const { catalog, warnings } = compileCatalog(
      modelWith({
        operations: [
          {
            method: 'POST',
            path: '/a',
            responses: {},
            examples: [
              {
                location: 'request',
                contentType: 'application/json',
                example: { token: 'sk-secret-token', name: 'Rex' },
              },
            ],
          },
        ],
      }),
      undefined,
      { now: FIXED_NOW },
    );
    const examples = catalog.operations['a.post']?.examples as Array<{
      example: Record<string, unknown>;
    }>;
    expect(examples[0]?.example).toEqual({
      token: '<redacted>',
      name: 'Rex',
    });
    expect(JSON.stringify(catalog)).not.toContain('sk-secret-token');
    expect(warnings.some((warning) => warning.code === 'SANITIZED_EXAMPLE')).toBe(true);
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
