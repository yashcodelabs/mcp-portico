import { describe, expect, it } from 'vitest';

import { validateCatalogSchema } from '../../src/catalog/schema';

const VALID = {
  catalogVersion: '2.0',
  api: { id: 'billing', title: 'Billing API', version: '1.4.0' },
  provenance: { sourceType: 'manual' },
  operations: {
    'invoice.get': {
      method: 'GET',
      path: '/invoices/{invoiceId}',
      risk: 'read',
      security: [['apiKey']],
      request: {
        parameters: {
          path: [{ in: 'path', name: 'invoiceId', required: true }],
          query: [{ in: 'query', name: 'currency', required: false }],
        },
        body: {
          kind: 'json',
          contentTypes: ['application/json'],
          required: true,
        },
      },
      responses: {
        '200': { contentTypes: ['application/json'] },
      },
    },
  },
};

describe('catalog v2 schema', () => {
  it('accepts a valid catalog', () => {
    expect(validateCatalogSchema(VALID)).toEqual([]);
  });

  it('rejects an unknown catalog version', () => {
    expect(
      validateCatalogSchema({ ...VALID, catalogVersion: '3.0' })[0]?.message,
    ).toContain('must be equal to constant');
  });

  it('rejects missing required sections', () => {
    const issues = validateCatalogSchema({ catalogVersion: '2.0' });
    expect(
      issues.some((issue) =>
        issue.message.includes("must have required property 'operations'"),
      ),
    ).toBe(true);
  });

  it('rejects invalid methods, risks, and unknown operation fields', () => {
    const badMethod = structuredClone(VALID);
    (badMethod.operations['invoice.get'] as Record<string, unknown>).method = 'FETCH';
    expect(
      validateCatalogSchema(badMethod).some((issue) =>
        issue.message.includes('must be equal to one of the allowed values'),
      ),
    ).toBe(true);

    const badRisk = structuredClone(VALID);
    (badRisk.operations['invoice.get'] as Record<string, unknown>).risk = 'dangerous';
    expect(
      validateCatalogSchema(badRisk).some((issue) =>
        issue.message.includes('must be equal to one of the allowed values'),
      ),
    ).toBe(true);

    const unknownField = structuredClone(VALID);
    (unknownField.operations['invoice.get'] as Record<string, unknown>).bogus = true;
    expect(
      validateCatalogSchema(unknownField).some((issue) =>
        issue.message.includes('must NOT have additional properties'),
      ),
    ).toBe(true);
  });

  it('rejects invalid operation IDs', () => {
    const badId = structuredClone(VALID);
    (badId.operations as Record<string, unknown>)['bad id!'] =
      badId.operations['invoice.get'];
    delete (badId.operations as Record<string, unknown>)['invoice.get'];
    expect(
      validateCatalogSchema(badId).some((issue) =>
        issue.message.includes('must match pattern'),
      ),
    ).toBe(true);
  });
});
