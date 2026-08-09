import { randomUUID } from 'node:crypto';

/**
 * Audit records.
 *
 * Every record is namespaced by client credential, tenant, and principal
 * and includes the connection, backend, catalog checksum, registry
 * revision, operation, outcome, and duration. Records never contain
 * credentials - `clientId` is the public credential identifier (for example
 * the static bearer key id), never the token - and serialization runs
 * through the redactor before any output.
 */

export type AuditAction =
  | 'authenticate'
  | 'discover'
  | 'select_connection'
  | 'describe_operation'
  | 'call_operation'
  | 'call_operations'
  | 'test_connection';

export interface AuditEvent {
  id: string;
  timestamp: string;
  /** Present when an authenticated identity is known (absent for failed auth). */
  /**
   * Identifier of the client credential that authenticated the request
   * (for example the static bearer key id). Never the credential itself.
   */
  clientId?: string;
  tenantId?: string;
  principalId?: string;
  connectionId?: string;
  backendId?: string;
  catalogChecksum?: string;
  registryRevision: number;
  operation?: string;
  action: AuditAction;
  outcome: 'success' | 'failure';
  durationMs?: number;
  errorCode?: string;
  authMethod?: string;
}

export interface AuditLog {
  record(event: AuditEvent): void;
  /** Tenant-filtered view; filtering happens before aggregation/pagination. */
  forTenant(tenantId: string): AuditEvent[];
}

export class MemoryAuditLog implements AuditLog {
  private readonly events: AuditEvent[] = [];

  record(event: AuditEvent): void {
    this.events.push(event);
  }

  forTenant(tenantId: string): AuditEvent[] {
    return this.events.filter((event) => event.tenantId === tenantId);
  }

  all(): AuditEvent[] {
    return [...this.events];
  }

  count(): number {
    return this.events.length;
  }

  clear(): void {
    this.events.length = 0;
  }
}

export function newAuditEvent(event: Omit<AuditEvent, 'id' | 'timestamp'>): AuditEvent {
  return {
    ...event,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
  };
}
