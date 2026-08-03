import { canonicalize } from './canonical';
import type {
  Catalog,
  CatalogDiff,
  CatalogOperation,
  DiffKind,
  OperationDiff,
} from './types';

/**
 * Classify structural differences between two catalogs: additions, removals,
 * schema changes, risk changes, security changes, limits changes, and
 * metadata changes.
 */
export function diffCatalogs(oldCatalog: Catalog, newCatalog: Catalog): CatalogDiff {
  const oldIds = Object.keys(oldCatalog.operations).sort();
  const newIds = Object.keys(newCatalog.operations).sort();
  const oldSet = new Set(oldIds);
  const newSet = new Set(newIds);

  const additions = newIds.filter((id) => !oldSet.has(id));
  const removals = oldIds.filter((id) => !newSet.has(id));
  const changes: OperationDiff[] = [];

  for (const operationId of newIds) {
    if (!oldSet.has(operationId)) continue;
    const before = oldCatalog.operations[operationId] as CatalogOperation;
    const after = newCatalog.operations[operationId] as CatalogOperation;
    const operationDiff = compareOperation(operationId, before, after);
    if (operationDiff !== undefined) changes.push(operationDiff);
  }

  return { additions, removals, changes };
}

function compareOperation(
  operationId: string,
  before: CatalogOperation,
  after: CatalogOperation,
): OperationDiff | undefined {
  const kinds: DiffKind[] = [];
  const details: string[] = [];

  compareGroup(
    'signature',
    { method: before.method, path: before.path },
    { method: after.method, path: after.path },
    'schemaChanged',
    kinds,
    details,
  );
  compareGroup(
    'request',
    before.request,
    after.request,
    'schemaChanged',
    kinds,
    details,
  );
  compareGroup(
    'responses',
    before.responses,
    after.responses,
    'schemaChanged',
    kinds,
    details,
  );
  compareGroup(
    'risk',
    { risk: before.risk, confirmation: before.confirmation },
    { risk: after.risk, confirmation: after.confirmation },
    'riskChanged',
    kinds,
    details,
  );
  compareGroup(
    'security',
    before.security,
    after.security,
    'securityChanged',
    kinds,
    details,
  );
  compareGroup(
    'limits',
    {
      timeoutMs: before.timeoutMs,
      maxRequestBytes: before.maxRequestBytes,
      maxResponseBytes: before.maxResponseBytes,
      maxConcurrency: before.maxConcurrency,
    },
    {
      timeoutMs: after.timeoutMs,
      maxRequestBytes: after.maxRequestBytes,
      maxResponseBytes: after.maxResponseBytes,
      maxConcurrency: after.maxConcurrency,
    },
    'limitsChanged',
    kinds,
    details,
  );
  compareGroup(
    'metadata',
    {
      enabled: before.enabled,
      available: before.available,
      summary: before.summary,
      description: before.description,
      tags: before.tags,
      deprecated: before.deprecated,
      cache: before.cache,
      headers: before.headers,
      redactions: before.redactions,
      examples: before.examples,
    },
    {
      enabled: after.enabled,
      available: after.available,
      summary: after.summary,
      description: after.description,
      tags: after.tags,
      deprecated: after.deprecated,
      cache: after.cache,
      headers: after.headers,
      redactions: after.redactions,
      examples: after.examples,
    },
    'metadataChanged',
    kinds,
    details,
  );

  if (kinds.length === 0) return undefined;
  return { operationId, kinds: [...new Set(kinds)], details };
}

function compareGroup(
  label: string,
  before: unknown,
  after: unknown,
  kind: DiffKind,
  kinds: DiffKind[],
  details: string[],
): void {
  if (canonicalize(before) !== canonicalize(after)) {
    kinds.push(kind);
    details.push(`${label}: changed`);
  }
}

export function formatDiff(
  diff: CatalogDiff,
  oldLabel: string,
  newLabel: string,
): string {
  const lines: string[] = [`catalog diff ${oldLabel} -> ${newLabel}`];
  for (const id of diff.additions) lines.push(`+ added: ${id}`);
  for (const id of diff.removals) lines.push(`- removed: ${id}`);
  for (const change of diff.changes) {
    lines.push(
      `~ changed: ${change.operationId} (${[...new Set(change.kinds)].join(', ')})`,
    );
    for (const detail of change.details) lines.push(`    ${detail}`);
  }
  if (
    diff.additions.length === 0 &&
    diff.removals.length === 0 &&
    diff.changes.length === 0
  ) {
    lines.push('No differences.');
  }
  return lines.join('\n');
}
