import { afterEach, describe, expect, it } from 'vitest';

import {
  assertSecretsResolvable,
  collectConnectionSecretRefs,
  EnvSecretResolver,
  isSecretReference,
  resolveSecretOrLiteral,
} from '../../src/auth/secrets';
import { PorticoError } from '../../src/shared/errors';
import type { Connection } from '../../src/registry/types';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('environment secret resolver', () => {
  it('resolves env references and returns undefined for others', async () => {
    process.env.PORTICO_TEST_SECRET = 'hunter2';
    const resolver = new EnvSecretResolver();
    await expect(resolver.resolve('env:PORTICO_TEST_SECRET')).resolves.toBe('hunter2');
    await expect(resolver.resolve('env:MISSING_VAR')).resolves.toBeUndefined();
    await expect(resolver.resolve('plain-value')).resolves.toBeUndefined();
  });

  it('recognizes valid reference shapes', () => {
    expect(isSecretReference('env:FOO_BAR')).toBe(true);
    expect(isSecretReference('env:foo')).toBe(true);
    expect(isSecretReference('env:9BAD')).toBe(false);
    expect(isSecretReference('literal')).toBe(false);
    expect(isSecretReference('env:')).toBe(false);
  });

  it('collects every reference used by a connection', () => {
    const connection: Connection = {
      id: 'c1',
      tenantId: 'acme',
      backendId: 'billing',
      baseUrl: 'https://example.com',
      auth: {
        type: 'staticHeaders',
        headers: {
          'x-tenant': 'acme',
          'x-token': 'env:ACME_TOKEN',
        },
      },
      staticHeaders: { 'x-extra': 'env:ACME_EXTRA' },
    };
    expect(collectConnectionSecretRefs(connection).sort()).toEqual([
      'env:ACME_EXTRA',
      'env:ACME_TOKEN',
    ]);
  });

  it('fails activation when references cannot be resolved', async () => {
    process.env.PRESENT_VAR = 'value';
    await expect(
      assertSecretsResolvable(['env:PRESENT_VAR'], new EnvSecretResolver()),
    ).resolves.toBeUndefined();
    await expect(
      assertSecretsResolvable(
        ['env:PRESENT_VAR', 'env:ABSENT_VAR'],
        new EnvSecretResolver(),
      ),
    ).rejects.toThrow(PorticoError);
  });

  it('passes literals through and resolves references', async () => {
    process.env.PORTICO_REF = 'resolved';
    const resolver = new EnvSecretResolver();
    await expect(resolveSecretOrLiteral('literal', resolver)).resolves.toBe('literal');
    await expect(resolveSecretOrLiteral('env:PORTICO_REF', resolver)).resolves.toBe(
      'resolved',
    );
  });
});
