import { describe, expect, it } from 'vitest';

import {
  assertStaticHeadersSafe,
  isProtectedUpstreamHeaderName,
  redactUrlQuerySecrets,
  sanitizeUpstreamHeaders,
} from '../../src/security/headers';

describe('upstream header hygiene', () => {
  it('strips hop-by-hop and framing headers', () => {
    const headers = new Map<string, string>([
      ['connection', 'keep-alive'],
      ['keep-alive', 'timeout=5'],
      ['transfer-encoding', 'chunked'],
      ['upgrade', 'h2c'],
      ['host', 'original.example'],
      ['content-length', '42'],
    ]);
    sanitizeUpstreamHeaders(headers);
    expect(headers.size).toBe(0);
  });

  it('strips authorization and MCP Portico client headers', () => {
    const headers = new Map<string, string>([
      ['authorization', 'Bearer client-credential'],
      ['x-mcp-portico-tenant', 'acme'],
      ['x-mcp-portico', 'debug'],
      ['x-custom', 'kept'],
    ]);
    sanitizeUpstreamHeaders(headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('x-mcp-portico-tenant')).toBe(false);
    expect(headers.has('x-mcp-portico')).toBe(false);
    expect(headers.get('x-custom')).toBe('kept');
  });

  it('flags reserved and Portico-prefixed static headers', () => {
    expect(
      assertStaticHeadersSafe({
        host: 'evil.example',
        authorization: 'Bearer x',
        'content-length': '10',
        'x-mcp-portico-tenant': 'acme',
        'x-ok': 'fine',
      }),
    ).toHaveLength(4);
    expect(assertStaticHeadersSafe({ 'x-ok': 'fine' })).toEqual([]);
    expect(assertStaticHeadersSafe(undefined)).toEqual([]);
  });

  it('classifies protected header names', () => {
    expect(isProtectedUpstreamHeaderName('Host')).toBe(true);
    expect(isProtectedUpstreamHeaderName('transfer-encoding')).toBe(true);
    expect(isProtectedUpstreamHeaderName('content-length')).toBe(true);
    expect(isProtectedUpstreamHeaderName('x-mcp-portico-tenant')).toBe(true);
    expect(isProtectedUpstreamHeaderName('x-mcp-portico')).toBe(true);
    expect(isProtectedUpstreamHeaderName('X-Custom')).toBe(false);
  });

  it('keeps explicitly allowed credential headers during sanitization', () => {
    const headers = new Map<string, string>([
      ['authorization', 'Bearer token'],
      ['host', 'evil.example'],
      ['x-custom', 'kept'],
    ]);
    sanitizeUpstreamHeaders(headers, { allow: ['authorization'] });
    expect(headers.get('authorization')).toBe('Bearer token');
    expect(headers.has('host')).toBe(false);
    expect(headers.get('x-custom')).toBe('kept');
  });

  it('redacts secret query parameter values from rendered URLs', () => {
    const url = new URL('https://example.com/path?api_key=super-secret&keep=1');
    expect(redactUrlQuerySecrets(url, ['api_key'])).toBe(
      'https://example.com/path?api_key=%3Credacted%3E&keep=1',
    );
    expect(redactUrlQuerySecrets(url, ['absent'])).toBe(url.toString());
  });
});
