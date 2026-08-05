import { describe, expect, it } from 'vitest';

import { CircuitBreakerStore } from '../../src/runtime/circuit';

describe('CircuitBreakerStore', () => {
  it('opens after consecutive failures and half-opens after the timeout', () => {
    const store = new CircuitBreakerStore({
      failureThreshold: 3,
      resetTimeoutMs: 1000,
      clock: () => 0,
    });
    const scope = 'acme:billing';
    expect(store.state(scope)).toBe('closed');
    store.onFailure(scope);
    store.onFailure(scope);
    expect(store.state(scope)).toBe('closed');
    store.onFailure(scope);
    expect(store.state(scope)).toBe('open');
    expect(store.state(scope, 999)).toBe('open');
    expect(store.state(scope, 1000)).toBe('half-open');
  });

  it('closes on success after a failure streak', () => {
    const store = new CircuitBreakerStore({ failureThreshold: 2 });
    store.onFailure('acme:billing');
    store.onSuccess('acme:billing');
    store.onFailure('acme:billing');
    expect(store.state('acme:billing')).toBe('closed');
  });

  it('isolates failure state across tenants', () => {
    const store = new CircuitBreakerStore({ failureThreshold: 1 });
    store.onFailure('acme:billing');
    expect(store.state('acme:billing')).toBe('open');
    expect(store.state('globex:billing')).toBe('closed');
  });
});
