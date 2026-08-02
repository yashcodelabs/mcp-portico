import { afterEach, describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from '../../src/cli/serve';
import { PACKAGE_NAME } from '../../src/shared/brand';
import { PorticoError } from '../../src/shared/errors';

const running: RunningServer[] = [];

afterEach(async () => {
  for (const server of running.splice(0)) {
    await server.close();
  }
});

async function startTestServer(
  options: Partial<{ host: string; port: number; authMode: 'none' | 'bearer' }> = {},
): Promise<RunningServer> {
  const server = await startServer({
    host: options.host ?? '127.0.0.1',
    port: options.port ?? 0,
    authMode: options.authMode ?? 'none',
  });
  running.push(server);
  return server;
}

describe('Phase 1 HTTP server', () => {
  it('serves health information on /healthz', async () => {
    const server = await startTestServer();
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.name).toBe(PACKAGE_NAME);
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
  });

  it('returns 404 for unknown paths', async () => {
    const server = await startTestServer();
    const response = await fetch(`http://127.0.0.1:${server.port}/unknown`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 405 for non-GET methods on /healthz', async () => {
    const server = await startTestServer();
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`, {
      method: 'POST',
    });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
  });

  it('refuses non-loopback binding in unauthenticated mode', async () => {
    const error = await startServer({
      host: '0.0.0.0',
      port: 0,
      authMode: 'none',
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PorticoError);
    expect((error as PorticoError).code).toBe('CONFIG_ERROR');
  });

  it('permits non-loopback binding once an identity mode is configured', async () => {
    const server = await startTestServer({ host: '0.0.0.0', authMode: 'bearer' });
    expect(server.port).toBeGreaterThan(0);
  });
});
