import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { assertServeAuthAllowed, type AuthMode } from '../auth/binding';
import {
  assertSecretsResolvable,
  collectConnectionSecretRefs,
  defaultSecretResolver,
} from '../auth/secrets';
import type { IdentityProvider } from '../auth/types';
import { defaultUpstreamAuthRegistry } from '../auth/upstream';
import { MemoryAuditLog, type AuditLog } from '../audit/log';
import { StaticBearerIdentityProvider } from '../identity/static-bearer';
import { Inspector } from '../inspector/server';
import { LimitsStore } from '../limits/store';
import { McpServer } from '../mcp/server';
import type { Connection } from '../registry/types';
import {
  buildRegistrySnapshot,
  RuntimeRegistry,
  type RegistrySnapshot,
} from '../registry/snapshot';
import { assertDestinationDnsAllowed } from '../security/network';
import { CacheStore } from '../runtime/cache';
import { CircuitBreakerStore } from '../runtime/circuit';
import { createOperationExecutor } from '../runtime/executor';
import { HealthStore } from '../runtime/health';
import { TenantRuntime } from '../runtime/tenant';
import { SessionStore } from '../session/store';
import { envName, PACKAGE_NAME, PRODUCT_VERSION } from '../shared/brand';
import { PorticoError } from '../shared/errors';

export interface ServeOptions {
  host: string;
  port: number;
  authMode: AuthMode;
  /** Registry file to load and validate at startup (Phase 3). */
  registryPath?: string;
}

export interface ServerContext {
  registry?: RuntimeRegistry;
  snapshot?: RegistrySnapshot;
  identityProvider?: IdentityProvider;
  runtime?: TenantRuntime;
  mcpServer?: McpServer;
  inspector?: Inspector;
  sessions: SessionStore;
  limits: LimitsStore;
  audit: AuditLog;
}

const MAX_MCP_BODY_BYTES = 10 * 1024 * 1024;

/** Validate a connection's upstream auth configuration at load/reload time. */
async function assertUpstreamAuthValid(connection: Connection): Promise<void> {
  const auth = defaultUpstreamAuthRegistry.toConnectionAuth(connection.auth);
  const provider = defaultUpstreamAuthRegistry.get(connection.auth.type);
  await provider.validate(auth);
}

export interface RunningServer {
  host: string;
  port: number;
  close(): Promise<void>;
  context: ServerContext;
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

/** Read a request body up to `limit` bytes; rejects when the limit is exceeded. */
function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received <= limit) chunks.push(chunk);
    });
    req.on('end', () => {
      if (received > limit) {
        reject(
          new PorticoError('USAGE', `Request body exceeds the ${limit} byte limit.`),
        );
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

export async function startServer(options: ServeOptions): Promise<RunningServer> {
  assertServeAuthAllowed({
    host: options.host,
    authMode: options.authMode,
    registryConfigured: options.registryPath !== undefined,
  });

  const sessions = new SessionStore();
  const limits = new LimitsStore();
  const audit = new MemoryAuditLog();
  let registry: RuntimeRegistry | undefined;
  let snapshot: RegistrySnapshot | undefined;
  let identityProvider: IdentityProvider | undefined;
  let runtime: TenantRuntime | undefined;

  if (options.registryPath !== undefined) {
    registry = new RuntimeRegistry(options.registryPath);
    snapshot = registry.publish();
    for (const connection of snapshot.document.connections) {
      await assertSecretsResolvable(
        collectConnectionSecretRefs(connection),
        defaultSecretResolver,
      );
      await assertUpstreamAuthValid(connection);
      await assertDestinationDnsAllowed(
        new URL(connection.baseUrl),
        connection.network ?? {},
        { context: 'load' },
      );
    }
    if (options.authMode === 'bearer') {
      const pepper = process.env[envName('KEY_PEPPER')] ?? '';
      identityProvider = new StaticBearerIdentityProvider(snapshot, pepper);
      await identityProvider.validate();
    }
    const caches = new CacheStore();
    const circuitBreakers = new CircuitBreakerStore();
    const health = new HealthStore();
    runtime = new TenantRuntime({
      snapshot,
      identityProvider,
      sessions,
      limits,
      audit,
      caches,
      circuitBreakers,
      health,
      executor: createOperationExecutor({
        limits,
        audit,
        caches,
        circuitBreakers,
        health,
      }),
    });
    registry.subscribe((next) => {
      runtime?.updateSnapshot(next);
    });
  } else if (options.authMode === 'bearer') {
    throw new PorticoError(
      'CONFIG_ERROR',
      'Bearer auth mode requires a registry; pass --registry <file>.',
    );
  }

  const mcpServer = new McpServer(runtime);
  const inspector = new Inspector({
    runtime,
    audit,
    authMode: options.authMode,
  });

  const server = http.createServer(async (req, res) => {
    if (req.url !== undefined && req.url.startsWith('/inspector')) {
      const handled = await inspector.handle(req, res);
      if (handled) return;
    }
    if (req.method === 'GET') {
      if (req.url === '/healthz') {
        sendJson(res, 200, {
          name: PACKAGE_NAME,
          version: PRODUCT_VERSION,
          status: 'ok',
          authMode: options.authMode,
          registryRevision: snapshot?.revision,
        });
        return;
      }
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }
    if (req.method === 'POST' && req.url === '/mcp') {
      let bodyText: string;
      try {
        bodyText = await readBody(req, MAX_MCP_BODY_BYTES);
      } catch {
        sendJson(res, 413, {
          error: { code: 'USAGE', message: 'Request body too large.' },
        });
        return;
      }
      try {
        const response = await mcpServer.handleHttp(bodyText, req.headers);
        if (response.body === '') {
          res.writeHead(response.status, {
            'content-type': response.contentType,
          });
          res.end();
          return;
        }
        res.writeHead(response.status, {
          'content-type': response.contentType,
          'content-length': Buffer.byteLength(response.body),
        });
        res.end(response.body);
        return;
      } catch {
        sendJson(res, 500, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: 'Internal error' },
        });
        return;
      }
    }
    sendJson(
      res,
      405,
      { error: { code: 'USAGE', message: 'Method not allowed' } },
      { allow: 'GET, POST' },
    );
  });

  let watcher: fs.FSWatcher | undefined;
  let reloadTimer: NodeJS.Timeout | undefined;
  const registryPath = options.registryPath;
  if (registry !== undefined && runtime !== undefined && registryPath !== undefined) {
    watcher = fs.watch(registryPath, () => {
      if (reloadTimer !== undefined) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        void (async () => {
          try {
            const candidate = buildRegistrySnapshot(registryPath);
            for (const connection of candidate.document.connections) {
              await assertSecretsResolvable(
                collectConnectionSecretRefs(connection),
                defaultSecretResolver,
              );
              await assertUpstreamAuthValid(connection);
              await assertDestinationDnsAllowed(
                new URL(connection.baseUrl),
                connection.network ?? {},
                { context: 'load' },
              );
            }
            if (options.authMode === 'bearer') {
              const pepper = process.env[envName('KEY_PEPPER')] ?? '';
              const candidateProvider = new StaticBearerIdentityProvider(
                candidate,
                pepper,
              );
              await candidateProvider.validate();
            }
            snapshot = registry.publish();
          } catch {
            // Invalid candidate: the previous complete snapshot stays active.
          }
        })();
      }, 150);
    });
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port, options.host);
  });

  const address = server.address() as AddressInfo;
  return {
    host: options.host,
    port: address.port,
    context: {
      registry,
      snapshot,
      identityProvider,
      runtime,
      mcpServer,
      inspector,
      sessions,
      limits,
      audit,
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (reloadTimer !== undefined) clearTimeout(reloadTimer);
        watcher?.close();
        server.close(() => resolve());
      }),
  };
}
