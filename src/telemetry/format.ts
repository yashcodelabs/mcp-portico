/**
 * Human-readable rendering of a usage summary for the operator CLI.
 */

import { PRODUCT_NAME } from '../shared/brand';
import type { UsageRow, UsageSummary } from './summary';

function rowLine(row: UsageRow): string {
  const tenant = row.tenantId === null ? '(unattributed)' : row.tenantId;
  return `${tenant} | ${row.id}: ${row.events} (success ${row.success}, failure ${row.failure})`;
}

/** Render a usage summary as stable console text. */
export function formatUsageSummary(summary: UsageSummary): string {
  const lines: string[] = [`${PRODUCT_NAME} usage summary`];
  lines.push(
    `Scope: ${
      'tenantId' in summary.scope
        ? `tenant "${summary.scope.tenantId}"`
        : 'all tenants (operator view; every row stays tenant-attributed)'
    }`,
  );
  lines.push(
    `Events: ${summary.totals.events} (success ${summary.totals.success}, failure ${summary.totals.failure})`,
  );
  if (summary.totals.firstEventAt !== undefined) {
    lines.push(`First event: ${summary.totals.firstEventAt}`);
  }
  if (summary.totals.lastEventAt !== undefined) {
    lines.push(`Last event: ${summary.totals.lastEventAt}`);
  }
  lines.push(
    `Persistence: ${summary.persistence.backend} only - ${summary.persistence.limitation}`,
  );

  const actions = Object.entries(summary.totals.byAction);
  if (actions.length > 0) {
    lines.push('By action:');
    for (const [action, counts] of actions) {
      if (counts === undefined) continue;
      lines.push(
        `  ${action}: ${counts.events} (success ${counts.success}, failure ${counts.failure})`,
      );
    }
  }

  if (summary.byTenant.length > 0) {
    lines.push('By tenant:');
    for (const row of summary.byTenant) lines.push(`  ${rowLine(row)}`);
  }
  if (summary.byConnection.length > 0) {
    lines.push('By connection:');
    for (const row of summary.byConnection) lines.push(`  ${rowLine(row)}`);
  }
  if (summary.byOperation.length > 0) {
    lines.push('By operation:');
    for (const row of summary.byOperation) lines.push(`  ${rowLine(row)}`);
  }
  return lines.join('\n');
}
