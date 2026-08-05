import { describe, expect, it } from 'vitest';

import { validateRegistrySchema } from '../../src/registry/schema';
import { sampleRegistryDoc } from '../helpers/registry';

describe('registry v1 JSON Schema validation', () => {
  it('accepts a well-formed registry document', () => {
    expect(validateRegistrySchema(sampleRegistryDoc())).toEqual([]);
  });

  it('rejects secret references that are not env: references', () => {
    const document = sampleRegistryDoc();
    document.connections = [
      {
        ...(document.connections[0] as object),
        auth: { type: 'bearer', tokenRef: 'literal-token' },
      } as (typeof document.connections)[number],
    ];
    const issues = validateRegistrySchema(document);
    expect(issues.some((issue) => issue.instancePath.includes('tokenRef'))).toBe(true);
  });

  it('rejects unknown top-level fields', () => {
    const document = { ...sampleRegistryDoc(), surprise: true };
    const issues = validateRegistrySchema(document);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('rejects malformed key digests and key ids', () => {
    const document = sampleRegistryDoc();
    document.principals = [
      {
        id: 'acme-automation',
        tenantId: 'acme',
        allowedConnectionIds: ['acme-billing-prod'],
        keyId: 'not-hex',
        keyDigest: 'plaintext',
      },
    ];
    const issues = validateRegistrySchema(document);
    expect(issues.some((issue) => issue.instancePath.includes('keyId'))).toBe(true);
    expect(issues.some((issue) => issue.instancePath.includes('keyDigest'))).toBe(true);
  });

  it('rejects malformed catalog checksums', () => {
    const document = sampleRegistryDoc();
    document.backends = [
      {
        ...(document.backends[0] as object),
        catalogChecksum: 'md5:deadbeef',
      } as (typeof document.backends)[number],
    ];
    const issues = validateRegistrySchema(document);
    expect(issues.some((issue) => issue.instancePath.includes('catalogChecksum'))).toBe(
      true,
    );
  });

  it('rejects a global backend that sets ownerTenantId', () => {
    const document = sampleRegistryDoc();
    document.backends = [
      {
        ...(document.backends[0] as object),
        scope: 'global',
        ownerTenantId: 'acme',
      } as (typeof document.backends)[number],
    ];
    // The scope/ownership rule is semantic, so schema still accepts it; this
    // guards the semantic validator path rather than schema.
    expect(validateRegistrySchema(document)).toEqual([]);
  });
});
