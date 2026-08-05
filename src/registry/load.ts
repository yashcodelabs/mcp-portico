import fs from 'node:fs';
import path from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { PorticoError } from '../shared/errors';
import { validateRegistrySchema } from './schema';
import { REGISTRY_VERSION, type RegistryDocument, type RegistryStore } from './types';

export type RegistryFileFormat = 'json' | 'yaml';

export interface LoadedRegistry {
  document: RegistryDocument;
  format: RegistryFileFormat;
}

function detectFormat(filePath: string): RegistryFileFormat | undefined {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.json') return 'json';
  if (extension === '.yaml' || extension === '.yml') return 'yaml';
  return undefined;
}

function parseDocument(raw: string, format: RegistryFileFormat): unknown {
  try {
    return format === 'json' ? JSON.parse(raw) : parseYaml(raw);
  } catch (error) {
    throw new PorticoError(
      'CONFIG_ERROR',
      `registry file is not valid ${format.toUpperCase()}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Read, parse, and schema-validate a registry file (JSON or YAML). */
export function loadRegistryFile(filePath: string): LoadedRegistry {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new PorticoError('NOT_FOUND', `registry file not found: ${filePath}`, {
      cause: error,
    });
  }

  const hinted = detectFormat(filePath);
  let data: unknown;
  let format: RegistryFileFormat;
  if (hinted !== undefined) {
    format = hinted;
    data = parseDocument(raw, hinted);
  } else {
    try {
      data = JSON.parse(raw);
      format = 'json';
    } catch {
      data = parseYaml(raw);
      format = 'yaml';
    }
  }

  const schemaIssues = validateRegistrySchema(data);
  if (schemaIssues.length > 0) {
    throw new PorticoError('CONFIG_ERROR', `registry is invalid: ${filePath}`, {
      details: { schemaIssues },
    });
  }
  return { document: data as RegistryDocument, format };
}

/** Resolve a backend catalogRef relative to the registry file's directory. */
export function resolveCatalogPath(
  registryFilePath: string,
  catalogRef: string,
): string {
  if (path.isAbsolute(catalogRef)) return catalogRef;
  return path.resolve(path.dirname(registryFilePath), catalogRef);
}

export function serializeRegistryDocument(
  document: RegistryDocument,
  format: RegistryFileFormat,
): string {
  if (format === 'json') {
    return `${JSON.stringify(document, null, 2)}\n`;
  }
  return `${stringifyYaml(document)}\n`;
}

/** Atomically replace a registry file with a serialized document. */
export function writeRegistryFile(
  filePath: string,
  document: RegistryDocument,
  format: RegistryFileFormat,
): void {
  const payload = serializeRegistryDocument(document, format);
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}`,
  );
  try {
    fs.writeFileSync(temporary, payload, 'utf8');
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup; the original error is the reportable one.
    }
    throw new PorticoError(
      'CONFIG_ERROR',
      `Failed to write registry file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export class FileRegistryStore implements RegistryStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<RegistryDocument> {
    return loadRegistryFile(this.filePath).document;
  }
}

export { REGISTRY_VERSION };
