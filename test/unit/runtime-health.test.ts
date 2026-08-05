import { describe, expect, it } from 'vitest';

import { HealthStore } from '../../src/runtime/health';

describe('HealthStore', () => {
  it('records healthy and unhealthy observations with failure counts', () => {
    const store = new HealthStore(() => 1000);
    store.record('acme', 'billing', { ok: true, statusCode: 200, durationMs: 12 });
    let record = store.get('acme', 'billing');
    expect(record).toMatchObject({ status: 'healthy', consecutiveFailures: 0 });
    store.record('acme', 'billing', { ok: false, statusCode: 500, durationMs: 20 });
    store.record('acme', 'billing', { ok: false, errorCode: 'REQUEST_FAILED' });
    record = store.get('acme', 'billing');
    expect(record).toMatchObject({ status: 'unhealthy', consecutiveFailures: 2 });
    store.record('acme', 'billing', { ok: true });
    expect(store.get('acme', 'billing')?.consecutiveFailures).toBe(0);
  });

  it('isolates health state across tenants and connections', () => {
    const store = new HealthStore();
    store.record('acme', 'billing', { ok: false });
    expect(store.get('acme', 'billing')?.status).toBe('unhealthy');
    expect(store.get('globex', 'billing')).toBeUndefined();
    expect(store.get('acme', 'ledger')).toBeUndefined();
  });

  it('drops records for connections that no longer exist', () => {
    const store = new HealthStore();
    store.record('acme', 'billing', { ok: false });
    store.record('acme', 'ledger', { ok: false });
    store.retain(new Set(['acme:billing']));
    expect(store.get('acme', 'billing')).toBeDefined();
    expect(store.get('acme', 'ledger')).toBeUndefined();
  });
});
