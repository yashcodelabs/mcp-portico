import { describe, expect, it, vi } from 'vitest';

import {
  defaultUpstreamAuthRegistry,
  UpstreamAuthRegistry,
} from '../../src/auth/upstream';
import type { SecretResolver, UpstreamRequest } from '../../src/auth/types';
import { PorticoError } from '../../src/shared/errors';
import type { ConnectionAuthConfig } from '../../src/registry/types';

const resolver: SecretResolver = {
  async resolve(reference) {
    const table: Record<string, string> = {
      'env:TOKEN': 'secret-token',
      'env:KEY': 'secret-key',
      'env:USER': 'alice',
      'env:PASS': 's3cret',
    };
    return table[reference];
  },
};

async function apply(
  config: ConnectionAuthConfig,
  secretResolver: SecretResolver = resolver,
): Promise<{
  headers: Map<string, string>;
  query: Map<string, string>;
  secretQueryParams: Set<string>;
}> {
  const request: UpstreamRequest = {
    url: new URL('https://example.com/resource'),
    headers: new Map(),
    query: new Map(),
    secretQueryParams: new Set(),
  };
  const auth = defaultUpstreamAuthRegistry.toConnectionAuth(config);
  const provider = defaultUpstreamAuthRegistry.get(config.type);
  await provider.validate(auth);
  await provider.apply(request, auth, secretResolver);
  return {
    headers: request.headers,
    query: request.query,
    secretQueryParams: request.secretQueryParams ?? new Set(),
  };
}

describe('upstream auth providers', () => {
  it('covers all five v1 provider types', () => {
    const registry = new UpstreamAuthRegistry();
    for (const type of ['none', 'bearer', 'apiKey', 'basic', 'staticHeaders']) {
      expect(registry.get(type as ConnectionAuthConfig['type']).type).toBe(type);
    }
    expect(() => registry.get('oauth2' as ConnectionAuthConfig['type'])).toThrow(
      PorticoError,
    );
  });

  it('none injects nothing', async () => {
    const { headers, query } = await apply({ type: 'none' });
    expect(headers.size).toBe(0);
    expect(query.size).toBe(0);
  });

  it('bearer injects an Authorization header', async () => {
    const { headers } = await apply({ type: 'bearer', tokenRef: 'env:TOKEN' });
    expect(headers.get('authorization')).toBe('Bearer secret-token');
  });

  it('apiKey injects a header or query parameter', async () => {
    const header = await apply({
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
      valueRef: 'env:KEY',
    });
    expect(header.headers.get('x-api-key')).toBe('secret-key');

    const query = await apply({
      type: 'apiKey',
      in: 'query',
      name: 'api_key',
      valueRef: 'env:KEY',
    });
    expect(query.query.get('api_key')).toBe('secret-key');
  });

  it('basic injects a base64 Basic Authorization header', async () => {
    const { headers } = await apply({
      type: 'basic',
      usernameRef: 'env:USER',
      passwordRef: 'env:PASS',
    });
    const expected = Buffer.from('alice:s3cret', 'utf8').toString('base64');
    expect(headers.get('authorization')).toBe(`Basic ${expected}`);
  });

  it('staticHeaders injects literals and resolved references', async () => {
    const { headers } = await apply({
      type: 'staticHeaders',
      headers: {
        'x-tenant': 'acme',
        'x-token': 'env:TOKEN',
      },
    });
    expect(headers.get('x-tenant')).toBe('acme');
    expect(headers.get('x-token')).toBe('secret-token');
  });

  it('skips injection when a reference cannot be resolved', async () => {
    const empty: SecretResolver = {
      async resolve() {
        return undefined;
      },
    };
    const { headers, query } = await apply(
      { type: 'bearer', tokenRef: 'env:MISSING' },
      empty,
    );
    expect(headers.has('authorization')).toBe(false);
    expect(query.size).toBe(0);
  });

  it('validates provider configuration', async () => {
    await expect(
      apply({
        type: 'apiKey',
        in: 'cookie',
        name: 'x',
        valueRef: 'env:KEY',
      } as unknown as ConnectionAuthConfig),
    ).rejects.toThrow(PorticoError);
    await expect(apply({ type: 'bearer', tokenRef: 'literal' })).rejects.toThrow(
      PorticoError,
    );
    await expect(
      apply({ type: 'staticHeaders', headers: {} } as ConnectionAuthConfig),
    ).resolves.toBeDefined();
  });

  it('never logs credentials while injecting them', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { headers } = await apply({
        type: 'basic',
        usernameRef: 'env:USER',
        passwordRef: 'env:PASS',
      });
      const basic = headers.get('authorization') ?? '';
      const decoded = Buffer.from(basic.replace(/^Basic /, ''), 'base64').toString(
        'utf8',
      );
      expect(decoded).toBe('alice:s3cret');
      const bearer = await apply({ type: 'bearer', tokenRef: 'env:TOKEN' });
      expect(bearer.headers.get('authorization')).toBe('Bearer secret-token');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('tracks query-injected API key names as secret query parameters', async () => {
    const { secretQueryParams } = await apply({
      type: 'apiKey',
      in: 'query',
      name: 'api_key',
      valueRef: 'env:KEY',
    });
    expect(secretQueryParams.has('api_key')).toBe(true);
  });

  it('refuses to inject protected headers through apiKey auth', async () => {
    for (const name of ['host', 'transfer-encoding', 'x-mcp-portico-tenant']) {
      await expect(
        apply({
          type: 'apiKey',
          in: 'header',
          name,
          valueRef: 'env:KEY',
        }),
      ).rejects.toThrow(PorticoError);
    }
  });

  it('refuses to inject protected headers through staticHeaders auth', async () => {
    for (const name of ['host', 'authorization', 'connection', 'x-mcp-portico']) {
      await expect(
        apply({
          type: 'staticHeaders',
          headers: { [name]: 'value' },
        }),
      ).rejects.toThrow(PorticoError);
    }
  });
});
