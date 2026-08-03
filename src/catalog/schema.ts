import fs from 'node:fs';
import path from 'node:path';

import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import { PorticoError } from '../shared/errors';

const SCHEMA_DIR = path.join(__dirname, '..', '..', 'schemas');

export interface SchemaValidationIssue {
  instancePath: string;
  message: string;
}

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

function createValidator(
  schema: Record<string, unknown>,
): (data: unknown) => SchemaValidationIssue[] {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  return (data: unknown): SchemaValidationIssue[] => {
    if (validate(data)) return [];
    return (validate.errors ?? []).map((error) => ({
      instancePath: error.instancePath === '' ? '/' : error.instancePath,
      message: error.message ?? 'invalid',
    }));
  };
}

export const validateCatalogSchema: (data: unknown) => SchemaValidationIssue[] =
  createValidator(readSchema('catalog.v2.schema.json'));

export const validateOverlaySchema: (data: unknown) => SchemaValidationIssue[] =
  createValidator(readSchema('overlay.v1.schema.json'));

export function formatSchemaIssues(issues: SchemaValidationIssue[]): string {
  return issues.map((issue) => `${issue.instancePath}: ${issue.message}`).join('\n');
}
