import { describe, expect, it } from 'vitest';

import { canonicalize, checksum } from '../../src/catalog/canonical';

describe('canonical serialization and checksums', () => {
  it('sorts object keys recursively for stable output', () => {
    const a = { b: 1, a: { d: 4, c: 3 }, list: [2, 1] };
    const b = { list: [2, 1], a: { c: 3, d: 4 }, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"a":{"c":3,"d":4},"b":1,"list":[2,1]}');
  });

  it('drops undefined values and preserves array order', () => {
    expect(canonicalize({ a: undefined, b: 'x', list: [1, 2] })).toBe(
      '{"b":"x","list":[1,2]}',
    );
  });

  it('produces stable sha256 checksums', () => {
    const value = { operations: { a: { risk: 'read' } } };
    const first = checksum(value);
    const second = checksum({ operations: { a: { risk: 'read' } } });
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first).toBe(second);
    expect(checksum({ operations: { a: { risk: 'write' } } })).not.toBe(first);
  });

  it('supports excluding volatile keys by path', () => {
    const a = {
      checksum: 'x',
      provenance: { generatedAt: '2026-01-01' },
      api: { id: 'a' },
    };
    const b = {
      checksum: 'y',
      provenance: { generatedAt: '2026-02-02' },
      api: { id: 'a' },
    };
    const exclude = (key: string, path: string): boolean =>
      key === 'checksum' || path === 'provenance.generatedAt';
    expect(canonicalize(a, exclude)).toBe(canonicalize(b, exclude));
  });
});
