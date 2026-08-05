import { describe, expect, it } from 'vitest';

import { SessionStore } from '../../src/session/store';
import type { PorticoPrincipal } from '../../src/auth/types';
import { PorticoError } from '../../src/shared/errors';
import { sampleSnapshot } from '../helpers/registry';

function principal(
  id: string,
  tenantId: string,
  allowedConnectionIds: string[],
): PorticoPrincipal {
  return { id, tenantId, allowedConnectionIds };
}

describe('SessionStore', () => {
  it('creates sessions bound to a tenant, principal, and connection', () => {
    const store = new SessionStore();
    const snapshot = sampleSnapshot();
    const state = store.create({
      principal: principal('acme-automation', 'acme', ['acme-billing-prod']),
      connectionId: 'acme-billing-prod',
      snapshot,
    });
    expect(state.principalId).toBe('acme-automation');
    expect(state.tenantId).toBe('acme');
    expect(state.registryRevision).toBe(1);
    expect(store.get(state.id)).toEqual(state);
    expect(
      store.assertUsable(state, principal('acme-automation', 'acme', []), snapshot),
    ).toBe(state);
  });

  it('refuses to create sessions for unauthorized connections', () => {
    const store = new SessionStore();
    expect(() =>
      store.create({
        principal: principal('acme-automation', 'acme', []),
        connectionId: 'acme-billing-prod',
        snapshot: sampleSnapshot(),
      }),
    ).toThrow(PorticoError);
  });

  it('a session id cannot cross a principal boundary', () => {
    const store = new SessionStore();
    const snapshot = sampleSnapshot();
    const state = store.create({
      principal: principal('acme-automation', 'acme', ['acme-billing-prod']),
      connectionId: 'acme-billing-prod',
      snapshot,
    });
    expect(() =>
      store.assertUsable(
        state,
        principal('globex-automation', 'globex', ['globex-billing-prod']),
        snapshot,
      ),
    ).toThrow(PorticoError);
  });

  it('rejects stale sessions after a registry revision bump', () => {
    const store = new SessionStore();
    const oldSnapshot = sampleSnapshot(1);
    const state = store.create({
      principal: principal('acme-automation', 'acme', ['acme-billing-prod']),
      connectionId: 'acme-billing-prod',
      snapshot: oldSnapshot,
    });
    expect(() =>
      store.assertUsable(
        state,
        principal('acme-automation', 'acme', []),
        sampleSnapshot(2),
      ),
    ).toThrow(PorticoError);
  });

  it('rejects sessions whose connection was revoked', () => {
    const store = new SessionStore();
    const snapshot = sampleSnapshot();
    const state = store.create({
      principal: principal('acme-automation', 'acme', ['acme-billing-prod']),
      connectionId: 'acme-billing-prod',
      snapshot,
    });
    store.revokeForConnection('acme-billing-prod');
    expect(store.get(state.id)).toBeUndefined();
  });

  it('invalidates stale sessions against a new snapshot', () => {
    const store = new SessionStore();
    const snapshot = sampleSnapshot();
    store.create({
      principal: principal('acme-automation', 'acme', ['acme-billing-prod']),
      connectionId: 'acme-billing-prod',
      snapshot,
    });
    expect(store.count()).toBe(1);
    store.invalidateForSnapshot(sampleSnapshot(2));
    expect(store.count()).toBe(0);
  });
});
