import { describe, expect, it } from 'vitest';

import { compileCatalog } from '../../src/catalog/compile';
import { diffCatalogs } from '../../src/catalog/diff';
import type { NormalizedApiModel, PolicyOverlay } from '../../src/catalog/types';

const FIXED_NOW = new Date('2026-08-03T00:00:00.000Z');

function baseModel(): NormalizedApiModel {
  return {
    api: { id: 'x', title: 'X API', version: '1.0.0' },
    securitySchemes: {},
    operations: [
      {
        operationId: 'invoice.get',
        method: 'GET',
        path: '/invoices/{invoiceId}',
        parameters: [{ in: 'path', name: 'invoiceId', required: true }],
        responses: { '200': { contentTypes: ['application/json'] } },
      },
      {
        method: 'POST',
        path: '/invoices',
        requestBody: { contentTypes: ['application/json'] },
        responses: { '201': {} },
      },
      {
        operationId: 'invoice.delete',
        method: 'DELETE',
        path: '/invoices/{invoiceId}',
        parameters: [{ in: 'path', name: 'invoiceId', required: true }],
        responses: { '204': {} },
      },
    ],
  };
}

function overlay(patch: Partial<PolicyOverlay['operations']>): PolicyOverlay {
  return { overlayVersion: '1.0', operations: patch };
}

describe('catalog diff', () => {
  it('classifies additions, removals, schema, risk, and limits changes', () => {
    const oldModel = baseModel();
    const oldOverlay = overlay({
      'invoice.get': { risk: 'write' },
      'invoices.post': { timeoutMs: 10_000 },
    });

    const newModel = baseModel();
    newModel.operations = newModel.operations.filter(
      (operation) => operation.operationId !== 'invoice.delete',
    );
    const invoiceGet = newModel
      .operations[0] as NormalizedApiModel['operations'][number];
    invoiceGet.parameters = [
      { in: 'path', name: 'invoiceId', required: true },
      { in: 'query', name: 'verbose', required: false },
    ];
    newModel.operations.push({
      operationId: 'reports.get',
      method: 'GET',
      path: '/reports/usage',
      responses: { '200': {} },
    });
    const newOverlay = overlay({
      'invoice.get': { risk: 'read' },
      'invoices.post': { timeoutMs: 20_000 },
    });

    const oldCatalog = compileCatalog(oldModel, oldOverlay, { now: FIXED_NOW }).catalog;
    const newCatalog = compileCatalog(newModel, newOverlay, { now: FIXED_NOW }).catalog;
    const diff = diffCatalogs(oldCatalog, newCatalog);

    expect(diff.additions).toEqual(['reports.get']);
    expect(diff.removals).toEqual(['invoice.delete']);
    expect(diff.changes).toHaveLength(2);

    const invoiceGetDiff = diff.changes.find(
      (change) => change.operationId === 'invoice.get',
    );
    expect(invoiceGetDiff?.kinds).toContain('schemaChanged');
    expect(invoiceGetDiff?.kinds).toContain('riskChanged');

    const invoicesPostDiff = diff.changes.find(
      (change) => change.operationId === 'invoices.post',
    );
    expect(invoicesPostDiff?.kinds).toEqual(['limitsChanged']);
  });

  it('returns an empty diff for identical catalogs', () => {
    const oldCatalog = compileCatalog(baseModel(), undefined, {
      now: FIXED_NOW,
    }).catalog;
    const newCatalog = compileCatalog(baseModel(), undefined, {
      now: FIXED_NOW,
    }).catalog;
    const diff = diffCatalogs(oldCatalog, newCatalog);
    expect(diff.additions).toEqual([]);
    expect(diff.removals).toEqual([]);
    expect(diff.changes).toEqual([]);
  });

  it('classifies security and metadata changes', () => {
    const oldModel = baseModel();
    oldModel.securitySchemes = {
      apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
    };
    oldModel.operations[0] = {
      ...(oldModel.operations[0] as NormalizedApiModel['operations'][number]),
      security: [['apiKey']],
    };
    const newModel = baseModel();
    newModel.operations[0] = {
      ...(newModel.operations[0] as NormalizedApiModel['operations'][number]),
      summary: 'new summary',
    };

    const oldCatalog = compileCatalog(oldModel, undefined, { now: FIXED_NOW }).catalog;
    const newCatalog = compileCatalog(newModel, undefined, { now: FIXED_NOW }).catalog;
    const diff = diffCatalogs(oldCatalog, newCatalog);
    const change = diff.changes.find((entry) => entry.operationId === 'invoice.get');
    expect(change?.kinds).toContain('securityChanged');
    expect(change?.kinds).toContain('metadataChanged');
  });
});
