import path from 'node:path';

import { loadCatalog } from '../catalog/load';
import type { Catalog } from '../catalog/types';
import { PorticoError } from '../shared/errors';
import { loadRegistryFile, resolveCatalogPath } from './load';
import type {
  Backend,
  Connection,
  PrincipalRecord,
  RegistryDocument,
  Tenant,
} from './types';
import { validateRegistryDocument, type RegistryValidationIssue } from './validate';

/**
 * Validated, immutable registry snapshot.
 *
 * A snapshot binds the complete registry document to its checksum-pinned
 * catalogs. Catalogs are loaded read-only and deduplicated by checksum, so a
 * global catalog may be shared in memory safely: it contains no tenant URLs,
 * credentials, secrets, or mutable tenant state.
 */

export interface RegistrySnapshot {
  readonly revision: number;
  readonly document: RegistryDocument;
  readonly catalogsByChecksum: ReadonlyMap<string, Catalog>;
  readonly catalogsByRef: ReadonlyMap<string, Catalog>;
  withRevision(revision: number): RegistrySnapshot;
  tenant(id: string): Tenant | undefined;
  principal(id: string): PrincipalRecord | undefined;
  backend(id: string): Backend | undefined;
  connection(id: string): Connection | undefined;
  catalogForBackend(backendId: string): Catalog | undefined;
  catalogForConnection(connectionId: string): Catalog | undefined;
  connectionsForPrincipal(principal: PrincipalRecord): Connection[];
  authorizeConnection(
    principal: PrincipalRecord,
    connectionId: string,
  ): Connection | undefined;
}

class RegistrySnapshotImpl implements RegistrySnapshot {
  constructor(
    readonly revision: number,
    readonly document: RegistryDocument,
    readonly catalogsByChecksum: ReadonlyMap<string, Catalog>,
    readonly catalogsByRef: ReadonlyMap<string, Catalog>,
    private readonly tenants: Map<string, Tenant>,
    private readonly principals: Map<string, PrincipalRecord>,
    private readonly backends: Map<string, Backend>,
    private readonly connections: Map<string, Connection>,
  ) {}

  withRevision(revision: number): RegistrySnapshot {
    return new RegistrySnapshotImpl(
      revision,
      this.document,
      this.catalogsByChecksum,
      this.catalogsByRef,
      this.tenants,
      this.principals,
      this.backends,
      this.connections,
    );
  }

  tenant(id: string): Tenant | undefined {
    return this.tenants.get(id);
  }

  principal(id: string): PrincipalRecord | undefined {
    return this.principals.get(id);
  }

  backend(id: string): Backend | undefined {
    return this.backends.get(id);
  }

  connection(id: string): Connection | undefined {
    return this.connections.get(id);
  }

  catalogForBackend(backendId: string): Catalog | undefined {
    const backend = this.backends.get(backendId);
    if (backend === undefined) return undefined;
    return this.catalogsByChecksum.get(backend.catalogChecksum);
  }

  catalogForConnection(connectionId: string): Catalog | undefined {
    const connection = this.connections.get(connectionId);
    if (connection === undefined) return undefined;
    return this.catalogForBackend(connection.backendId);
  }

  connectionsForPrincipal(principal: PrincipalRecord): Connection[] {
    const allowed = new Set(principal.allowedConnectionIds);
    return [...this.connections.values()]
      .filter(
        (connection) =>
          connection.tenantId === principal.tenantId && allowed.has(connection.id),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  authorizeConnection(
    principal: PrincipalRecord,
    connectionId: string,
  ): Connection | undefined {
    const connection = this.connections.get(connectionId);
    if (connection === undefined) return undefined;
    if (connection.tenantId !== principal.tenantId) return undefined;
    if (!principal.allowedConnectionIds.includes(connectionId)) return undefined;
    const backend = this.backends.get(connection.backendId);
    if (backend === undefined) return undefined;
    if (backend.scope === 'tenant' && backend.ownerTenantId !== principal.tenantId) {
      return undefined;
    }
    return connection;
  }
}

/**
 * Build and fully validate a registry snapshot from a YAML/JSON file.
 * Throws CONFIG_ERROR listing every validation issue when invalid; a failed
 * build never produces a snapshot.
 */
export function buildRegistrySnapshot(registryFilePath: string): RegistrySnapshot {
  const loaded = loadRegistryFile(registryFilePath);
  const document = loaded.document;

  const catalogsByChecksum = new Map<string, Catalog>();
  const catalogsByRef = new Map<string, Catalog>();
  const loadCatalogForRef = (catalogRef: string): Catalog => {
    const absolutePath = resolveCatalogPath(registryFilePath, catalogRef);
    const cachedByRef = catalogsByRef.get(absolutePath);
    if (cachedByRef !== undefined) return cachedByRef;
    const catalog = Object.freeze(loadCatalog(absolutePath).catalog);
    const existing = catalogsByChecksum.get(catalog.checksum);
    if (existing !== undefined) {
      catalogsByRef.set(absolutePath, existing);
      return existing;
    }
    catalogsByChecksum.set(catalog.checksum, catalog);
    catalogsByRef.set(absolutePath, catalog);
    return catalog;
  };

  const issues = validateRegistryDocument(document, {
    loadCatalog: loadCatalogForRef,
  });
  if (issues.length > 0) {
    throw new PorticoError('CONFIG_ERROR', 'Registry validation failed.', {
      details: { issues },
    });
  }

  const tenants = new Map(document.tenants.map((tenant) => [tenant.id, tenant]));
  const principals = new Map(
    document.principals.map((principal) => [principal.id, principal]),
  );
  const backends = new Map(document.backends.map((backend) => [backend.id, backend]));
  const connections = new Map(
    document.connections.map((connection) => [connection.id, connection]),
  );

  return new RegistrySnapshotImpl(
    1,
    document,
    catalogsByChecksum,
    catalogsByRef,
    tenants,
    principals,
    backends,
    connections,
  );
}

/**
 * Build a snapshot from an in-memory document plus catalogs keyed by
 * catalogRef. Used by tests and future programmatic reload paths; the
 * document still undergoes full schema and semantic validation.
 */
export function snapshotFromDocument(
  document: RegistryDocument,
  catalogs: ReadonlyMap<string, Catalog>,
  revision = 1,
): RegistrySnapshot {
  const catalogsByChecksum = new Map<string, Catalog>();
  for (const catalog of catalogs.values()) {
    catalogsByChecksum.set(catalog.checksum, catalog);
  }
  const issues = validateRegistryDocument(document, {
    loadCatalog: (catalogRef) => {
      const catalog = catalogs.get(catalogRef);
      if (catalog === undefined) {
        throw new PorticoError(
          'CONFIG_ERROR',
          `No catalog provided for ref "${catalogRef}".`,
        );
      }
      return catalog;
    },
  });
  if (issues.length > 0) {
    throw new PorticoError('CONFIG_ERROR', 'Registry validation failed.', {
      details: { issues },
    });
  }
  const tenants = new Map(document.tenants.map((tenant) => [tenant.id, tenant]));
  const principals = new Map(
    document.principals.map((principal) => [principal.id, principal]),
  );
  const backends = new Map(document.backends.map((backend) => [backend.id, backend]));
  const connections = new Map(
    document.connections.map((connection) => [connection.id, connection]),
  );
  return new RegistrySnapshotImpl(
    revision,
    document,
    catalogsByChecksum,
    catalogs,
    tenants,
    principals,
    backends,
    connections,
  );
}

/**
 * Mutable runtime registry with atomic snapshot publication.
 *
 * A candidate snapshot is fully validated before it replaces the current
 * one; any failure preserves the previous snapshot. Publication bumps the
 * revision, which invalidates stale session selections and caches.
 */
export class RuntimeRegistry {
  private current: RegistrySnapshot | undefined;
  private readonly subscribers = new Set<(next: RegistrySnapshot) => void>();

  constructor(private readonly filePath: string) {}

  getSnapshot(): RegistrySnapshot | undefined {
    return this.current;
  }

  /** Register a listener invoked after every successful publication. */
  subscribe(listener: (next: RegistrySnapshot) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  /** Validate and publish the registry file's current contents atomically. */
  publish(): RegistrySnapshot {
    const candidate = buildRegistrySnapshot(this.filePath);
    const revision = (this.current?.revision ?? 0) + 1;
    this.current = candidate.withRevision(revision);
    for (const listener of [...this.subscribers]) {
      listener(this.current);
    }
    return this.current;
  }
}
