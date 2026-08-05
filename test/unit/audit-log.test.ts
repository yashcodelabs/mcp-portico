import { describe, expect, it } from 'vitest';

import { MemoryAuditLog, newAuditEvent, type AuditEvent } from '../../src/audit/log';

function event(tenantId: string, action: AuditEvent['action']): AuditEvent {
  return newAuditEvent({
    tenantId,
    principalId: `${tenantId}-automation`,
    registryRevision: 1,
    action,
    outcome: 'success',
    durationMs: 12,
  });
}

describe('MemoryAuditLog', () => {
  it('records events with ids and timestamps', () => {
    const log = new MemoryAuditLog();
    const recorded = event('acme', 'authenticate');
    log.record(recorded);
    expect(recorded.id).toBeTruthy();
    expect(recorded.timestamp).toBeTruthy();
    expect(log.count()).toBe(1);
  });

  it('filters by tenant before any aggregation', () => {
    const log = new MemoryAuditLog();
    log.record(event('acme', 'call_operation'));
    log.record(event('acme', 'call_operation'));
    log.record(event('globex', 'call_operation'));
    const acme = log.forTenant('acme');
    expect(acme).toHaveLength(2);
    expect(acme.every((item) => item.tenantId === 'acme')).toBe(true);
    expect(log.forTenant('globex')).toHaveLength(1);
    expect(log.forTenant('nova')).toHaveLength(0);
  });

  it('never stores credential-shaped fields', () => {
    const recorded = event('acme', 'call_operation');
    const serialized = JSON.stringify(recorded);
    expect(serialized).not.toMatch(/token|secret|password|apiKey/i);
  });
});
