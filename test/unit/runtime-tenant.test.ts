import http from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryAuditLog } from '../../src/audit/log';
import { generatePorticoKey } from '../../src/identity/keys';
import { StaticBearerIdentityProvider } from '../../src/identity/static-bearer';
import { LimitsStore } from '../../src/limits/store';
import { snapshotFromDocument } from '../../src/registry/snapshot';
import type { RegistryDocument } from '../../src/registry/types';
import { CacheStore } from '../../src/runtime/cache';
import { CircuitBreakerStore } from '../../src/runtime/circuit';
import { HealthStore } from '../../src/runtime/health';
import { TenantRuntime } from '../../src/runtime/tenant';
import { SessionStore } from '../../src/session/store';
import { PorticoError } from '../../src/shared/errors';
import { sampleCatalog, TEST_CATALOG_REF } from '../helpers/registry';

const PEPPER = 'runtime-test-pepper';
const originalToken = process.env.PORTICO_RUNTIME_TOKEN;

let server: http.Server;
let port = 0;
let document: RegistryDocument;
let runtime: TenantRuntime;
let audit: MemoryAuditLog;
let key: ReturnType<typeof generatePorticoKey>;

beforeAll(async () => {
  process.env.PORTICO_RUNTIME_TOKEN = 'runtime-secret-token';
  key = generatePorticoKey(PEPPER);
  document = {
    version: 1,
    tenants: [
      { id: 'acme', name: 'Acme' },
      { id: 'globex', name: 'Globex' },
    ],
    principals: [
      {
        id: 'acme-automation',
        tenantId: 'acme',
        allowedConnectionIds: ['acme-billing-prod'],
        keyId: key.keyId,
        keyDigest: key.digest,
      },
      {
        id: 'globex-automation',
        tenantId: 'globex',
        allowedConnectionIds: [],
      },
    ],
    backends: [
      {
        id: 'billing',
        title: 'Billing API',
        scope: 'global',
        catalogRef: TEST_CATALOG_REF,
        catalogChecksum: sampleCatalog().checksum,
      },
    ],
    connections: [
      {
        id: 'acme-billing-prod',
        tenantId: 'acme',
        backendId: 'billing',
        baseUrl: 'http://127.0.0.1:9',
        network: { allowedProtocols: ['http'], allowLoopback: true },
        auth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          valueRef: 'env:PORTICO_RUNTIME_TOKEN',
        },
        policy: { rateLimitPerMinute: 3, maxConcurrency: 1 },
      },
    ],
  };

  server = http.createServer((_req, res) => {
    if (_req.url === '/hang') return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
  const connection = document.connections[0];
  if (connection !== undefined) {
    connection.baseUrl = `http://127.0.0.1:${port}`;
  }

  audit = new MemoryAuditLog();
  runtime = new TenantRuntime({
    snapshot: snapshotFromDocument(
      document,
      new Map([[TEST_CATALOG_REF, sampleCatalog()]]),
    ),
    identityProvider: new StaticBearerIdentityProvider(
      snapshotFromDocument(document, new Map([[TEST_CATALOG_REF, sampleCatalog()]])),
      PEPPER,
    ),
    sessions: new SessionStore(),
    limits: new LimitsStore(),
    audit,
    caches: new CacheStore(),
    circuitBreakers: new CircuitBreakerStore({ failureThreshold: 2 }),
    health: new HealthStore(),
  });
});

afterAll(async () => {
  if (originalToken === undefined) delete process.env.PORTICO_RUNTIME_TOKEN;
  else process.env.PORTICO_RUNTIME_TOKEN = originalToken;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('TenantRuntime', () => {
  it('authenticates a valid key and records a success audit event', async () => {
    const auth = await runtime.authenticate(key.token);
    expect(auth.principal).toMatchObject({
      id: 'acme-automation',
      tenantId: 'acme',
    });
    const events = audit.forTenant('acme').filter((e) => e.action === 'authenticate');
    expect(events.at(-1)).toMatchObject({ outcome: 'success' });
  });

  it('rejects invalid keys and records a failure audit event with the key id', async () => {
    const unknownKeyToken = `mpp_${'f'.repeat(16)}_${'x'.repeat(32)}`;
    await expect(runtime.authenticate(unknownKeyToken)).rejects.toThrow(PorticoError);
    const events = audit
      .all()
      .filter((e) => e.action === 'authenticate' && e.outcome === 'failure');
    expect(events.at(-1)?.principalId).toBeDefined();
  });

  it('lists only authorized connections and denies cross-tenant lookups', async () => {
    const auth = await runtime.authenticate(key.token);
    expect(runtime.authorizedConnections(auth.principal).map((c) => c.id)).toEqual([
      'acme-billing-prod',
    ]);
    const foreign = {
      id: 'globex-automation',
      tenantId: 'globex',
      allowedConnectionIds: [],
    };
    expect(runtime.authorizedConnections(foreign)).toEqual([]);
  });

  it('selects a connection into a principal-namespaced session', async () => {
    const auth = await runtime.authenticate(key.token);
    const session = runtime.selectConnection(auth, 'acme-billing-prod');
    expect(session.principalId).toBe('acme-automation');
    expect(runtime.assertSession(session, auth.principal)).toBe(session);
  });

  it('refuses to select a connection the principal is not authorized for', async () => {
    const globexKey = generatePorticoKey(PEPPER);
    const globexPrincipal = document.principals.find(
      (principal) => principal.id === 'globex-automation',
    );
    expect(globexPrincipal).toBeDefined();
    if (globexPrincipal !== undefined) {
      globexPrincipal.keyId = globexKey.keyId;
      globexPrincipal.keyDigest = globexKey.digest;
    }
    const updated = new TenantRuntime({
      snapshot: snapshotFromDocument(
        document,
        new Map([[TEST_CATALOG_REF, sampleCatalog()]]),
      ),
      identityProvider: new StaticBearerIdentityProvider(
        snapshotFromDocument(document, new Map([[TEST_CATALOG_REF, sampleCatalog()]])),
        PEPPER,
      ),
      sessions: runtime.sessions,
      limits: runtime.limits,
      audit: runtime.audit,
    });
    const globexAuth = await updated.authenticate(globexKey.token);
    expect(() => updated.selectConnection(globexAuth, 'acme-billing-prod')).toThrow(
      PorticoError,
    );
  });

  it('probes a connection and updates health, circuit, and audit', async () => {
    const auth = await runtime.authenticate(key.token);
    const result = await runtime.testConnection(auth.principal, 'acme-billing-prod', {
      path: '/healthz',
    });
    expect(result.ok).toBe(true);
    expect(runtime.health.get('acme', 'acme-billing-prod')?.status).toBe('healthy');
    expect(runtime.circuitBreakers.state('acme:acme-billing-prod')).toBe('closed');
    const events = audit
      .forTenant('acme')
      .filter((e) => e.action === 'test_connection');
    expect(events.at(-1)).toMatchObject({ outcome: 'success' });
  });

  it('denies probing another tenant\u2019s connection', async () => {
    const foreign = {
      id: 'globex-automation',
      tenantId: 'globex',
      allowedConnectionIds: [],
    };
    await expect(runtime.testConnection(foreign, 'acme-billing-prod')).rejects.toThrow(
      PorticoError,
    );
  });

  it('enforces the per-connection rate limit', async () => {
    const rateRuntime = new TenantRuntime({
      snapshot: snapshotFromDocument(
        document,
        new Map([[TEST_CATALOG_REF, sampleCatalog()]]),
      ),
      identityProvider: new StaticBearerIdentityProvider(
        snapshotFromDocument(document, new Map([[TEST_CATALOG_REF, sampleCatalog()]])),
        PEPPER,
      ),
      limits: new LimitsStore(),
      audit: new MemoryAuditLog(),
    });
    const auth = await rateRuntime.authenticate(key.token);
    for (let index = 0; index < 3; index += 1) {
      await rateRuntime.testConnection(auth.principal, 'acme-billing-prod', {
        path: '/x',
      });
    }
    await expect(
      rateRuntime.testConnection(auth.principal, 'acme-billing-prod', { path: '/x' }),
    ).rejects.toThrow(/rate limit/i);
  });

  it('opens the circuit breaker after repeated failures', async () => {
    const circuitRuntime = new TenantRuntime({
      snapshot: snapshotFromDocument(
        document,
        new Map([[TEST_CATALOG_REF, sampleCatalog()]]),
      ),
      identityProvider: new StaticBearerIdentityProvider(
        snapshotFromDocument(document, new Map([[TEST_CATALOG_REF, sampleCatalog()]])),
        PEPPER,
      ),
      limits: new LimitsStore(),
      audit: new MemoryAuditLog(),
      circuitBreakers: new CircuitBreakerStore({ failureThreshold: 2 }),
      health: new HealthStore(),
    });
    const auth = await circuitRuntime.authenticate(key.token);
    await circuitRuntime
      .testConnection(auth.principal, 'acme-billing-prod', {
        path: '/hang',
        timeoutMs: 300,
      })
      .catch(() => undefined);
    await circuitRuntime
      .testConnection(auth.principal, 'acme-billing-prod', {
        path: '/hang',
        timeoutMs: 300,
      })
      .catch(() => undefined);
    expect(circuitRuntime.circuitBreakers.state('acme:acme-billing-prod')).toBe('open');
    await expect(
      circuitRuntime.testConnection(auth.principal, 'acme-billing-prod', {
        path: '/x',
      }),
    ).rejects.toThrow(/circuit breaker/i);
  });

  it('refreshes the identity provider when the snapshot is updated', async () => {
    const newKey = generatePorticoKey(PEPPER);
    const nextDocument: RegistryDocument = {
      ...document,
      principals: document.principals.map((principal) =>
        principal.id === 'acme-automation'
          ? { ...principal, keyId: newKey.keyId, keyDigest: newKey.digest }
          : principal,
      ),
    };
    const next = snapshotFromDocument(
      nextDocument,
      new Map([[TEST_CATALOG_REF, sampleCatalog()]]),
      2,
    );

    await expect(runtime.authenticate(newKey.token)).rejects.toThrow(PorticoError);
    runtime.updateSnapshot(next);
    const result = await runtime.authenticate(newKey.token);
    expect(result.principal.id).toBe('acme-automation');
    await expect(runtime.authenticate(key.token)).rejects.toThrow(PorticoError);
  });
});
