/**
 * Tenant/connection-namespaced health state.
 *
 * Each record is keyed by tenant and connection so operator health checks
 * and later runtime visibility never leak one tenant's upstream state to
 * another.
 */

export type HealthStatus = 'unknown' | 'healthy' | 'unhealthy';

export interface HealthRecord {
  tenantId: string;
  connectionId: string;
  status: HealthStatus;
  lastCheckedAt?: number;
  lastDurationMs?: number;
  lastStatusCode?: number;
  lastErrorCode?: string;
  consecutiveFailures: number;
}

export interface HealthObservation {
  ok: boolean;
  statusCode?: number;
  durationMs?: number;
  errorCode?: string;
}

export class HealthStore {
  private readonly records = new Map<string, HealthRecord>();
  private readonly clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  private scopeKey(tenantId: string, connectionId: string): string {
    return `${tenantId}:${connectionId}`;
  }

  get(tenantId: string, connectionId: string): HealthRecord | undefined {
    return this.records.get(this.scopeKey(tenantId, connectionId));
  }

  record(
    tenantId: string,
    connectionId: string,
    observation: HealthObservation,
  ): HealthRecord {
    const previous = this.records.get(this.scopeKey(tenantId, connectionId));
    const consecutiveFailures = observation.ok
      ? 0
      : (previous?.consecutiveFailures ?? 0) + 1;
    const record: HealthRecord = {
      tenantId,
      connectionId,
      status: observation.ok ? 'healthy' : 'unhealthy',
      lastCheckedAt: this.clock(),
      ...(observation.durationMs !== undefined
        ? { lastDurationMs: observation.durationMs }
        : {}),
      ...(observation.statusCode !== undefined
        ? { lastStatusCode: observation.statusCode }
        : {}),
      ...(observation.errorCode !== undefined
        ? { lastErrorCode: observation.errorCode }
        : {}),
      consecutiveFailures,
    };
    this.records.set(this.scopeKey(tenantId, connectionId), record);
    return record;
  }

  /** Drop records whose connection no longer exists in the snapshot. */
  retain(validScopes: ReadonlySet<string>): void {
    for (const key of [...this.records.keys()]) {
      if (!validScopes.has(key)) this.records.delete(key);
    }
  }

  reset(): void {
    this.records.clear();
  }
}
