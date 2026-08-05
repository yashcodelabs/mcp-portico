import { describe, expect, it } from 'vitest';

import { generatePorticoKey } from '../../src/identity/keys';
import { StaticBearerIdentityProvider } from '../../src/identity/static-bearer';
import { snapshotFromDocument } from '../../src/registry/snapshot';
import type { RegistryDocument } from '../../src/registry/types';
import { PorticoError } from '../../src/shared/errors';
import {
  sampleCatalog,
  sampleRegistryDoc,
  TEST_CATALOG_REF,
} from '../helpers/registry';

const PEPPER = 'test-pepper';

function keyedDocument(overrides: Partial<RegistryDocument> = {}): RegistryDocument {
  const document = sampleRegistryDoc();
  const key = generatePorticoKey(PEPPER);
  document.principals = [
    {
      id: 'acme-automation',
      tenantId: 'acme',
      allowedConnectionIds: ['acme-billing-prod'],
      keyId: key.keyId,
      keyDigest: key.digest,
    },
  ];
  return { ...document, ...overrides };
}

function providerFor(document: RegistryDocument): StaticBearerIdentityProvider {
  const snapshot = snapshotFromDocument(
    document,
    new Map([[TEST_CATALOG_REF, sampleCatalog()]]),
  );
  return new StaticBearerIdentityProvider(snapshot, PEPPER);
}

describe('StaticBearerIdentityProvider', () => {
  it('authenticates a valid key and resolves the authorized principal', async () => {
    const document = keyedDocument();
    const key = generatePorticoKey(PEPPER);
    document.principals[0]!.keyId = key.keyId;
    document.principals[0]!.keyDigest = key.digest;
    const provider = providerFor(document);
    await expect(provider.validate()).resolves.toBeUndefined();
    const result = await provider.authenticate(key.token);
    expect(result?.authMethod).toBe('static-bearer');
    expect(result?.principal).toMatchObject({
      id: 'acme-automation',
      tenantId: 'acme',
      allowedConnectionIds: ['acme-billing-prod'],
    });
  });

  it('rejects wrong secrets, unknown key ids, and malformed tokens', async () => {
    const document = keyedDocument();
    const key = generatePorticoKey(PEPPER);
    document.principals[0]!.keyId = key.keyId;
    document.principals[0]!.keyDigest = key.digest;
    const provider = providerFor(document);

    const wrongSecret = `mpp_${key.keyId}_${'x'.repeat(32)}`;
    await expect(provider.authenticate(wrongSecret)).resolves.toBeUndefined();
    await expect(
      provider.authenticate(`mpp_${'f'.repeat(16)}_${'y'.repeat(32)}`),
    ).resolves.toBeUndefined();
    await expect(provider.authenticate('not-a-key')).resolves.toBeUndefined();
  });

  it('rejects a key derived under a different pepper', async () => {
    const document = keyedDocument();
    const key = generatePorticoKey('other-pepper');
    document.principals[0]!.keyId = key.keyId;
    document.principals[0]!.keyDigest = key.digest;
    const provider = providerFor(document);
    await expect(provider.authenticate(key.token)).resolves.toBeUndefined();
  });

  it('fails validation without a pepper', async () => {
    const document = keyedDocument();
    const snapshot = snapshotFromDocument(
      document,
      new Map([[TEST_CATALOG_REF, sampleCatalog()]]),
    );
    const provider = new StaticBearerIdentityProvider(snapshot, '');
    await expect(provider.validate()).rejects.toThrow(PorticoError);
  });

  it('fails validation when a principal has no key', async () => {
    const provider = providerFor(sampleRegistryDoc());
    await expect(provider.validate()).rejects.toThrow(PorticoError);
  });

  it('fails validation on duplicate key ids', async () => {
    const document = keyedDocument();
    const key = generatePorticoKey(PEPPER);
    document.principals = [
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
        allowedConnectionIds: ['globex-billing-prod'],
        keyId: key.keyId,
        keyDigest: key.digest,
      },
    ];
    await expect(providerFor(document).validate()).rejects.toThrow(PorticoError);
  });

  it('returns only connections the snapshot authorizes for the principal', async () => {
    const document = keyedDocument();
    const key = generatePorticoKey(PEPPER);
    document.principals[0]!.keyId = key.keyId;
    document.principals[0]!.keyDigest = key.digest;
    const provider = providerFor(document);
    const result = await provider.authenticate(key.token);
    expect(result?.principal.allowedConnectionIds).toEqual(['acme-billing-prod']);
  });

  it('defends against cross-tenant connection selection at the snapshot level', () => {
    const snapshot = snapshotFromDocument(
      keyedDocument(),
      new Map([[TEST_CATALOG_REF, sampleCatalog()]]),
    );
    const foreignPrincipal = {
      id: 'globex-automation',
      tenantId: 'globex',
      allowedConnectionIds: ['acme-billing-prod'],
    };
    expect(snapshot.authorizeConnection(foreignPrincipal, 'acme-billing-prod')).toBe(
      undefined,
    );
  });
});
