import { randomBytes } from 'node:crypto';

import type { PorticoPrincipal } from '../auth/types';
import type { RegistrySnapshot } from '../registry/snapshot';
import type { PrincipalRecord } from '../registry/types';
import { PorticoError } from '../shared/errors';

/**
 * Tenant/principal-namespaced sessions.
 *
 * Sessions store only opaque IDs plus the bound tenant, principal, selected
 * connection, registry revision, and catalog checksum. Every use is
 * re-authenticated and re-authorized against the current snapshot, so a
 * session ID can never cross a principal boundary or outlive a revocation.
 */

export interface SessionState {
  id: string;
  tenantId: string;
  principalId: string;
  connectionId: string;
  registryRevision: number;
  catalogChecksum: string;
  createdAt: number;
}

export interface CreateSessionInput {
  principal: PorticoPrincipal;
  connectionId: string;
  snapshot: RegistrySnapshot;
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionState>();

  create(input: CreateSessionInput): SessionState {
    const principalRecord = input.principal as PrincipalRecord;
    const connection = input.snapshot.authorizeConnection(
      principalRecord,
      input.connectionId,
    );
    if (connection === undefined) {
      throw new PorticoError(
        'AUTH',
        `Principal "${input.principal.id}" is not authorized for connection "${input.connectionId}".`,
      );
    }
    const catalog = input.snapshot.catalogForConnection(connection.id);
    const state: SessionState = {
      id: randomBytes(16).toString('hex'),
      tenantId: input.principal.tenantId,
      principalId: input.principal.id,
      connectionId: connection.id,
      registryRevision: input.snapshot.revision,
      catalogChecksum: catalog?.checksum ?? '',
      createdAt: Date.now(),
    };
    this.sessions.set(state.id, state);
    return state;
  }

  get(id: string): SessionState | undefined {
    return this.sessions.get(id);
  }

  /**
   * Re-validate a session against the authenticated principal and current
   * snapshot. Throws AUTH on any mismatch, staleness, or revocation.
   */
  assertUsable(
    state: SessionState,
    principal: PorticoPrincipal,
    snapshot: RegistrySnapshot,
  ): SessionState {
    if (state.principalId !== principal.id || state.tenantId !== principal.tenantId) {
      throw new PorticoError(
        'AUTH',
        'Session belongs to a different principal and cannot be used.',
      );
    }
    if (state.registryRevision !== snapshot.revision) {
      throw new PorticoError(
        'AUTH',
        'Session is stale (registry changed); select a connection again.',
      );
    }
    const record = snapshot.principal(principal.id);
    if (record === undefined) {
      throw new PorticoError('AUTH', 'Principal no longer exists in the registry.');
    }
    const connection = snapshot.authorizeConnection(record, state.connectionId);
    if (connection === undefined) {
      throw new PorticoError(
        'AUTH',
        'Session connection is no longer authorized; select a connection again.',
      );
    }
    const catalog = snapshot.catalogForConnection(state.connectionId);
    if (catalog === undefined || catalog.checksum !== state.catalogChecksum) {
      throw new PorticoError(
        'AUTH',
        'Session catalog changed; select a connection again.',
      );
    }
    return state;
  }

  revokeForPrincipal(principalId: string): void {
    for (const [id, state] of this.sessions) {
      if (state.principalId === principalId) this.sessions.delete(id);
    }
  }

  revokeForConnection(connectionId: string): void {
    for (const [id, state] of this.sessions) {
      if (state.connectionId === connectionId) this.sessions.delete(id);
    }
  }

  /** Drop sessions that are stale or reference no-longer-authorized state. */
  invalidateForSnapshot(snapshot: RegistrySnapshot): void {
    for (const [id, state] of this.sessions) {
      if (state.registryRevision !== snapshot.revision) {
        this.sessions.delete(id);
        continue;
      }
      const principal = snapshot.principal(state.principalId);
      if (
        principal === undefined ||
        snapshot.authorizeConnection(principal, state.connectionId) === undefined
      ) {
        this.sessions.delete(id);
        continue;
      }
      const catalog = snapshot.catalogForConnection(state.connectionId);
      if (catalog === undefined || catalog.checksum !== state.catalogChecksum) {
        this.sessions.delete(id);
      }
    }
  }

  count(): number {
    return this.sessions.size;
  }

  clear(): void {
    this.sessions.clear();
  }
}
