import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  FileRegistryStore,
  loadRegistryFile,
  serializeRegistryDocument,
  writeRegistryFile,
} from '../../src/registry/load';
import { PorticoError } from '../../src/shared/errors';
import { sampleRegistryDoc } from '../helpers/registry';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'portico-registry-test-'));

afterAll(() => {
  fs.rmSync(temporary, { recursive: true, force: true });
});

describe('registry file loading', () => {
  it('loads and validates a JSON registry', () => {
    const file = path.join(temporary, 'registry.json');
    fs.writeFileSync(file, JSON.stringify(sampleRegistryDoc()), 'utf8');
    const loaded = loadRegistryFile(file);
    expect(loaded.format).toBe('json');
    expect(loaded.document.tenants).toHaveLength(2);
  });

  it('loads a YAML registry', () => {
    const file = path.join(temporary, 'registry.yaml');
    fs.writeFileSync(
      file,
      [
        'version: 1',
        'tenants:',
        '  - id: acme',
        '    name: Acme',
        'principals: []',
        'backends: []',
        'connections: []',
        '',
      ].join('\n'),
      'utf8',
    );
    const loaded = loadRegistryFile(file);
    expect(loaded.format).toBe('yaml');
    expect(loaded.document.tenants[0]?.id).toBe('acme');
  });

  it('falls back to YAML for unknown extensions', () => {
    const file = path.join(temporary, 'registry.conf');
    fs.writeFileSync(
      file,
      'version: 1\ntenants: []\nprincipals: []\nbackends: []\nconnections: []\n',
      'utf8',
    );
    expect(loadRegistryFile(file).format).toBe('yaml');
  });

  it('rejects a missing file with NOT_FOUND', () => {
    expect(() => loadRegistryFile(path.join(temporary, 'nope.json'))).toThrow(
      PorticoError,
    );
  });

  it('rejects invalid YAML with CONFIG_ERROR', () => {
    const file = path.join(temporary, 'broken.yaml');
    fs.writeFileSync(file, 'version: [unclosed', 'utf8');
    let thrown: unknown;
    try {
      loadRegistryFile(file);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PorticoError);
    expect((thrown as PorticoError).code).toBe('CONFIG_ERROR');
  });

  it('rejects documents that fail the registry schema', () => {
    const file = path.join(temporary, 'bad.json');
    fs.writeFileSync(file, JSON.stringify({ version: 99 }), 'utf8');
    let thrown: unknown;
    try {
      loadRegistryFile(file);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PorticoError);
    const details = (thrown as PorticoError).details as {
      schemaIssues: Array<{ instancePath: string }>;
    };
    expect(details.schemaIssues.length).toBeGreaterThan(0);
  });

  it('round-trips JSON and YAML through writeRegistryFile', () => {
    const jsonFile = path.join(temporary, 'roundtrip.json');
    writeRegistryFile(jsonFile, sampleRegistryDoc(), 'json');
    expect(loadRegistryFile(jsonFile).document).toEqual(sampleRegistryDoc());

    const yamlFile = path.join(temporary, 'roundtrip.yaml');
    writeRegistryFile(yamlFile, sampleRegistryDoc(), 'yaml');
    expect(loadRegistryFile(yamlFile).document).toEqual(sampleRegistryDoc());
  });

  it('serializes with a trailing newline', () => {
    expect(serializeRegistryDocument(sampleRegistryDoc(), 'json').endsWith('\n')).toBe(
      true,
    );
  });

  it('exposes a RegistryStore over a file', async () => {
    const file = path.join(temporary, 'store.json');
    writeRegistryFile(file, sampleRegistryDoc(), 'json');
    const store = new FileRegistryStore(file);
    await expect(store.load()).resolves.toEqual(sampleRegistryDoc());
  });
});
