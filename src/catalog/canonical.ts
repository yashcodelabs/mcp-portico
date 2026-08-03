import { createHash } from 'node:crypto';

/**
 * Deterministic serialization helpers.
 *
 * Identical inputs must produce byte-identical canonical output. Object keys
 * are sorted recursively, `undefined` values are dropped, and array order is
 * preserved. Callers may exclude volatile fields (checksum, generatedAt).
 */

export type ExcludeKey = (key: string, path: string) => boolean;

export function canonicalize(value: unknown, exclude?: ExcludeKey): string {
  return JSON.stringify(sortValue(value, '', exclude));
}

function sortValue(value: unknown, path: string, exclude?: ExcludeKey): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => sortValue(item, `${path}[${index}]`, exclude));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const keyPath = path ? `${path}.${key}` : key;
      if (exclude !== undefined && exclude(key, keyPath)) continue;
      const item = record[key];
      if (item === undefined) continue;
      out[key] = sortValue(item, keyPath, exclude);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function checksum(value: unknown, exclude?: ExcludeKey): string {
  return `sha256:${sha256Hex(canonicalize(value, exclude))}`;
}

/**
 * Exclude the catalog's self-referential checksum and the explicitly
 * excluded provenance timestamp so byte-identical inputs hash identically.
 */
export const CATALOG_CHECKSUM_EXCLUDE: ExcludeKey = (key, path) =>
  key === 'checksum' || path === 'provenance.generatedAt';
