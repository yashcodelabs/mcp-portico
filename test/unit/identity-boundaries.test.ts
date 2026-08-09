import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { PorticoPrincipal } from '../../src/auth/types';
import { MemoryAuditLog } from '../../src/audit/log';
import type { NormalizedApiModel } from '../../src/catalog/types';
import { compileCatalog } from '../../src/catalog/compile';
import { generatePorticoKey } from '../../src/identity/keys';
import { StaticBearerIdentityProvider } from '../../src/identity/static-bearer';
import { LimitsStore, scopeKey } from '../../src/limits/store';
import { assertToolArgumentsValid, FIXED_TOOLS } from '../../src/mcp/tools';
import { snapshotFromDocument } from '../../src/registry/snapshot';
import type { RegistryDocument } from '../../src/registry/types';
import { CacheStore } from '../../src/runtime/cache';
import { CircuitBreakerStore } from '../../src/runtime/circuit';
import { createOperationExecutor } from '../../src/runtime/executor';
import type { OperationExecutor } from '../../src/runtime/execution';
import { HealthStore } from '../../src/runtime/health';
import { TenantRuntime } from '../../src/runtime/tenant';
import {
  assertSameOrigin,
  renderPath,
  resolveProbeTarget,
} from '../../src/runtime/transports';
import { validateOperationArguments } from '../../src/runtime/validate';
import { SessionStore, type SessionState } from '../../src/session/store';
import { PorticoError } from '../../src/shared/errors';
import { summarizeAudit } from '../../src/telemetry/summary';
import {
  sampleCatalog,
  sampleRegistryDoc,
  TEST_CATALOG_REF,
} from '../helpers/registry';

const PEPPER = 'identity-boundaries-pepper';

/** Keys that would override Portico-owned identity or origin decisions. */
const IDENTITY_OVERRIDE_KEYS = [
  'tenantId',
  'principalId',
  'backendId',
  'connectionId',
  'baseUrl',
  'origin',
  'url',
  'tenant',
  'principal',
  'backend',
  'connection',
];

describe('MCP tool argument boundary', () => {
  it.each(FIXED_TOOLS.map((tool) => tool.name))(
    'rejects identity override keys at the boundary for %s',
    (toolName) => {
      const tool = FIXED_TOOLS.find((candidate) => candidate.name === toolName);
      expect(tool).toBeDefined();
      if (tool === undefined) return;
      const modeled = new Set(
        Object.keys((tool.inputSchema.properties ?? {}) as Record<string, unknown>),
      );
      for (const key of IDENTITY_OVERRIDE_KEYS) {
        // Keys the tool schema legitimately models (for example the
        // connection selection target) are governed by the principal
        // allowlist instead of being blanket-rejected.
        if (modeled.has(key)) continue;
        const error = expectToThrow(() =>
          assertToolArgumentsValid(tool, { [key]: 'attacker-value' }),
        );
        expect(error.code).toBe('USAGE');
        expect(error.message).toContain(`Invalid arguments for tool "${toolName}"`);
        expect(error.message).toContain(key);
      }
    },
  );

  it('allows the connection selection target only where the schema models it', () => {
    const select = FIXED_TOOLS.find((tool) => tool.name === 'select_connection');
    const testTool = FIXED_TOOLS.find((tool) => tool.name === 'test_connection');
    const call = FIXED_TOOLS.find((tool) => tool.name === 'call_operation');
    expect(select).toBeDefined();
    expect(testTool).toBeDefined();
    expect(call).toBeDefined();
    if (select === undefined || testTool === undefined || call === undefined) return;

    expect(() =>
      assertToolArgumentsValid(select, { connectionId: 'acme-billing' }),
    ).not.toThrow();
    expect(() =>
      assertToolArgumentsValid(testTool, {
        connectionId: 'acme-billing',
        path: '/',
      }),
    ).not.toThrow();
    expect(() =>
      assertToolArgumentsValid(call, { operationId: 'invoice.get' }),
    ).not.toThrow();
  });

  it('keeps call_operation arguments catalog-governed, never identity-governed', () => {
    const call = FIXED_TOOLS.find((tool) => tool.name === 'call_operation');
    expect(call).toBeDefined();
    if (call === undefined) return;

    // The MCP layer only checks the free-form `arguments` object shape; the
    // catalog decides which keys are modeled upstream parameters.
    expect(() =>
      assertToolArgumentsValid(call, {
        operationId: 'invoice.get',
        arguments: { tenantId: 'upstream-modeled-value' },
      }),
    ).not.toThrow();

    // A catalog that models `tenantId` as an upstream query parameter treats
    // it as API data; an unmodeled key is rejected before dispatch.
    const model: NormalizedApiModel = {
      api: { id: 'echo', title: 'Echo API', version: '1.0.0' },
      securitySchemes: {},
      operations: [
        {
          operationId: 'echo.get',
          method: 'GET',
          path: '/echo',
          parameters: [
            {
              in: 'query',
              name: 'tenantId',
              required: false,
              schema: { type: 'string' },
            },
          ],
          responses: { '200': { description: 'OK' } },
        },
      ],
    };
    const { catalog } = compileCatalog(model);
    const operation = catalog.operations['echo.get'];
    expect(operation).toBeDefined();
    if (operation === undefined) return;

    expect(validateOperationArguments(operation, { tenantId: 'acme' }).query).toEqual({
      tenantId: 'acme',
    });

    const unmodeled = expectToThrow(() =>
      validateOperationArguments(sampleCatalog().operations['invoice.get']!, {
        tenantId: 'acme',
      }),
    );
    expect(unmodeled.code).toBe('USAGE');
    expect(unmodeled.message).toContain('Unknown argument(s): tenantId.');
  });
});

describe('origin boundary', () => {
  const baseUrl = 'https://api.example.com/v1';

  it.each([
    'https://evil.example/x',
    'http://api.example.com/x',
    '//evil.example/x',
    '\\\\evil.example\\x',
    'https://api.example.com:8443/x',
    'http://127.0.0.1:9/x',
  ])('rejects probe path that escapes the connection origin: %s', (path) => {
    const error = expectToThrow(() => resolveProbeTarget(baseUrl, path));
    expect(error.code).toBe('USAGE');
    expect(error.message).toContain('outside the connection origin');
  });

  it.each(['/', '', '/api/v2/invoices/1', '/invoices?tenant=acme'])(
    'accepts same-origin probe path: %s',
    (path) => {
      const target = resolveProbeTarget(baseUrl, path);
      expect(target.origin).toBe(new URL(baseUrl).origin);
    },
  );

  it('rejects rendered catalog paths that resolve off-origin', () => {
    const url = new URL(renderPath('//evil.example/invoices', {}), baseUrl);
    const error = expectToThrow(() => assertSameOrigin(url, baseUrl));
    expect(error.code).toBe('CONFIG_ERROR');
    expect(error.message).toContain('outside the connection origin');
  });

  it('keeps absolute-looking path parameter values on the connection origin', () => {
    const rendered = renderPath('/invoices/{id}', {
      id: 'https://evil.example/x',
    });
    expect(rendered).toBe('/invoices/https%3A%2F%2Fevil.example%2Fx');
    const url = new URL(rendered, baseUrl);
    expect(() => assertSameOrigin(url, baseUrl)).not.toThrow();
  });
});

describe('audit identity dimensions', () => {
  it('records the client credential id for successful and failed authentication', async () => {
    const key = generatePorticoKey(PEPPER);
    const document: RegistryDocument = {
      ...sampleRegistryDoc(),
      principals: [
        {
          id: 'acme-automation',
          tenantId: 'acme',
          allowedConnectionIds: ['acme-billing-prod'],
          keyId: key.keyId,
          keyDigest: key.digest,
        },
      ],
    };
    const snapshot = snapshotFromDocument(
      document,
      new Map([[TEST_CATALOG_REF, sampleCatalog()]]),
    );
    const audit = new MemoryAuditLog();
    const runtime = new TenantRuntime({
      snapshot,
      identityProvider: new StaticBearerIdentityProvider(snapshot, PEPPER),
      audit,
    });

    const auth = await runtime.authenticate(key.token);
    expect(auth.principal.clientId).toBe(key.keyId);
    const success = audit
      .all()
      .find((event) => event.action === 'authenticate' && event.outcome === 'success');
    expect(success).toMatchObject({
      clientId: key.keyId,
      tenantId: 'acme',
      principalId: 'acme-automation',
      authMethod: 'static-bearer',
    });

    await expect(
      runtime.authenticate(`mpp_${key.keyId}_${'x'.repeat(32)}`),
    ).rejects.toThrow(PorticoError);
    const failure = audit
      .all()
      .find((event) => event.action === 'authenticate' && event.outcome === 'failure');
    expect(failure?.clientId).toBe(key.keyId);
    expect(JSON.stringify(audit.all())).not.toContain(key.secret);
    expect(JSON.stringify(audit.all())).not.toContain(key.token);
  });

  it('records every isolation dimension for executed operations without credentials', async () => {
    const env = await executorEnv();
    try {
      await env.executor.execute(
        {
          snapshot: env.snapshot,
          session: env.session,
          principal: env.principal,
        },
        { operationId: 'echo.get', arguments: { id: 'x' } },
      );
      const event = env.audit
        .all()
        .find((candidate) => candidate.action === 'call_operation');
      expect(event).toMatchObject({
        clientId: 'client-key-1',
        tenantId: 'acme',
        principalId: 'automation',
        connectionId: 'conn',
        backendId: 'echo',
        catalogChecksum: env.catalog.checksum,
        operation: 'echo.get',
        outcome: 'success',
      });
      expect(JSON.stringify(env.audit.all())).not.toMatch(
        /token|secret|password|apiKey/i,
      );
    } finally {
      await env.close();
    }
  });
});

describe('isolation dimension verification', () => {
  it('sessions cannot cross a principal boundary', () => {
    const store = new SessionStore();
    const snapshot = snapshotFromDocument(
      sampleRegistryDoc(),
      new Map([[TEST_CATALOG_REF, sampleCatalog()]]),
    );
    const acme: PorticoPrincipal = {
      id: 'acme-automation',
      tenantId: 'acme',
      allowedConnectionIds: ['acme-billing-prod'],
      clientId: 'client-a',
    };
    const state = store.create({
      principal: acme,
      connectionId: 'acme-billing-prod',
      snapshot,
    });
    const globex: PorticoPrincipal = {
      id: 'globex-automation',
      tenantId: 'globex',
      allowedConnectionIds: ['globex-billing-prod'],
      clientId: 'client-g',
    };
    const error = expectToThrow(() => store.assertUsable(state, globex, snapshot));
    expect(error.code).toBe('AUTH');
  });

  it('caches, rate limits, and telemetry stay tenant/principal-isolated', () => {
    const cache = new CacheStore();
    const base = {
      connectionId: 'billing',
      catalogChecksum: 'sha256:abc',
      operationId: 'invoice.get',
      input: { id: 1 },
    };
    const acmeKey = cache.key({ ...base, tenantId: 'acme', principalId: 'a' });
    const globexKey = cache.key({ ...base, tenantId: 'globex', principalId: 'g' });
    cache.set(acmeKey, 'acme-data');
    expect(cache.get(globexKey)).toBeUndefined();
    expect(cache.get(acmeKey)).toBe('acme-data');

    const limits = new LimitsStore();
    limits.rateLimit(scopeKey('acme', 'billing', 'a'), 1, 0);
    expect(limits.rateLimit(scopeKey('acme', 'billing', 'a'), 1, 1).allowed).toBe(
      false,
    );
    expect(limits.rateLimit(scopeKey('globex', 'billing', 'g'), 1, 1).allowed).toBe(
      true,
    );

    const summary = summarizeAudit(
      [
        {
          id: '1',
          timestamp: '2026-08-09T00:00:00.000Z',
          clientId: 'client-a',
          tenantId: 'acme',
          principalId: 'a',
          connectionId: 'billing',
          registryRevision: 1,
          action: 'call_operation',
          outcome: 'success',
        },
        {
          id: '2',
          timestamp: '2026-08-09T00:00:01.000Z',
          clientId: 'client-g',
          tenantId: 'globex',
          principalId: 'g',
          connectionId: 'billing',
          registryRevision: 1,
          action: 'call_operation',
          outcome: 'success',
        },
      ],
      { tenantId: 'acme' },
    );
    expect(summary.totals.events).toBe(1);
    expect(summary.byConnection).toHaveLength(1);
    expect(summary.byConnection[0]).toMatchObject({
      tenantId: 'acme',
      id: 'billing',
      events: 1,
    });
  });
});

interface ExecutorEnv {
  executor: OperationExecutor;
  principal: PorticoPrincipal;
  session: SessionState;
  snapshot: ReturnType<typeof snapshotFromDocument>;
  catalog: ReturnType<typeof compileCatalog>['catalog'];
  audit: MemoryAuditLog;
  close(): Promise<void>;
}

const openServers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (openServers.length > 0) {
    const close = openServers.pop();
    if (close !== undefined) await close();
  }
});

async function executorEnv(): Promise<ExecutorEnv> {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (upstream.address() as AddressInfo).port;
  let closed = false;
  const close = () =>
    new Promise<void>((resolve) => {
      if (closed) {
        resolve();
        return;
      }
      closed = true;
      upstream.close(() => resolve());
    });
  openServers.push(close);

  const model: NormalizedApiModel = {
    api: { id: 'echo', title: 'Echo API', version: '1.0.0' },
    securitySchemes: {},
    operations: [
      {
        operationId: 'echo.get',
        method: 'GET',
        path: '/echo/{id}',
        parameters: [
          {
            in: 'path',
            name: 'id',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'OK',
            contentTypes: ['application/json'],
            schema: { type: 'object' },
          },
        },
      },
    ],
  };
  const { catalog } = compileCatalog(model);
  const document: RegistryDocument = {
    version: 1,
    tenants: [{ id: 'acme', name: 'Acme' }],
    principals: [
      { id: 'automation', tenantId: 'acme', allowedConnectionIds: ['conn'] },
    ],
    backends: [
      {
        id: 'echo',
        title: 'Echo API',
        scope: 'global',
        catalogRef: 'catalog.json',
        catalogChecksum: catalog.checksum,
      },
    ],
    connections: [
      {
        id: 'conn',
        tenantId: 'acme',
        backendId: 'echo',
        baseUrl: `http://127.0.0.1:${port}`,
        network: { allowedProtocols: ['http'], allowLoopback: true },
        auth: { type: 'none' },
      },
    ],
  };
  const snapshot = snapshotFromDocument(document, new Map([['catalog.json', catalog]]));
  const principal: PorticoPrincipal = {
    id: 'automation',
    tenantId: 'acme',
    allowedConnectionIds: ['conn'],
    clientId: 'client-key-1',
  };
  const sessions = new SessionStore();
  const session = sessions.create({ principal, connectionId: 'conn', snapshot });
  const audit = new MemoryAuditLog();
  const executor = createOperationExecutor({
    limits: new LimitsStore(),
    audit,
    caches: new CacheStore(),
    circuitBreakers: new CircuitBreakerStore(),
    health: new HealthStore(),
  });
  return {
    executor,
    principal,
    session,
    snapshot,
    catalog,
    audit,
    close,
  };
}

function expectToThrow(fn: () => unknown): PorticoError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PorticoError);
    if (error instanceof PorticoError) return error;
  }
  throw new Error('expected a PorticoError');
}
