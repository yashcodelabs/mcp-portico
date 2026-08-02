import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { assertLoopbackBindingAllowed, type AuthMode } from '../auth/binding';
import { PACKAGE_NAME, PRODUCT_VERSION } from '../shared/brand';

export interface ServeOptions {
  host: string;
  port: number;
  authMode: AuthMode;
}

export interface RunningServer {
  host: string;
  port: number;
  close(): Promise<void>;
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
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
