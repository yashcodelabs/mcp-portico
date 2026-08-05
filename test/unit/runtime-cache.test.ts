import { describe, expect, it } from 'vitest';

import { CacheStore } from '../../src/runtime/cache';

describe('CacheStore', () => {
  it('builds keys that include every isolation dimension', () => {
    const store = new CacheStore();
    const base = {
      tenantId: 'acme',
      connectionId: 'billing-prod',
      catalogChecksum: 'sha256:abc',
      operationId: 'invoice.get',
      input: { id: 1 },
    };
    const same = store.key(base);
    expect(store.key({ ...base, principalId: 'automation-1' })).not.toBe(same);
    expect(store.key({ ...base, tenantId: 'globex' })).not.toBe(same);
    expect(store.key({ ...base, connectionId: 'billing-staging' })).not.toBe(same);
    expect(store.key({ ...base, catalogChecksum: 'sha256:def' })).not.toBe(same);
    expect(store.key({ ...base, operationId: 'invoices.post' })).not.toBe(same);
    expect(store.key({ ...base, input: { id: 2 } })).not.toBe(same);
    expect(store.key(base)).toBe(same);
  });

  it('isolates colliding operation ids across tenants', () => {
    const store = new CacheStore();
    const acmeKey = store.key({
      tenantId: 'acme',
      connectionId: 'billing',
      catalogChecksum: 'sha256:abc',
      operationId: 'invoice.get',
      input: { id: 1 },
      principalId: 'automation-1',
    });
    const globexKey = store.key({
      tenantId: 'globex',
      connectionId: 'billing',
      catalogChecksum: 'sha256:abc',
      operationId: 'invoice.get',
      input: { id: 1 },
      principalId: 'automation-1',
    });
    store.set(acmeKey, 'acme-data');
    expect(store.get(globexKey)).toBeUndefined();
    expect(store.get(acmeKey)).toBe('acme-data');
  });

  it('evicts least-recently-used entries beyond the capacity', () => {
    let tick = 0;
    const store = new CacheStore(2, () => (tick += 1));
    store.set('a', 1);
    store.set('b', 2);
    store.get('a');
    store.set('c', 3);
    expect(store.has('a')).toBe(true);
    expect(store.has('b')).toBe(false);
    expect(store.has('c')).toBe(true);
  });

  it('clears all entries', () => {
    const store = new CacheStore();
    store.set('a', 1);
    store.clear();
    expect(store.size()).toBe(0);
  });
});
