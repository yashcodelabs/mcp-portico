import { describe, expect, it } from 'vitest';

import { LimitsStore, scopeKey } from '../../src/limits/store';

describe('LimitsStore', () => {
  it('rate limits per key over a one-minute window', () => {
    const store = new LimitsStore();
    const key = scopeKey('acme', 'billing');
    const first = store.rateLimit(key, 2, 0);
    expect(first).toMatchObject({ allowed: true, remaining: 1 });
    const second = store.rateLimit(key, 2, 1_000);
    expect(second).toMatchObject({ allowed: true, remaining: 0 });
    const third = store.rateLimit(key, 2, 2_000);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
    // Window resets after 60s.
    const afterReset = store.rateLimit(key, 2, 61_000);
    expect(afterReset.allowed).toBe(true);
  });

  it('isolates rate windows by tenant and connection', () => {
    const store = new LimitsStore();
    const acmeKey = scopeKey('acme', 'billing');
    const globexKey = scopeKey('globex', 'billing');
    store.rateLimit(acmeKey, 1, 0);
    expect(store.rateLimit(acmeKey, 1, 1).allowed).toBe(false);
    expect(store.rateLimit(globexKey, 1, 1).allowed).toBe(true);
  });

  it('enforces concurrency limits per key with release', () => {
    const store = new LimitsStore();
    const key = scopeKey('acme', 'billing');
    expect(store.acquireConcurrency(key, 2)).toBe(true);
    expect(store.acquireConcurrency(key, 2)).toBe(true);
    expect(store.acquireConcurrency(key, 2)).toBe(false);
    store.releaseConcurrency(key);
    expect(store.acquireConcurrency(key, 2)).toBe(true);
    store.releaseConcurrency(key);
    store.releaseConcurrency(key);
    expect(store.concurrencyFor(key)).toBe(0);
  });

  it('does not share concurrency slots across tenants', () => {
    const store = new LimitsStore();
    store.acquireConcurrency(scopeKey('acme', 'billing'), 1);
    expect(store.acquireConcurrency(scopeKey('globex', 'billing'), 1)).toBe(true);
  });

  it('builds deterministic scope keys', () => {
    expect(scopeKey('acme', 'billing', 'automation-1')).toBe(
      'acme:billing:automation-1',
    );
  });
});
