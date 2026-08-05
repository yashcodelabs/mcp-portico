import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { buildRegistrySnapshot, RuntimeRegistry } from '../../src/registry/snapshot';
import { writeRegistryFile } from '../../src/registry/load';
import type { RegistryDocument } from '../../src/registry/types';

const REAL_CHECKSUM =
  'sha256:6d58295e29802224dad1624bb8b4c1e22c45433d32f91c69216c76ff5d87ed0d';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'portico-snapshot-test-'));

afterAll(() => {
  fs.rmSync(temporary, { recursive: true, force: true });
});

function copySampleCatalog(name: string): string {
  const source = path.join(
    __dirname,
    '..',
    'fixtures',
    'catalog',
    'sample-catalog.json',
  );
  const target = path.join(temporary, name);
  fs.copyFileSync(source, target);
  return target;
}

function registryDoc(catalogRefs: string[]): RegistryDocument {
  return {
    version: 1,
    tenants: [{ id: 'acme', name: 'Acme' }],
    principals: [],
    backends: catalogRefs.map((catalogRef, index) => ({
      id: `backend-${index}`,
      title: `Backend ${index}`,
      scope: 'global' as const,
      catalogRef,
      catalogChecksum: REAL_CHECKSUM,
    })),
    connections: [],
  };
}

describe('registry snapshot building', () => {
  it('deduplicates identical catalog checksums across refs', () => {
    const first = copySampleCatalog('cat-a.json');
    const second = copySampleCatalog('cat-b.json');
    const registryFile = path.join(temporary, 'dedupe.json');
    writeRegistryFile(registryFile, registryDoc([first, second]), 'json');
    const snapshot = buildRegistrySnapshot(registryFile);
    expect(snapshot.catalogsByRef.size).toBe(2);
    expect(snapshot.catalogsByChecksum.size).toBe(1);
    expect(snapshot.catalogForBackend('backend-0')).toBe(
      snapshot.catalogForBackend('backend-1'),
    );
  });

  it('fails closed when a referenced catalog is missing', () => {
    const registryFile = path.join(temporary, 'missing-catalog.json');
    writeRegistryFile(
      registryFile,
      registryDoc([path.join(temporary, 'does-not-exist.json')]),
      'json',
    );
    expect(() => buildRegistrySnapshot(registryFile)).toThrow();
  });
});

describe('RuntimeRegistry atomic publication', () => {
  it('keeps the previous snapshot when a candidate is invalid', () => {
    const catalog = copySampleCatalog('publish-cat.json');
    const registryFile = path.join(temporary, 'publish.json');
    writeRegistryFile(registryFile, registryDoc([catalog]), 'json');

    const runtime = new RuntimeRegistry(registryFile);
    const first = runtime.publish();
    expect(first.revision).toBe(1);

    const invalid = registryDoc([catalog]);
    invalid.tenants = [
      { id: 'acme', name: 'Acme' },
      { id: 'acme', name: 'Duplicate' },
    ];
    writeRegistryFile(registryFile, invalid, 'json');
    expect(() => runtime.publish()).toThrow();
    expect(runtime.getSnapshot()?.revision).toBe(1);

    writeRegistryFile(registryFile, registryDoc([catalog]), 'json');
    const second = runtime.publish();
    expect(second.revision).toBe(2);
  });
});
