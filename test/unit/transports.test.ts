import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { PorticoError } from '../../src/shared/errors';
import {
  dispatchUpstream,
  encodeRequestBody,
  type DispatchResult,
} from '../../src/runtime/transports';

const servers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const close = servers.pop();
    if (close !== undefined) await close();
  }
});

async function startEchoServer(): Promise<{ port: number }> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ url: req.url }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  servers.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  return { port: address.port };
}

describe('encodeRequestBody bounds', () => {
  it('rejects JSON bodies above the byte budget', () => {
    expect(() =>
      encodeRequestBody('json', { message: 'hello world' }, { maxBytes: 8 }),
    ).toThrow(PorticoError);
    expect(() =>
      encodeRequestBody('json', { message: 'hello' }, { maxBytes: 8 }),
    ).toThrow(PorticoError);
  });

  it('rejects text and form bodies above the byte budget', () => {
    expect(() => encodeRequestBody('text', 'a'.repeat(100), { maxBytes: 16 })).toThrow(
      PorticoError,
    );
    expect(() =>
      encodeRequestBody(
        'form',
        { name: 'alice', note: 'x'.repeat(100) },
        { maxBytes: 16 },
      ),
    ).toThrow(PorticoError);
  });

  it('bounds binary bodies before decoding base64', () => {
    const payload = Buffer.from('0123456789').toString('base64');
    expect(() => encodeRequestBody('binary', payload, { maxBytes: 8 })).toThrow(
      PorticoError,
    );
    const encoded = encodeRequestBody('binary', payload, { maxBytes: 16 });
    expect(encoded.body?.toString()).toBe('0123456789');
  });

  it('bounds multipart bodies across text and binary parts', () => {
    expect(() =>
      encodeRequestBody(
        'multipart',
        { file: { base64: Buffer.from('file-bytes').toString('base64') } },
        { maxBytes: 8 },
      ),
    ).toThrow(PorticoError);
    expect(() =>
      encodeRequestBody(
        'multipart',
        { note: 'hello world', file: { base64: 'AAECAw==' } },
        { maxBytes: 8 },
      ),
    ).toThrow(PorticoError);
  });
});

describe('dispatchUpstream redaction', () => {
  it('redacts secret query parameter values from the final URL', async () => {
    const { port } = await startEchoServer();
    const url = new URL(`http://127.0.0.1:${port}/probe?api_key=super-secret`);
    const result: DispatchResult = await dispatchUpstream(
      url,
      { method: 'GET', redactQueryParams: ['api_key'] },
      {
        timeoutMs: 2000,
        maxResponseBytes: 1024,
        network: { allowedProtocols: ['http'], allowLoopback: true },
      },
    );
    expect(result.status).toBe(200);
    expect(result.finalUrl).not.toContain('super-secret');
    expect(result.finalUrl).toContain('api_key=%3Credacted%3E');
  });
});
