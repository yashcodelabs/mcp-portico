import fs from 'node:fs';

import { PorticoError } from '../shared/errors';
import { CatalogIndex } from './index';
import { validateCatalogSchema } from './schema';
import { validateCatalog } from './validate';
import type { Catalog } from './types';

export interface LoadedCatalog {
  catalog: Catalog;
  index: CatalogIndex;
}

/** Load, validate (schema + semantics + checksum), and index a catalog file. */
export function loadCatalog(filePath: string): LoadedCatalog {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new PorticoError('NOT_FOUND', `catalog file not found: ${filePath}`, {
      cause: error,
    });
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new PorticoError(
      'CONFIG_ERROR',
      `catalog file is not valid JSON: ${filePath}`,
      { cause: error },
    );
  }

  const schemaIssues = validateCatalogSchema(data);
  if (schemaIssues.length > 0) {
    throw new PorticoError('CONFIG_ERROR', `catalog is invalid: ${filePath}`, {
      details: { schemaIssues },
    });
  }

  const catalog = data as Catalog;
  const semanticIssues = validateCatalog(catalog);
  if (semanticIssues.length > 0) {
    throw new PorticoError('CONFIG_ERROR', `catalog is invalid: ${filePath}`, {
      details: { issues: semanticIssues },
    });
  }

  return { catalog, index: new CatalogIndex(catalog) };
}
