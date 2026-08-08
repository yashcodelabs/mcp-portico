import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AuthMode } from '../auth/binding';
import type { PorticoPrincipal } from '../auth/types';
import type { AuditLog, AuditEvent } from '../audit/log';
import type { Connection } from '../registry/types';
import type { HealthRecord } from '../runtime/health';
import type { TenantRuntime } from '../runtime/tenant';
import { PACKAGE_NAME, PRODUCT_VERSION } from '../shared/brand';
import { defaultRedactor } from '../shared/redact';
import { INSPECTOR_PAGE } from './page';

/**
 * Read-only tenant-scoped inspector (Phase 7).
 *
 * Every data endpoint authenticates the operator with a Portico API key and
 * returns only the authenticated tenant's view: authorized connections,
 * catalog metadata, warnings, health, redacted runtime state, and audit
 * activity. There is no cross-tenant view and no deployment-wide summary;
 * pagination, counts, and aggregations are computed after tenant filtering.
 * The only mutating action is the safe connection test, which runs under the
 * normal probe pipeline (rate, concurrency, circuit, health, audit).
 */

export interface InspectorOptions {
  runtime?: TenantRuntime;
  audit: AuditLog;
  authMode: AuthMode;
}

interface AuthOk {
  kind: 'ok';
  principal: PorticoPrincipal;
  runtime: TenantRuntime;
}

interface AuthError {
  kind: 'error';
  status: number;
  body: unknown;
}

type AuthResult = AuthOk | AuthError;

interface ConnectionSummaryView {
  id: string;
  backendId: string;
  backendTitle?: string;
  baseUrl: string;
  authType: string;
  auth: Record<string, unknown>;
  policy: Record<string, unknown>;
  catalog?: {
    apiId: string;
    title: string;
    version: string;
    checksum: string;
    operations: number;
    available: number;
    enabled: number;
  };
  health?: HealthRecord;
}

const DEFAULT_AUDIT_LIMIT = 100;
const MAX_AUDIT_LIMIT = 500;

export class Inspector {
  private readonly runtime?: TenantRuntime;
  private readonly audit: AuditLog;
  private readonly authMode: AuthMode;

  constructor(options: InspectorOptions) {
    this.runtime = options.runtime;
    this.audit = options.audit;
    this.authMode = options.authMode;
  }

  /** Handle a request under `/inspector`; returns false when not handled. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/inspector') {
      if (req.method !== 'GET') return this.methodNotAllowed(res);
      this.send(res, 200, INSPECTOR_PAGE, 'text/html; charset=utf-8');
      return true;
    }
    if (!url.pathname.startsWith('/inspector/api/')) return false;

    if (url.pathname === '/inspector/api/meta') {
      if (req.method !== 'GET') return this.methodNotAllowed(res);
      this.send(res, 200, this.meta());
      return true;
    }

    const auth = await this.authenticate(req);
    if (auth.kind === 'error') {
      this.send(res, auth.status, auth.body);
      return true;
    }

    if (url.pathname === '/inspector/api/overview') {
      if (req.method !== 'GET') return this.methodNotAllowed(res);
      this.send(res, 200, this.overview(auth));
      return true;
    }
    if (url.pathname === '/inspector/api/connections') {
      if (req.method !== 'GET') return this.methodNotAllowed(res);
      this.send(res, 200, this.connections(auth));
      return true;
    }
    if (url.pathname === '/inspector/api/audit') {
      if (req.method !== 'GET') return this.methodNotAllowed(res);
      const limit = parseLimit(url.searchParams.get('limit'));
      this.send(res, 200, this.auditView(auth, undefined, limit));
      return true;
    }
    const detail = /^\/inspector\/api\/connections\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (detail !== null) {
      const rawId = detail[1];
      if (rawId === undefined) return this.notFound(res);
      const connectionId = decodeURIComponent(rawId);
      const suffix = detail[2] ?? '';
      if (req.method === 'GET' && suffix === '') {
        const view = this.connectionView(auth, connectionId);
        if (view === undefined) return this.notFound(res);
        this.send(res, 200, view);
        return true;
      }
      if (req.method === 'POST' && suffix === '/test') {
        const result = await this.testConnection(auth, connectionId);
        if (result === undefined) return this.notFound(res);
        this.send(res, 200, result);
        return true;
      }
      return this.methodNotAllowed(res);
    }

    this.send(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    return true;
  }

  private meta(): unknown {
    const snapshot = this.runtime?.snapshot;
    return {
      product: PACKAGE_NAME,
      version: PRODUCT_VERSION,
      authMode: this.authMode,
      ...(snapshot !== undefined ? { registryRevision: snapshot.revision } : {}),
    };
  }

  private async authenticate(req: IncomingMessage): Promise<AuthResult> {
    if (this.runtime === undefined) {
      return {
        kind: 'error',
        status: 503,
        body: {
          error: {
            code: 'CONFIG_ERROR',
            message: 'Inspector requires a registry; start serve with --registry.',
          },
        },
      };
    }
    const header = headerValue(req.headers['authorization']);
    const match = header === undefined ? undefined : /^Bearer\s+(.+)$/i.exec(header);
    const credential = match?.[1]?.trim();
    if (credential === undefined || credential === '') {
      return {
        kind: 'error',
        status: 401,
        body: { error: { code: 'AUTH', message: 'Invalid credentials.' } },
      };
    }
    try {
      const auth = await this.runtime.authenticate(credential);
      return { kind: 'ok', principal: auth.principal, runtime: this.runtime };
    } catch {
      return {
        kind: 'error',
        status: 401,
        body: { error: { code: 'AUTH', message: 'Invalid credentials.' } },
      };
    }
  }

  private overview(auth: AuthOk): unknown {
    const connections = this.authorizedConnections(auth);
    const views: ConnectionSummaryView[] = connections.map((connection) =>
      this.connectionSummary(auth, connection),
    );
    const summary = {
      connections: views.length,
      operations: views.reduce(
        (total, view) => total + (view.catalog?.operations ?? 0),
        0,
      ),
      available: views.reduce(
        (total, view) => total + (view.catalog?.available ?? 0),
        0,
      ),
      unhealthy: views.filter((view) => view.health?.status === 'unhealthy').length,
    };
    const tenant = this.tenantName(auth.principal.tenantId);
    return {
      tenant,
      principal: {
        id: auth.principal.id,
        allowedConnectionIds: auth.principal.allowedConnectionIds,
      },
      summary,
      connections: views,
    };
  }

  private connections(auth: AuthOk): unknown {
    return {
      connections: this.authorizedConnections(auth).map((connection) =>
        this.connectionSummary(auth, connection),
      ),
    };
  }

  private connectionView(auth: AuthOk, connectionId: string): unknown | undefined {
    const connection = this.findConnection(auth, connectionId);
    if (connection === undefined) return undefined;
    const summary = this.connectionSummary(auth, connection);
    const catalog = this.catalogFor(auth, connection);
    const runtime = auth.runtime;
    const scope = scopeKey(auth.principal.tenantId, connection.id);
    return {
      ...summary,
      operations:
        catalog === undefined
          ? []
          : Object.entries(catalog.operations)
              .map(([operationId, operation]) => ({
                id: operationId,
                method: operation.method,
                path: operation.path,
                risk: operation.risk,
                available: operation.available,
                enabled: operation.enabled,
                confirmation: operation.confirmation,
                timeoutMs: operation.timeoutMs,
                maxRequestBytes: operation.maxRequestBytes,
                maxResponseBytes: operation.maxResponseBytes,
              }))
              .sort((left, right) => left.id.localeCompare(right.id)),
      warnings: catalog?.provenance.warnings?.length ?? 0,
      circuit: runtime.circuitBreakers.state(scope),
      concurrency: runtime.limits.concurrencyFor(scope),
      audit: this.auditView(auth, connection.id, 50).events,
    };
  }

  private connectionSummary(
    auth: AuthOk,
    connection: Connection,
  ): ConnectionSummaryView {
    const runtime = auth.runtime;
    const backend = runtime.snapshot.document.backends.find(
      (candidate) => candidate.id === connection.backendId,
    );
    const catalog = this.catalogFor(auth, connection);
    return {
      id: connection.id,
      backendId: connection.backendId,
      backendTitle: backend?.title,
      baseUrl: connection.baseUrl,
      authType: connection.auth.type,
      auth: this.authSummary(connection),
      policy: this.policySummary(connection),
      catalog:
        catalog === undefined
          ? undefined
          : {
              apiId: catalog.api.id,
              title: catalog.api.title,
              version: catalog.api.version,
              checksum: catalog.checksum,
              operations: Object.keys(catalog.operations).length,
              available: Object.values(catalog.operations).filter(
                (operation) => operation.available,
              ).length,
              enabled: Object.values(catalog.operations).filter(
                (operation) => operation.enabled,
              ).length,
            },
      health: runtime.health.get(auth.principal.tenantId, connection.id),
    };
  }

  private auditView(
    auth: AuthOk,
    connectionId: string | undefined,
    limit: number,
  ): { events: AuditEvent[] } {
    const tenantId = auth.principal.tenantId;
    const events = this.audit
      .forTenant(tenantId)
      .filter(
        (event) => connectionId === undefined || event.connectionId === connectionId,
      )
      .reverse()
      .slice(0, limit);
    return { events };
  }

  private async testConnection(
    auth: AuthOk,
    connectionId: string,
  ): Promise<unknown | undefined> {
    const connection = this.findConnection(auth, connectionId);
    if (connection === undefined) return undefined;
    try {
      const probe = await auth.runtime.testConnection(auth.principal, connection.id);
      return { probe };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Probe failed';
      const code =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : 'PROBE_FAILED';
      return {
        probe: {
          ok: false,
          errorCode: code,
          message,
        },
      };
    }
  }

  private authorizedConnections(auth: AuthOk): Connection[] {
    return auth.runtime.authorizedConnections(auth.principal);
  }

  private findConnection(auth: AuthOk, connectionId: string): Connection | undefined {
    return this.authorizedConnections(auth).find(
      (connection) => connection.id === connectionId,
    );
  }

  private catalogFor(auth: AuthOk, connection: Connection) {
    return auth.runtime.snapshot.catalogForConnection(connection.id);
  }

  private tenantName(tenantId: string): { id: string; name: string } {
    const snapshot = this.runtime?.snapshot;
    const tenant = snapshot?.document.tenants.find(
      (candidate) => candidate.id === tenantId,
    );
    return { id: tenantId, name: tenant?.name ?? tenantId };
  }

  /**
   * Describe connection auth without ever exposing secret values: only the
   * type and the secret reference names are included.
   */
  private authSummary(connection: Connection): Record<string, unknown> {
    const auth = connection.auth;
    switch (auth.type) {
      case 'none':
        return { type: 'none' };
      case 'bearer':
        return { type: 'bearer', tokenRef: auth.tokenRef };
      case 'apiKey':
        return {
          type: 'apiKey',
          in: auth.in,
          name: auth.name,
          valueRef: auth.valueRef,
        };
      case 'basic':
        return {
          type: 'basic',
          usernameRef: auth.usernameRef,
          passwordRef: auth.passwordRef,
        };
      case 'staticHeaders':
        return {
          type: 'staticHeaders',
          headers: Object.fromEntries(
            Object.entries(auth.headers).map(([name, valueRef]) => [name, valueRef]),
          ),
        };
    }
  }

  private policySummary(connection: Connection): Record<string, unknown> {
    const policy = connection.policy;
    if (policy === undefined) return {};
    return {
      ...(policy.disabledOperations !== undefined
        ? { disabledOperations: policy.disabledOperations }
        : {}),
      ...(policy.confirmation !== undefined
        ? { confirmation: policy.confirmation }
        : {}),
      ...(policy.timeoutMs !== undefined ? { timeoutMs: policy.timeoutMs } : {}),
      ...(policy.maxRequestBytes !== undefined
        ? { maxRequestBytes: policy.maxRequestBytes }
        : {}),
      ...(policy.maxResponseBytes !== undefined
        ? { maxResponseBytes: policy.maxResponseBytes }
        : {}),
      ...(policy.maxConcurrency !== undefined
        ? { maxConcurrency: policy.maxConcurrency }
        : {}),
      ...(policy.rateLimitPerMinute !== undefined
        ? { rateLimitPerMinute: policy.rateLimitPerMinute }
        : {}),
      ...(policy.allowedContentTypes !== undefined
        ? { allowedContentTypes: policy.allowedContentTypes }
        : {}),
      ...(policy.redactions !== undefined ? { redactions: policy.redactions } : {}),
    };
  }

  private notFound(res: ServerResponse): boolean {
    this.send(res, 404, {
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
    return true;
  }

  private methodNotAllowed(res: ServerResponse): boolean {
    this.send(
      res,
      405,
      { error: { code: 'USAGE', message: 'Method not allowed' } },
      'application/json',
      { allow: 'GET, POST' },
    );
    return true;
  }

  private send(
    res: ServerResponse,
    status: number,
    body: unknown,
    contentType = 'application/json',
    extraHeaders?: Record<string, string>,
  ): void {
    const payload =
      typeof body === 'string' ? body : JSON.stringify(defaultRedactor.redact(body));
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': Buffer.byteLength(payload),
      ...extraHeaders,
    });
    res.end(payload);
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function parseLimit(raw: string | null): number {
  const parsed = raw === null ? NaN : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_AUDIT_LIMIT;
  return Math.min(parsed, MAX_AUDIT_LIMIT);
}

function scopeKey(...parts: Array<string | number>): string {
  return parts.join(':');
}
