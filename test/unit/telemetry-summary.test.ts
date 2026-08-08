import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AuditEvent } from '../../src/audit/log';
import { PorticoError } from '../../src/shared/errors';
import { formatUsageSummary } from '../../src/telemetry/format';
import { loadAuditEvents } from '../../src/telemetry/load';
import { summarizeAudit } from '../../src/telemetry/summary';

function event(partial: Partial<AuditEvent>): AuditEvent {
  return {
    id: partial.id ?? 'event-id',
    timestamp: partial.timestamp ?? '2026-08-09T00:00:00.000Z',
    registryRevision: partial.registryRevision ?? 1,
    action: partial.action ?? 'authenticate',
    outcome: partial.outcome ?? 'success',
    ...partial,
  };
}

describe('usage summary', () => {
  it('groups events by tenant without mixing tenants or unattributed events', () => {
    const events = [
      event({ tenantId: 'acme', principalId: 'a1', connectionId: 'acme-billing' }),
      event({
        tenantId: 'acme',
        principalId: 'a1',
        connectionId: 'acme-billing',
        outcome: 'failure',
      }),
      event({ tenantId: 'globex', principalId: 'g1', connectionId: 'globex-billing' }),
      event({}),
    ];
    const summary = summarizeAudit(events);
    expect(summary.scope).toEqual({ allTenants: true });
    expect(summary.totals).toMatchObject({ events: 4, success: 3, failure: 1 });
    expect(summary.byTenant).toEqual([
      {
        tenantId: 'acme',
        id: 'acme',
        events: 2,
        success: 1,
        failure: 1,
        lastEventAt: '2026-08-09T00:00:00.000Z',
      },
      {
        tenantId: 'globex',
        id: 'globex',
        events: 1,
        success: 1,
        failure: 0,
        lastEventAt: '2026-08-09T00:00:00.000Z',
      },
      {
        tenantId: null,
        id: '(unattributed)',
        events: 1,
        success: 1,
        failure: 0,
        lastEventAt: '2026-08-09T00:00:00.000Z',
      },
    ]);
  });

  it('scopes totals to one tenant before aggregating', () => {
    const events = [
      event({
        tenantId: 'acme',
        connectionId: 'acme-billing',
        operation: 'invoice.get',
      }),
      event({
        tenantId: 'acme',
        connectionId: 'acme-billing',
        operation: 'invoice.get',
      }),
      event({
        tenantId: 'globex',
        connectionId: 'globex-billing',
        operation: 'task.list',
      }),
    ];
    const summary = summarizeAudit(events, { tenantId: 'acme' });
    expect(summary.scope).toEqual({ tenantId: 'acme' });
    expect(summary.totals).toMatchObject({ events: 2, success: 2, failure: 0 });
    expect(summary.byTenant).toEqual([]);
    expect(summary.byConnection).toHaveLength(1);
    expect(summary.byConnection[0]).toMatchObject({
      tenantId: 'acme',
      id: 'acme-billing',
      events: 2,
    });
    expect(summary.byOperation[0]).toMatchObject({
      tenantId: 'acme',
      id: 'invoice.get',
      events: 2,
    });
  });

  it('keeps identical connection ids from different tenants separate', () => {
    const events = [
      event({ tenantId: 'acme', connectionId: 'prod', operation: 'a.get' }),
      event({ tenantId: 'globex', connectionId: 'prod', operation: 'b.get' }),
    ];
    const summary = summarizeAudit(events);
    expect(summary.byConnection).toHaveLength(2);
    expect(summary.byConnection[0]).toMatchObject({
      tenantId: 'acme',
      id: 'prod',
      events: 1,
    });
    expect(summary.byConnection[1]).toMatchObject({
      tenantId: 'globex',
      id: 'prod',
      events: 1,
    });
    expect(summary.byOperation).toHaveLength(2);
  });

  it('breaks down totals by action with outcomes', () => {
    const summary = summarizeAudit([
      event({ action: 'call_operation', tenantId: 'acme', outcome: 'success' }),
      event({ action: 'call_operation', tenantId: 'acme', outcome: 'failure' }),
      event({ action: 'select_connection', tenantId: 'acme', outcome: 'success' }),
    ]);
    expect(summary.totals.byAction).toMatchObject({
      call_operation: { events: 2, success: 1, failure: 1 },
      select_connection: { events: 1, success: 1, failure: 0 },
    });
  });

  it('reports first/last event and the persistence limitation', () => {
    const summary = summarizeAudit(
      [
        event({ tenantId: 'acme', timestamp: '2026-08-09T01:00:00.000Z' }),
        event({ tenantId: 'acme', timestamp: '2026-08-09T03:00:00.000Z' }),
        event({ tenantId: 'acme', timestamp: '2026-08-09T02:00:00.000Z' }),
      ],
      { generatedAt: '2026-08-09T04:00:00.000Z' },
    );
    expect(summary.generatedAt).toBe('2026-08-09T04:00:00.000Z');
    expect(summary.totals.firstEventAt).toBe('2026-08-09T01:00:00.000Z');
    expect(summary.totals.lastEventAt).toBe('2026-08-09T03:00:00.000Z');
    expect(summary.persistence).toEqual({
      persisted: false,
      backend: 'in-memory',
      limitation: expect.stringContaining('in-memory'),
    });
  });

  it('formats a readable summary that states the persistence limitation', () => {
    const text = formatUsageSummary(
      summarizeAudit([event({ tenantId: 'acme', connectionId: 'acme-billing' })], {
        tenantId: 'acme',
      }),
    );
    expect(text).toContain('MCP Portico usage summary');
    expect(text).toContain('tenant "acme"');
    expect(text).toContain('Events: 1 (success 1, failure 0)');
    expect(text).toContain('Persistence: in-memory only');
    expect(text).toContain('acme-billing');
  });
});

describe('telemetry file loading', () => {
  it('loads a JSON array and a JSONL file', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portico-telemetry-'));
    try {
      const acme = event({ tenantId: 'acme', action: 'call_operation' });
      const globex = event({ tenantId: 'globex', action: 'select_connection' });
      const jsonFile = path.join(directory, 'audit.json');
      const jsonlFile = path.join(directory, 'audit.jsonl');
      const emptyFile = path.join(directory, 'empty.jsonl');
      fs.writeFileSync(jsonFile, `${JSON.stringify([acme, globex], null, 2)}\n`);
      fs.writeFileSync(
        jsonlFile,
        `${JSON.stringify(acme)}\n${JSON.stringify(globex)}\n`,
      );
      fs.writeFileSync(emptyFile, '');
      expect(loadAuditEvents(jsonFile)).toEqual([acme, globex]);
      expect(loadAuditEvents(jsonlFile)).toEqual([acme, globex]);
      expect(loadAuditEvents(emptyFile)).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects malformed events with CONFIG_ERROR', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portico-telemetry-'));
    try {
      const badLine = path.join(directory, 'bad.jsonl');
      fs.writeFileSync(badLine, '{not json\n');
      expect(() => loadAuditEvents(badLine)).toThrow(PorticoError);

      const missingField = path.join(directory, 'missing.json');
      fs.writeFileSync(
        missingField,
        JSON.stringify([
          {
            id: 'x',
            registryRevision: 1,
            action: 'authenticate',
            outcome: 'success',
          },
        ]),
      );
      let message = '';
      try {
        loadAuditEvents(missingField);
      } catch (error) {
        message = error instanceof PorticoError ? error.message : '';
      }
      expect(message).toContain('timestamp');

      const unknownAction = path.join(directory, 'action.json');
      fs.writeFileSync(
        unknownAction,
        JSON.stringify([
          {
            id: 'x',
            timestamp: '2026-08-09T00:00:00.000Z',
            registryRevision: 1,
            action: 'bogus',
            outcome: 'success',
          },
        ]),
      );
      expect(() => loadAuditEvents(unknownAction)).toThrow(PorticoError);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
