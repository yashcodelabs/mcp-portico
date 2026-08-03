import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadCatalog } from '../../src/catalog/load';
import { PorticoError } from '../../src/shared/errors';

const GOLDEN = path.join(__dirname, '..', 'fixtures', 'catalog', 'sample-catalog.json');

describe('catalog loading and indexing', () => {
  it('loads, validates, and indexes the golden catalog', () => {
    const { catalog, index } = loadCatalog(GOLDEN);
    expect(catalog.catalogVersion).toBe('2.0');
    expect(index.ids()).toEqual([
      'invoice.delete',
      'invoice.get',
      'invoices.post',
      'report.run',
    ]);
    expect(index.has('invoice.get')).toBe(true);
    expect(index.get('invoice.get')?.path).toBe('/invoices/{invoiceId}');
    expect(index.get('invoice.get')?.risk).toBe('read');
  });

  it('indexes by tag, risk, and enabled state', () => {
    const { index } = loadCatalog(GOLDEN);
    expect(index.byTag('invoices')).toEqual([
      'invoice.delete',
      'invoice.get',
      'invoices.post',
    ]);
    expect(index.byTag('reports')).toEqual(['report.run']);
    expect(index.byRisk('read')).toEqual(['invoice.get', 'report.run']);
    expect(index.byRisk('write')).toEqual(['invoices.post']);
    expect(index.enabledIds()).toEqual(['invoice.get', 'invoices.post', 'report.run']);
  });

  it('throws a structured error for an invalid catalog', () => {
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
