import fs from 'node:fs';
import path from 'node:path';

import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import { PorticoError } from '../shared/errors';
import type { SchemaValidationIssue } from '../catalog/schema';

const SCHEMA_DIR = path.join(__dirname, '..', '..', 'schemas');

function readSchema(filename: string): Record<string, unknown> {
  const schemaPath = path.join(SCHEMA_DIR, filename);
  try {
    return JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new PorticoError(
      'INTERNAL',
      `Failed to load published schema ${filename}: ${String(error)}`,
    );
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const validateRegistry = ajv.compile(readSchema('registry.v1.schema.json'));

export function validateRegistrySchema(data: unknown): SchemaValidationIssue[] {
  if (validateRegistry(data)) return [];
  return (validateRegistry.errors ?? []).map((error) => ({
    instancePath: error.instancePath === '' ? '/' : error.instancePath,
    message: error.message ?? 'invalid',
  }));
}
