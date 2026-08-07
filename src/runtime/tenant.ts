import { defaultSecretResolver } from '../auth/secrets';
import type {
  IdentityProvider,
  PorticoAuthResult,
  PorticoPrincipal,
} from '../auth/types';
import { MemoryAuditLog, newAuditEvent, type AuditLog } from '../audit/log';
import { parsePorticoKey } from '../identity/keys';
import { LimitsStore, scopeKey } from '../limits/store';
import type { RegistrySnapshot } from '../registry/snapshot';
import type { Connection } from '../registry/types';
import { executeProbe, type ProbeResult } from '../security/probe';
import { SessionStore, type SessionState } from '../session/store';
import { PorticoError } from '../shared/errors';
import { CacheStore } from './cache';
import { CircuitBreakerStore } from './circuit';
import { HealthStore } from './health';
import type {
  ExecuteContext,
  ExecuteOperationInput,
  ExecuteResult,
  OperationExecutor,
} from './execution';

/**
 * Tenant-aware runtime facade (Phase 3 isolation model).
 *
 * This is the seam the Phase 5 MCP tools will call. Every operation starts
 * from an authenticated principal, re-checks authorization against the
 * current registry snapshot, records audit events, and applies rate,
 * concurrency, circuit-breaker, and health isolation keyed by tenant and
 * connection. No method accepts tenant, principal, backend, connection, or
 * base-URL values from client-controlled input.
 */

export interface TenantRuntimeOptions {
  snapshot: RegistrySnapshot;
  identityProvider?: IdentityProvider;
  sessions?: SessionStore;
  limits?: LimitsStore;
  audit?: AuditLog;
  caches?: CacheStore;
  circuitBreakers?: CircuitBreakerStore;
  health?: HealthStore;
  /** Phase 5 operation executor; required for call_operation/call_operations. */
  executor?: OperationExecutor;
}

export interface TestConnectionOptions {
  method?: string;
  path?: string;
  timeoutMs?: number;
}

export class TenantRuntime {
  readonly sessions: SessionStore;
  readonly limits: LimitsStore;
  readonly audit: AuditLog;
  readonly caches: CacheStore;
  readonly circuitBreakers: CircuitBreakerStore;
  readonly health: HealthStore;

  private currentSnapshot: RegistrySnapshot;
  private readonly identityProvider?: IdentityProvider;
  private readonly executor?: OperationExecutor;

  constructor(options: TenantRuntimeOptions) {
    this.currentSnapshot = options.snapshot;
    this.identityProvider = options.identityProvider;
    this.executor = options.executor;
    this.sessions = options.sessions ?? new SessionStore();
    this.limits = options.limits ?? new LimitsStore();
    this.audit = options.audit ?? new MemoryAuditLog();
    this.caches = options.caches ?? new CacheStore();
    this.circuitBreakers = options.circuitBreakers ?? new CircuitBreakerStore();
    this.health = options.health ?? new HealthStore();
  }

  get snapshot(): RegistrySnapshot {
    return this.currentSnapshot;
  }

  /**
   * Swap to a newly published snapshot and invalidate affected session
   * selections and cache entries. The previous snapshot stays active until
   * this call succeeds.
   */
  updateSnapshot(next: RegistrySnapshot): void {
    this.currentSnapshot = next;
    this.sessions.invalidateForSnapshot(next);
    this.caches.clear();
    const validScopes = new Set<string>();
    for (const connection of next.document.connections) {
      validScopes.add(scopeKey(connection.tenantId, connection.id));
    }
    this.health.retain(validScopes);
  }

  /** Authenticate a Portico credential; records an audit event either way. */
  async authenticate(credential: string): Promise<PorticoAuthResult> {
    if (this.identityProvider === undefined) {
      throw new PorticoError(
        'CONFIG_ERROR',
        'No identity provider is configured for this runtime.',
      );
    }
    const startedAt = Date.now();
    const result = await this.identityProvider.authenticate(credential);
    const parsed = parsePorticoKey(credential);
    if (result === undefined) {
      this.audit.record(
        newAuditEvent({
          tenantId: undefined,
          principalId: parsed?.keyId,
          registryRevision: this.currentSnapshot.revision,
          action: 'authenticate',
          outcome: 'failure',
          durationMs: Date.now() - startedAt,
          errorCode: 'AUTH',
        }),
      );
      throw new PorticoError('AUTH', 'Invalid Portico API key.', {
        details: { authMethod: 'static-bearer' },
      });
    }
    this.audit.record(
      newAuditEvent({
        tenantId: result.principal.tenantId,
        principalId: result.principal.id,
        registryRevision: this.currentSnapshot.revision,
        action: 'authenticate',
        outcome: 'success',
        durationMs: Date.now() - startedAt,
        authMethod: result.authMethod,
      }),
    );
    return result;
  }

  /** Authorized connections for a principal (discovery helper). */
  authorizedConnections(principal: PorticoPrincipal): Connection[] {
    const record = this.currentSnapshot.principal(principal.id);
    if (record === undefined || record.tenantId !== principal.tenantId) return [];
    return this.currentSnapshot.connectionsForPrincipal(record);
  }

  /** Select a connection and create a tenant/principal-namespaced session. */
  selectConnection(auth: PorticoAuthResult, connectionId: string): SessionState {
    const record = this.currentSnapshot.principal(auth.principal.id);
    if (record === undefined || record.tenantId !== auth.principal.tenantId) {
      throw new PorticoError('AUTH', 'Principal is not registered in the registry.');
    }
    const connection = this.currentSnapshot.authorizeConnection(record, connectionId);
    if (connection === undefined) {
      this.audit.record(
        newAuditEvent({
          tenantId: auth.principal.tenantId,
          principalId: auth.principal.id,
          connectionId,
          registryRevision: this.currentSnapshot.revision,
          action: 'select_connection',
          outcome: 'failure',
          errorCode: 'AUTH',
        }),
      );
      throw new PorticoError(
        'AUTH',
        `Principal "${auth.principal.id}" is not authorized for connection "${connectionId}".`,
      );
    }
    const state = this.sessions.create({
      principal: auth.principal,
      connectionId: connection.id,
      snapshot: this.currentSnapshot,
    });
    this.audit.record(
      newAuditEvent({
        tenantId: auth.principal.tenantId,
        principalId: auth.principal.id,
        connectionId: connection.id,
        backendId: connection.backendId,
        catalogChecksum: this.currentSnapshot.catalogForConnection(connection.id)
          ?.checksum,
        registryRevision: this.currentSnapshot.revision,
        action: 'select_connection',
        outcome: 'success',
      }),
    );
    return state;
  }

  /** Re-validate a session against the authenticated principal and snapshot. */
  assertSession(state: SessionState, principal: PorticoPrincipal): SessionState {
    return this.sessions.assertUsable(state, principal, this.currentSnapshot);
  }

  /**
   * Execute a catalog operation (Phase 5). Re-validates the session against
   * the authenticated principal and current snapshot, then delegates to the
   * operation executor, which enforces confirmation, validation, isolation,
   * network policy, response limits, and redaction.
   */
  async executeOperation(
    session: SessionState,
    principal: PorticoPrincipal,
    input: ExecuteOperationInput,
  ): Promise<ExecuteResult> {
    this.assertSession(session, principal);
    if (this.executor === undefined) {
      throw new PorticoError(
        'CONFIG_ERROR',
        'No operation executor is configured for this runtime.',
      );
    }
    const context: ExecuteContext = {
      snapshot: this.currentSnapshot,
      session,
      principal,
    };
    return this.executor.execute(context, input);
  }

  /**
   * Operator-style connection probe for an authenticated principal, under
   * rate, concurrency, circuit-breaker, health, and audit isolation.
   */
  async testConnection(
    principal: PorticoPrincipal,
    connectionId: string,
    options: TestConnectionOptions = {},
  ): Promise<ProbeResult> {
    const record = this.currentSnapshot.principal(principal.id);
    if (record === undefined || record.tenantId !== principal.tenantId) {
      throw new PorticoError('AUTH', 'Principal is not registered in the registry.');
    }
    const connection = this.currentSnapshot.authorizeConnection(record, connectionId);
    if (connection === undefined) {
      throw new PorticoError(
        'AUTH',
        `Principal "${principal.id}" is not authorized for connection "${connectionId}".`,
      );
    }

    const policy = connection.policy ?? {};
    const rateKey = scopeKey(record.tenantId, connection.id, principal.id);
    if (policy.rateLimitPerMinute !== undefined) {
      const rate = this.limits.rateLimit(rateKey, policy.rateLimitPerMinute);
      if (!rate.allowed) {
        throw new PorticoError('API_ERROR', 'Connection rate limit exceeded.', {
          details: { retryAfterMs: rate.retryAfterMs },
        });
      }
    }

    const concurrencyKey = scopeKey(record.tenantId, connection.id);
    const concurrencyLimit = policy.maxConcurrency ?? Number.POSITIVE_INFINITY;
    if (!this.limits.acquireConcurrency(concurrencyKey, concurrencyLimit)) {
      throw new PorticoError('API_ERROR', 'Connection concurrency limit reached.');
    }

    const circuitKey = scopeKey(record.tenantId, connection.id);
    if (this.circuitBreakers.state(circuitKey) === 'open') {
      this.limits.releaseConcurrency(concurrencyKey);
      throw new PorticoError(
        'API_ERROR',
        'Connection circuit breaker is open; refusing the probe.',
      );
    }

    const startedAt = Date.now();
    let result: ProbeResult;
    try {
      result = await executeProbe({
        url: new URL(options.path ?? '/', connection.baseUrl),
        method: options.method,
        auth: connection.auth,
        staticHeaders: connection.staticHeaders,
        network: connection.network ?? {},
        timeoutMs: options.timeoutMs ?? policy.timeoutMs,
        maxResponseBytes: policy.maxResponseBytes,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      this.circuitBreakers.onFailure(circuitKey);
      this.health.record(record.tenantId, connection.id, {
        ok: false,
        durationMs,
        errorCode: error instanceof PorticoError ? error.code : 'REQUEST_FAILED',
      });
      this.audit.record(
        newAuditEvent({
          tenantId: record.tenantId,
          principalId: principal.id,
          connectionId: connection.id,
          backendId: connection.backendId,
          catalogChecksum: this.currentSnapshot.catalogForConnection(connection.id)
            ?.checksum,
          registryRevision: this.currentSnapshot.revision,
          action: 'test_connection',
          outcome: 'failure',
          durationMs,
          errorCode: error instanceof PorticoError ? error.code : 'REQUEST_FAILED',
        }),
      );
      throw error;
    } finally {
      this.limits.releaseConcurrency(concurrencyKey);
    }

    const durationMs = Date.now() - startedAt;
    if (result.ok) {
      this.circuitBreakers.onSuccess(circuitKey);
    } else {
      this.circuitBreakers.onFailure(circuitKey);
    }
    this.health.record(record.tenantId, connection.id, {
      ok: result.ok,
      statusCode: result.status,
      durationMs,
      errorCode: result.errorCode,
    });
    this.audit.record(
      newAuditEvent({
        tenantId: record.tenantId,
        principalId: principal.id,
        connectionId: connection.id,
        backendId: connection.backendId,
        catalogChecksum: this.currentSnapshot.catalogForConnection(connection.id)
          ?.checksum,
        registryRevision: this.currentSnapshot.revision,
        action: 'test_connection',
        outcome: result.ok ? 'success' : 'failure',
        durationMs,
        errorCode: result.errorCode,
      }),
    );
    return result;
  }
}
