import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { assertLoopbackBindingAllowed, type AuthMode } from '../auth/binding';
import {
  assertSecretsResolvable,
  collectConnectionSecretRefs,
  defaultSecretResolver,
} from '../auth/secrets';
import type { IdentityProvider } from '../auth/types';
import { MemoryAuditLog, type AuditLog } from '../audit/log';
import { StaticBearerIdentityProvider } from '../identity/static-bearer';
import { LimitsStore } from '../limits/store';
import { RuntimeRegistry, type RegistrySnapshot } from '../registry/snapshot';
import { assertDestinationDnsAllowed } from '../security/network';
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
  sessions: SessionStore;
  limits: LimitsStore;
  audit: AuditLog;
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

export async function startServer(options: ServeOptions): Promise<RunningServer> {
  assertLoopbackBindingAllowed({ host: options.host, authMode: options.authMode });

  const sessions = new SessionStore();
  const limits = new LimitsStore();
  const audit = new MemoryAuditLog();
  let registry: RuntimeRegistry | undefined;
  let snapshot: RegistrySnapshot | undefined;
  let identityProvider: IdentityProvider | undefined;

  if (options.registryPath !== undefined) {
    registry = new RuntimeRegistry(options.registryPath);
    snapshot = registry.publish();
    for (const connection of snapshot.document.connections) {
      await assertSecretsResolvable(
        collectConnectionSecretRefs(connection),
        defaultSecretResolver,
      );
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
  } else if (options.authMode === 'bearer') {
    throw new PorticoError(
      'CONFIG_ERROR',
      'Bearer auth mode requires a registry; pass --registry <file>.',
    );
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      sendJson(
        res,
        405,
        { error: { code: 'USAGE', message: 'Method not allowed' } },
        { allow: 'GET' },
      );
      return;
    }
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
  });

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
      sessions,
      limits,
      audit,
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
