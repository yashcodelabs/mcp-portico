import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import type { CatalogOperation, JsonSchema } from '../catalog/types';
import { PorticoError } from '../shared/errors';

/**
 * Catalog argument validation (Phase 5).
 *
 * Operation arguments are validated against the modeled path/query/header/
 * cookie parameters and the optional request body. Unknown keys are rejected
 * so a client can never smuggle unmodeled values into an upstream request,
 * and every value is validated against its JSON Schema before coercion.
 * Swagger 2.0 `{type: "file"}` artifacts are sanitized to strings because
 * file uploads arrive as base64 strings in the MCP layer.
 */

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const compiledValidators = new WeakMap<object, ValidateFunction>();

export interface ValidatedArguments {
  /** Coerced string values for path parameters. */
  path: Record<string, string>;
  /** Coerced string values for query parameters. */
  query: Record<string, string>;
  /** Coerced string values for header parameters, plus the joined cookie header. */
  headers: Record<string, string>;
  /** Request body value (any JSON value). */
  body?: unknown;
}

/** Recursively replace Swagger 2.0 `{type: "file"}` with `{type: "string"}`. */
function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      out[key] = key === 'type' && entry === 'file' ? 'string' : sanitizeValue(entry);
    }
    return out;
  }
  return value;
}

/**
 * Sanitize a catalog JSON Schema for Ajv compilation. Schemas are cloned so
 * the frozen catalog is never mutated; `$defs`/`$ref` bundles compile when
 * the root schema object is passed to Ajv.
 */
export function sanitizeSchema(schema: JsonSchema): JsonSchema {
  return sanitizeValue(schema) as JsonSchema;
}

/**
 * Compile a catalog JSON Schema with the shared Ajv 2020-12 instance.
 * Compilation failures are wrapped as CONFIG_ERROR because they indicate a
 * broken catalog, never a client mistake.
 */
export function compileJsonSchema(schema: JsonSchema): ValidateFunction {
  const cached = compiledValidators.get(schema);
  if (cached !== undefined) return cached;
  try {
    const validate = ajv.compile(sanitizeSchema(schema));
    compiledValidators.set(schema, validate);
    return validate;
  } catch (error) {
    throw new PorticoError(
      'CONFIG_ERROR',
      `Catalog schema is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function schemaFailure(
  parameterName: string,
  validate: ValidateFunction,
): PorticoError {
  const detail =
    validate.errors === null || validate.errors === undefined
      ? 'value rejected'
      : ajv.errorsText(validate.errors, { dataVar: parameterName });
  return new PorticoError(
    'USAGE',
    `Parameter "${parameterName}" failed schema validation: ${detail}`,
  );
}

/**
 * Validate operation arguments against the catalog model and produce the
 * coerced string values needed to render the upstream request. Throws USAGE
 * for unknown keys, missing required parameters (including path parameters
 * and required bodies), and schema violations.
 */
export function validateOperationArguments(
  operation: CatalogOperation,
  argumentsValue: Record<string, unknown>,
): ValidatedArguments {
  const parameters = operation.request?.parameters;
  const allParameters = [
    ...(parameters?.path ?? []),
    ...(parameters?.query ?? []),
    ...(parameters?.header ?? []),
    ...(parameters?.cookie ?? []),
  ];

  const allowed = new Set(allParameters.map((parameter) => parameter.name));
  if (operation.request?.body !== undefined) allowed.add('body');

  const unknown = Object.keys(argumentsValue)
    .filter((key) => !allowed.has(key))
    .sort();
  if (unknown.length > 0) {
    throw new PorticoError(
      'USAGE',
      `Unknown argument(s): ${unknown.join(', ')}. Allowed: ${[...allowed].join(', ')}.`,
    );
  }

  const missing: string[] = [];
  for (const parameter of allParameters) {
    if (parameter.required && argumentsValue[parameter.name] === undefined) {
      missing.push(parameter.name);
    }
  }
  for (const parameter of parameters?.path ?? []) {
    if (
      argumentsValue[parameter.name] === undefined &&
      !missing.includes(parameter.name)
    ) {
      missing.push(parameter.name);
    }
  }
  if (
    operation.request?.body?.required === true &&
    argumentsValue['body'] === undefined
  ) {
    missing.push('body');
  }
  if (missing.length > 0) {
    throw new PorticoError(
      'USAGE',
      `Missing required parameter(s): ${missing.join(', ')}.`,
    );
  }

  const path: Record<string, string> = {};
  const query: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const cookies: string[] = [];

  for (const parameter of allParameters) {
    const raw = argumentsValue[parameter.name];
    if (raw === undefined) continue;
    if (parameter.schema !== undefined) {
      const validate = compileJsonSchema(parameter.schema);
      if (!validate(raw)) {
        throw schemaFailure(parameter.name, validate);
      }
    }
    const value = String(raw);
    switch (parameter.in) {
      case 'path':
        path[parameter.name] = value;
        break;
      case 'query':
        query[parameter.name] = value;
        break;
      case 'header':
        headers[parameter.name] = value;
        break;
      case 'cookie':
        cookies.push(`${parameter.name}=${value}`);
        break;
    }
  }
  if (cookies.length > 0) {
    headers['cookie'] = cookies.join('; ');
  }

  const body = argumentsValue['body'];
  const bodySchema = operation.request?.body?.schema;
  if (body !== undefined && bodySchema !== undefined) {
    const validate = compileJsonSchema(bodySchema);
    if (!validate(body)) {
      const detail =
        validate.errors === null || validate.errors === undefined
          ? 'value rejected'
          : ajv.errorsText(validate.errors, { dataVar: 'body' });
      throw new PorticoError(
        'USAGE',
        `Body failed catalog schema validation: ${detail}`,
      );
    }
  }

  return {
    path,
    query,
    headers,
    ...(body !== undefined ? { body } : {}),
  };
}
