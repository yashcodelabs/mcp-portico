import { describe, expect, it } from 'vitest';

import {
  computeKeyDigest,
  constantTimeEqual,
  generatePorticoKey,
  isValidDigest,
  parsePorticoKey,
} from '../../src/identity/keys';
import { PorticoError } from '../../src/shared/errors';

describe('Portico API key generation', () => {
  it('generates mpp_<keyId>_<secret> tokens with a keyed digest', () => {
    const key = generatePorticoKey('test-pepper');
    expect(key.token).toMatch(/^mpp_[a-f0-9]{16}_[A-Za-z0-9_-]{16,64}$/);
    expect(key.keyId).toHaveLength(16);
    expect(isValidDigest(key.digest)).toBe(true);
  });

  it('derives different digests for the same secret under different peppers', () => {
    const key = generatePorticoKey('pepper-a');
    const other = computeKeyDigest(key.secret, 'pepper-b');
    expect(other).not.toBe(key.digest);
  });

  it('derives a stable digest for the same secret and pepper', () => {
    expect(computeKeyDigest('secret', 'pepper')).toBe(
      computeKeyDigest('secret', 'pepper'),
    );
  });

  it('rejects an empty pepper', () => {
    expect(() => generatePorticoKey('')).toThrow(PorticoError);
  });

  it('parses tokens and rejects malformed ones', () => {
    const key = generatePorticoKey('pepper');
    expect(parsePorticoKey(key.token)).toEqual({
      keyId: key.keyId,
      secret: key.secret,
    });
    for (const token of [
      '',
      'mpp_',
      'mpp_short_secret',
      'random-string',
      'mpp_abcdef_1234567890abcdef_',
    ]) {
      expect(parsePorticoKey(token), token).toBeUndefined();
    }
  });
});

describe('constant-time digest comparison', () => {
  it('matches equal digests', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
  });

  it('rejects unequal digests of equal length', () => {
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
  });

  it('rejects digests of different lengths', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});
