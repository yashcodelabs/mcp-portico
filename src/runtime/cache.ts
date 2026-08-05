import { canonicalize } from '../catalog/canonical';

/**
 * Namespaced response cache.
 *
 * Every cache key includes the isolation dimensions a response depends on:
 * tenant, connection, catalog checksum, operation, normalized input, and
 * principal. No entry is ever shared across tenants or connections, and a
 * catalog change (checksum) naturally invalidates affected entries.
 */

export interface CacheScope {
  tenantId: string;
  connectionId: string;
  catalogChecksum: string;
  operationId: string;
  /** Canonicalized, normalized operation input. */
  input?: unknown;
  /** Included whenever output can vary by principal. */
  principalId?: string;
}

interface CacheEntry {
  value: unknown;
  lastUsed: number;
}

export class CacheStore {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly clock: () => number;

  constructor(
    private readonly maxEntries = 1024,
    clock: () => number = Date.now,
  ) {
    this.clock = clock;
  }

  /** Build a stable, isolation-scoped cache key. */
  key(scope: CacheScope): string {
    return canonicalize({
      tenantId: scope.tenantId,
      connectionId: scope.connectionId,
      catalogChecksum: scope.catalogChecksum,
      operationId: scope.operationId,
      input: scope.input,
      principalId: scope.principalId,
    });
  }

  get(key: string): unknown | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    entry.lastUsed = this.clock();
    return entry.value;
  }

  set(key: string, value: unknown): void {
    this.entries.set(key, { value, lastUsed: this.clock() });
    this.evictIfNeeded();
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      let oldestKey: string | undefined;
      let oldestUsed = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (entry.lastUsed < oldestUsed) {
          oldestUsed = entry.lastUsed;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }
}
