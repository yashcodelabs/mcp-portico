/**
 * Minimal usage telemetry: tenant-safe summaries over audit events.
 *
 * v1 telemetry has no database and no automatic persistence. Audit events
 * live in the in-memory audit log for the lifetime of one server process
 * and are lost on restart. Summaries are tenant-safe by construction: a
 * tenant-scoped summary only ever sees that tenant's events, and an
 * operator (unscoped) summary groups every row by tenant instead of
 * blending tenants together. Events without a tenant attribution are never
 * folded into a tenant's totals.
 */

import type { AuditAction, AuditEvent } from '../audit/log';

export interface UsageTotals {
  events: number;
  success: number;
  failure: number;
  firstEventAt?: string;
  lastEventAt?: string;
  byAction: Partial<
    Record<AuditAction, { events: number; success: number; failure: number }>
  >;
}

/**
 * One grouped row. `id` is the group key (tenant, connection, or operation
 * id); `tenantId` is preserved on every row so identical connection or
 * operation ids from different tenants can never be merged.
 */
export interface UsageRow {
  tenantId: string | null;
  id: string;
  events: number;
  success: number;
  failure: number;
  lastEventAt?: string;
}

export interface UsagePersistence {
  /** v1 never persists audit events; there is no durable backend yet. */
  persisted: false;
  backend: 'in-memory';
  limitation: string;
}

export interface UsageSummaryOptions {
  /** Restrict the summary to one tenant; otherwise group by tenant. */
  tenantId?: string;
  generatedAt?: string;
}

export interface UsageSummary {
  generatedAt: string;
  persistence: UsagePersistence;
  scope: { tenantId: string } | { allTenants: true };
  totals: UsageTotals;
  /** Present only in the operator (unscoped) view. */
  byTenant: UsageRow[];
  byConnection: UsageRow[];
  byOperation: UsageRow[];
}

export const USAGE_PERSISTENCE_LIMITATION =
  'v1 audit telemetry is in-memory only: nothing is written to disk and all ' +
  'usage data is lost when the server process stops. This summary reflects ' +
  'only the events supplied to it.';

interface GroupCount {
  events: number;
  success: number;
  failure: number;
  lastEventAt?: string;
}

function emptyGroup(): GroupCount {
  return { events: 0, success: 0, failure: 0 };
}

function addEvent(group: GroupCount, event: AuditEvent): void {
  group.events += 1;
  if (event.outcome === 'success') group.success += 1;
  else group.failure += 1;
  if (group.lastEventAt === undefined || event.timestamp > group.lastEventAt) {
    group.lastEventAt = event.timestamp;
  }
}

function rowFor(group: GroupCount, tenantId: string | null, id: string): UsageRow {
  return { tenantId, id, ...group };
}

/**
 * Summarize audit events, filtering to `options.tenantId` first when given.
 * Unscoped summaries are operator-only output and still keep every row
 * tenant-attributed; they never merge tenants.
 */
export function summarizeAudit(
  events: AuditEvent[],
  options: UsageSummaryOptions = {},
): UsageSummary {
  const scoped =
    options.tenantId === undefined
      ? events
      : events.filter((event) => event.tenantId === options.tenantId);

  const totals: UsageTotals = {
    events: scoped.length,
    success: 0,
    failure: 0,
    byAction: {},
  };
  const byAction = new Map<AuditAction, GroupCount>();
  const byTenant = new Map<string, GroupCount>();
  const byConnection = new Map<string, GroupCount>();
  const byOperation = new Map<string, GroupCount>();
  let firstEventAtValue: string | undefined;
  let lastEventAtValue: string | undefined;

  for (const event of scoped) {
    if (event.outcome === 'success') totals.success += 1;
    else totals.failure += 1;
    if (firstEventAtValue === undefined || event.timestamp < firstEventAtValue) {
      firstEventAtValue = event.timestamp;
    }
    if (lastEventAtValue === undefined || event.timestamp > lastEventAtValue) {
      lastEventAtValue = event.timestamp;
    }

    const actionGroup = byAction.get(event.action) ?? emptyGroup();
    addEvent(actionGroup, event);
    byAction.set(event.action, actionGroup);

    const tenantKey = event.tenantId ?? '';
    const tenantGroup = byTenant.get(tenantKey) ?? emptyGroup();
    addEvent(tenantGroup, event);
    byTenant.set(tenantKey, tenantGroup);

    if (event.connectionId !== undefined) {
      const connectionKey = `${event.tenantId ?? ''}\u0000${event.connectionId}`;
      const connectionGroup = byConnection.get(connectionKey) ?? emptyGroup();
      addEvent(connectionGroup, event);
      byConnection.set(connectionKey, connectionGroup);
    }

    if (event.operation !== undefined) {
      const operationKey = `${event.tenantId ?? ''}\u0000${event.operation}`;
      const operationGroup = byOperation.get(operationKey) ?? emptyGroup();
      addEvent(operationGroup, event);
      byOperation.set(operationKey, operationGroup);
    }
  }

  totals.byAction = Object.fromEntries(
    [...byAction.entries()].sort(([left], [right]) => left.localeCompare(right)),
  ) as UsageTotals['byAction'];
  if (firstEventAtValue !== undefined) totals.firstEventAt = firstEventAtValue;
  if (lastEventAtValue !== undefined) totals.lastEventAt = lastEventAtValue;

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    persistence: {
      persisted: false,
      backend: 'in-memory',
      limitation: USAGE_PERSISTENCE_LIMITATION,
    },
    scope:
      options.tenantId === undefined
        ? { allTenants: true }
        : { tenantId: options.tenantId },
    totals,
    byTenant:
      options.tenantId === undefined
        ? [...byTenant.entries()]
            .map(([key, group]) =>
              key === ''
                ? rowFor(group, null, '(unattributed)')
                : rowFor(group, key, key),
            )
            .sort(compareRows)
        : [],
    byConnection: [...byConnection.entries()]
      .map(([key, group]) => {
        const [tenantId, id] = splitKey(key);
        return rowFor(group, tenantId, id);
      })
      .sort(compareRows),
    byOperation: [...byOperation.entries()]
      .map(([key, group]) => {
        const [tenantId, id] = splitKey(key);
        return rowFor(group, tenantId, id);
      })
      .sort(compareRows),
  };
}

function splitKey(key: string): [string | null, string] {
  const separator = key.indexOf('\u0000');
  if (separator < 0) return [null, key];
  const tenantId = key.slice(0, separator);
  return [tenantId === '' ? null : tenantId, key.slice(separator + 1)];
}

function compareRows(left: UsageRow, right: UsageRow): number {
  if (left.tenantId === null && right.tenantId !== null) return 1;
  if (left.tenantId !== null && right.tenantId === null) return -1;
  const tenantOrder = (left.tenantId ?? '').localeCompare(right.tenantId ?? '');
  if (tenantOrder !== 0) return tenantOrder;
  return left.id.localeCompare(right.id);
}
