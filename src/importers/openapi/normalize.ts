/**
 * Normalization of Swagger 2.0 and OpenAPI 3.0-3.2 documents into the
 * normalized API model that feeds the catalog compiler.
 *
 * Normalization is conservative: unsupported features (callbacks, links,
 * webhooks, unsupported content types, unsupported security schemes) are
 * reported, never silently dropped. Imported server/host/basePath values are
 * recorded only as non-authoritative hints.
 */

import { classifyContentType, isSupportedContentType } from '../../catalog/content';
import type {
  ApiInfo,
  BodyKind,
  HttpMethod,
  NormalizedApiModel,
  NormalizedOperation,
  NormalizedParameter,
  NormalizedRequestBody,
  NormalizedResponse,
  ParameterLocation,
  SecurityScheme,
} from '../../catalog/types';
import { PorticoError } from '../../shared/errors';
import type { DocumentStore, LoadedDocument, Located } from './refs';
import { derefStructural } from './refs';
import type { SpecVersion, UnsupportedFeature } from './types';
import {
  asArray,
  asStringArray,
  isPlainObject,
  locationOf,
  optionalString,
  requiredString,
} from './util';

const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
] as const;

const METHOD_TO_HTTP: Record<string, HttpMethod> = {
  get: 'GET',
  put: 'PUT',
  post: 'POST',
  delete: 'DELETE',
  options: 'OPTIONS',
  head: 'HEAD',
  patch: 'PATCH',
};

const PARAMETER_LOCATIONS: ReadonlySet<string> = new Set([
  'path',
  'query',
  'header',
  'cookie',
]);

const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface NormalizeOutcome {
  model: NormalizedApiModel;
  unsupported: UnsupportedFeature[];
  hints: {
    servers: string[];
    basePath?: string;
    schemes: string[];
  };
}

class Context {
  readonly unsupported: UnsupportedFeature[] = [];
  readonly hints: { servers: string[]; basePath?: string; schemes: string[] } = {
    servers: [],
    schemes: [],
  };

  constructor(
    readonly apiId: string,
    readonly store: DocumentStore,
  ) {}

  note(code: string, message: string, location?: string): void {
    this.unsupported.push({
      code,
      message,
      ...(location !== undefined ? { location } : {}),
    });
  }
}

export function normalizeDocument(
  root: LoadedDocument,
  spec: SpecVersion,
  store: DocumentStore,
  apiId: string,
): NormalizeOutcome {
  const data = root.data as Record<string, unknown>;
  if (!isPlainObject(data)) {
    throw new PorticoError(
      'CONFIG_ERROR',
      'OpenAPI/Swagger document must be an object.',
    );
  }
  const ctx = new Context(apiId, store);
  const info = requireInfo(data);
  const api: ApiInfo = {
    id: apiId,
    title: requiredString(info.title, 'info.title'),
    version: String(info.version),
  };
  const model =
    spec.kind === 'swagger2'
      ? normalizeSwagger2(root, api, ctx)
      : normalizeOpenApi3(root, api, ctx);
  return { model, unsupported: ctx.unsupported, hints: ctx.hints };
}

function requireInfo(data: Record<string, unknown>): Record<string, unknown> {
  const info = data.info;
  if (!isPlainObject(info)) {
    throw new PorticoError('CONFIG_ERROR', 'Document is missing the "info" object.');
  }
  return info;
}

function requirePaths(data: Record<string, unknown>): Record<string, unknown> {
  const paths = data.paths;
  if (!isPlainObject(paths)) {
    throw new PorticoError('CONFIG_ERROR', 'Document is missing the "paths" object.');
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Swagger 2.0
// ---------------------------------------------------------------------------

function normalizeSwagger2(
  root: LoadedDocument,
  api: ApiInfo,
  ctx: Context,
): NormalizedApiModel {
  const data = root.data as Record<string, unknown>;
  const securitySchemes = normalizeSecurityDefinitions(data.securityDefinitions, ctx);
  const rootConsumes = asStringArray(data.consumes, 'consumes');
  const rootProduces = asStringArray(data.produces, 'produces');
  const host = optionalString(data.host, 'host');
  const basePath = optionalString(data.basePath, 'basePath');
  const schemes = asStringArray(data.schemes, 'schemes');
  ctx.hints.basePath = basePath;
  ctx.hints.schemes = schemes;
  if (host !== undefined) {
    for (const scheme of schemes.length > 0 ? schemes : ['https']) {
      ctx.hints.servers.push(`${scheme}://${host}${basePath ?? ''}`);
    }
  }

  const operations: NormalizedOperation[] = [];
  for (const [pathKey, rawPathItem] of Object.entries(requirePaths(data))) {
    if (rawPathItem === undefined) continue;
    if (!isPlainObject(rawPathItem)) {
      ctx.note(
        'INVALID_PATH_ITEM',
        `Path item "${pathKey}" is not an object and was skipped.`,
        locationOf(pathKey),
      );
      continue;
    }
    const pathItem = derefStructural(ctx.store, {
      value: rawPathItem,
      doc: root,
    });
    const pathValue = pathItem.value as Record<string, unknown>;
    if (!isPlainObject(pathValue)) {
      throw new PorticoError(
        'CONFIG_ERROR',
        `Path item "${pathKey}" resolved to a non-object value.`,
      );
    }
    for (const method of HTTP_METHODS) {
      const rawOp = pathValue[method];
      if (!isPlainObject(rawOp)) continue;
      const op: Record<string, unknown> = rawOp;
      const consumes =
        asStringArray(op.consumes, 'consumes').length > 0
          ? asStringArray(op.consumes, 'consumes')
          : rootConsumes;
      const produces =
        asStringArray(op.produces, 'produces').length > 0
          ? asStringArray(op.produces, 'produces')
          : rootProduces;
      const parameters = [
        ...asArray(pathValue.parameters, 'parameters'),
        ...asArray(op.parameters, 'parameters'),
      ].map((param) => derefStructural(ctx.store, { value: param, doc: pathItem.doc }));
      const split = splitSwagger2Parameters(parameters, consumes, ctx, pathKey, method);
      const examples: unknown[] = [];
      collectSwagger2Examples(op.examples, 'operation', examples);
      const responses = normalizeSwagger2Responses(
        op.responses,
        produces,
        ctx,
        pathKey,
        method,
        pathItem.doc,
        examples,
      );
      operations.push(
        buildOperation(op, METHOD_TO_HTTP[method] as HttpMethod, pathKey, {
          parameters: split.parameters,
          requestBody: split.body,
          responses,
          ...(examples.length > 0 ? { examples } : {}),
          security: resolveSecurity(op.security, data.security),
        }),
      );
    }
    reportUnsupportedMethods(pathValue, pathKey, ctx);
  }
  return { api, securitySchemes, operations };
}

function reportUnsupportedMethods(
  pathValue: Record<string, unknown>,
  pathKey: string,
  ctx: Context,
): void {
  for (const key of Object.keys(pathValue)) {
    if (key === 'trace') {
      ctx.note(
        'UNSUPPORTED_METHOD',
        `TRACE ${pathKey} is not supported in v1 and was not imported.`,
        locationOf(pathKey, 'trace'),
      );
    }
  }
}

function normalizeSecurityDefinitions(
  definitions: unknown,
  ctx: Context,
): Record<string, SecurityScheme> {
  if (definitions === undefined) return {};
  if (!isPlainObject(definitions)) {
    throw new PorticoError('CONFIG_ERROR', '"securityDefinitions" must be an object.');
  }
  const out: Record<string, SecurityScheme> = {};
  for (const [name, raw] of Object.entries(definitions)) {
    const definition = raw as Record<string, unknown>;
    if (!isPlainObject(definition)) {
      throw new PorticoError(
        'CONFIG_ERROR',
        `Security definition "${name}" must be an object.`,
      );
    }
    const type = definition.type;
    if (type === 'basic') {
      out[name] = { type: 'http', scheme: 'basic' };
    } else if (type === 'apiKey') {
      out[name] = {
        type: 'apiKey',
        in: definition.in === 'query' ? 'query' : 'header',
        name: requiredString(definition.name, `securityDefinitions.${name}.name`),
      };
    } else {
      const schemeType = type === 'oauth2' ? 'oauth2' : 'unknown';
      if (schemeType === 'oauth2') out[name] = { type: 'oauth2' };
      ctx.note(
        'UNSUPPORTED_SECURITY_SCHEME',
        `Security definition "${name}" (${String(type)}) is not supported in v1.`,
        `/securityDefinitions/${name}`,
      );
    }
  }
  return out;
}

function splitSwagger2Parameters(
  parameters: Located[],
  consumes: string[],
  ctx: Context,
  pathKey: string,
  method: string,
): { parameters: NormalizedParameter[]; body?: NormalizedRequestBody } {
  const parametersOut: NormalizedParameter[] = [];
  const formParams: Array<Record<string, unknown>> = [];
  let body: NormalizedRequestBody | undefined;

  for (const located of parameters) {
    const param = located.value as Record<string, unknown>;
    if (!isPlainObject(param)) {
      ctx.note(
        'INVALID_PARAMETER',
        `A parameter under ${method.toUpperCase()} ${pathKey} is not an object and was skipped.`,
        locationOf(pathKey, method, 'parameters'),
      );
      continue;
    }
    const location = param.in;
    if (location === 'body') {
      const effectiveConsumes = consumes.length > 0 ? consumes : ['application/json'];
      const { kept, dropped } = splitSupported(effectiveConsumes);
      if (consumes.length === 0) {
        ctx.note(
          'DEFAULT_CONTENT_TYPE',
          `Body parameter for ${method.toUpperCase()} ${pathKey} has no "consumes" declaration; assuming application/json.`,
          locationOf(pathKey, method, 'parameters'),
        );
      }
      for (const contentType of dropped) {
        ctx.note(
          'UNSUPPORTED_CONTENT_TYPE',
          `Request content type "${contentType}" for ${method.toUpperCase()} ${pathKey} is not supported in v1 and was not imported.`,
          locationOf(pathKey, method, 'parameters'),
        );
      }
      if (kept.length > 0 || consumes.length === 0) {
        body = {
          contentTypes: kept.length > 0 ? kept : ['application/json'],
          required: param.required === true,
          ...(param.schema !== undefined
            ? { schema: ctx.store.bundleSchema(param.schema, located.doc) }
            : {}),
        };
      }
    } else if (location === 'formData') {
      formParams.push(param);
    } else {
      const normalized = normalizeSwagger2Parameter(param);
      if (normalized !== undefined) parametersOut.push(normalized);
    }
  }

  if (formParams.length > 0) {
    const multipart = consumes.some(
      (contentType) => classifyContentType(contentType) === 'multipart',
    );
    const formTypes = consumes.filter(
      (contentType) => classifyContentType(contentType) === 'form',
    );
    const contentTypes = multipart
      ? ['multipart/form-data']
      : formTypes.length > 0
        ? formTypes
        : ['application/x-www-form-urlencoded'];
    if (consumes.length > 0 && !multipart && formTypes.length === 0) {
      ctx.note(
        'DEFAULT_CONTENT_TYPE',
        `Form parameters for ${method.toUpperCase()} ${pathKey} do not match "consumes"; assuming application/x-www-form-urlencoded.`,
        locationOf(pathKey, method, 'parameters'),
      );
    }
    body = {
      contentTypes,
      schema: formSchema(formParams, ctx, pathKey, method),
    };
  }

  return { parameters: parametersOut, body };
}

function normalizeSwagger2Parameter(
  param: Record<string, unknown>,
): NormalizedParameter | undefined {
  const location = param.in;
  if (!PARAMETER_LOCATIONS.has(String(location))) {
    return undefined;
  }
  const name = param.name;
  if (typeof name !== 'string' || name === '') {
    throw new PorticoError('CONFIG_ERROR', 'Parameter is missing a name.');
  }
  return {
    in: location as ParameterLocation,
    name,
    required: location === 'path' ? true : param.required === true,
    ...(param.description !== undefined
      ? { description: String(param.description) }
      : {}),
    ...(paramSchema(param) !== undefined
      ? { schema: paramSchema(param) as Record<string, unknown> }
      : {}),
  };
}

const SWAGGER2_SCHEMA_KEYS = [
  'type',
  'format',
  'items',
  'enum',
  'default',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'multipleOf',
] as const;

function paramSchema(
  param: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const schema: Record<string, unknown> = {};
  for (const key of SWAGGER2_SCHEMA_KEYS) {
    if (param[key] !== undefined) schema[key] = param[key];
  }
  return Object.keys(schema).length > 0 ? schema : undefined;
}

function formSchema(
  formParams: Array<Record<string, unknown>>,
  ctx: Context,
  pathKey: string,
  method: string,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const param of formParams) {
    const name = param.name;
    if (typeof name !== 'string' || name === '') {
      ctx.note(
        'INVALID_PARAMETER',
        `A formData parameter under ${method.toUpperCase()} ${pathKey} is missing a name and was skipped.`,
        locationOf(pathKey, method, 'parameters'),
      );
      continue;
    }
    properties[name] = paramSchema(param) ?? { type: 'string' };
    if (param.required === true) required.push(name);
  }
  const schema: Record<string, unknown> = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

function normalizeSwagger2Responses(
  responsesRaw: unknown,
  produces: string[],
  ctx: Context,
  pathKey: string,
  method: string,
  doc: LoadedDocument,
  examplesOut: unknown[],
): Record<string, NormalizedResponse> {
  const out: Record<string, NormalizedResponse> = {};
  if (!isPlainObject(responsesRaw)) {
    ctx.note(
      'INVALID_RESPONSES',
      `Responses for ${method.toUpperCase()} ${pathKey} are not an object.`,
      locationOf(pathKey, method),
    );
    return out;
  }
  for (const [status, raw] of Object.entries(responsesRaw)) {
    if (!isConcreteStatus(status)) {
      ctx.note(
        'RESPONSE_STATUS_RANGE',
        `Response key "${status}" for ${method.toUpperCase()} ${pathKey} is not a concrete status code and was not imported.`,
        locationOf(pathKey, method, 'responses'),
      );
      continue;
    }
    const response = derefStructural(ctx.store, { value: raw, doc });
    const value = response.value as Record<string, unknown>;
    if (!isPlainObject(value)) {
      ctx.note(
        'INVALID_RESPONSE',
        `Response "${status}" for ${method.toUpperCase()} ${pathKey} is not an object and was skipped.`,
        locationOf(pathKey, method, 'responses'),
      );
      continue;
    }
    collectSwagger2Examples(value.examples, `response:${status}`, examplesOut);
    let contentTypes: string[] = [];
    if (value.schema !== undefined) {
      const { kept, dropped } = splitSupported(
        produces.length > 0 ? produces : ['application/json'],
      );
      if (produces.length === 0) {
        ctx.note(
          'DEFAULT_CONTENT_TYPE',
          `Response "${status}" for ${method.toUpperCase()} ${pathKey} has no "produces" declaration; assuming application/json.`,
          locationOf(pathKey, method, 'responses'),
        );
      }
      for (const contentType of dropped) {
        ctx.note(
          'UNSUPPORTED_CONTENT_TYPE',
          `Response content type "${contentType}" for ${method.toUpperCase()} ${pathKey} is not supported in v1 and was not imported.`,
          locationOf(pathKey, method, 'responses'),
        );
      }
      contentTypes = kept.length > 0 ? kept : ['application/json'];
    }
    out[status] = {
      ...(value.description !== undefined
        ? { description: String(value.description) }
        : {}),
      ...(contentTypes.length > 0 ? { contentTypes } : {}),
      ...(value.schema !== undefined
        ? { schema: ctx.store.bundleSchema(value.schema, response.doc) }
        : {}),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// OpenAPI 3.x
// ---------------------------------------------------------------------------

function normalizeOpenApi3(
  root: LoadedDocument,
  api: ApiInfo,
  ctx: Context,
): NormalizedApiModel {
  const data = root.data as Record<string, unknown>;
  const components = isPlainObject(data.components) ? data.components : {};
  const securitySchemes = normalizeSecuritySchemes(components.securitySchemes, ctx);

  if (data.webhooks !== undefined) {
    if (!isPlainObject(data.webhooks)) {
      throw new PorticoError('CONFIG_ERROR', '"webhooks" must be an object.');
    }
    for (const name of Object.keys(data.webhooks)) {
      ctx.note(
        'WEBHOOKS',
        `Webhook "${name}" is not executable in v1 and was not imported.`,
        `/webhooks/${name}`,
      );
    }
  }

  for (const server of asArray(data.servers, 'servers')) {
    if (isPlainObject(server) && typeof server.url === 'string') {
      ctx.hints.servers.push(server.url);
    }
  }

  const operations: NormalizedOperation[] = [];
  for (const [pathKey, rawPathItem] of Object.entries(requirePaths(data))) {
    if (rawPathItem === undefined) continue;
    if (!isPlainObject(rawPathItem)) {
      ctx.note(
        'INVALID_PATH_ITEM',
        `Path item "${pathKey}" is not an object and was skipped.`,
        locationOf(pathKey),
      );
      continue;
    }
    const pathItem = derefStructural(ctx.store, {
      value: rawPathItem,
      doc: root,
    });
    const pathValue = pathItem.value as Record<string, unknown>;
    if (!isPlainObject(pathValue)) {
      throw new PorticoError(
        'CONFIG_ERROR',
        `Path item "${pathKey}" resolved to a non-object value.`,
      );
    }
    for (const method of HTTP_METHODS) {
      const rawOp = pathValue[method];
      if (!isPlainObject(rawOp)) continue;
      const op: Record<string, unknown> = rawOp;
      const examples: unknown[] = [];
      const parameters: NormalizedParameter[] = [];
      for (const param of [
        ...asArray(pathValue.parameters, 'parameters'),
        ...asArray(op.parameters, 'parameters'),
      ]) {
        const located = derefStructural(ctx.store, {
          value: param,
          doc: pathItem.doc,
        });
        const normalized = normalizeParameter3(located, ctx, pathKey, method);
        if (normalized !== undefined) parameters.push(normalized);
      }
      const requestBody =
        op.requestBody === undefined
          ? undefined
          : normalizeRequestBody3(
              derefStructural(ctx.store, {
                value: op.requestBody,
                doc: pathItem.doc,
              }),
              ctx,
              pathKey,
              method,
              examples,
            );
      if (isPlainObject(op.callbacks)) {
        for (const name of Object.keys(op.callbacks)) {
          ctx.note(
            'CALLBACKS',
            `Callback "${name}" on ${method.toUpperCase()} ${pathKey} is not executable in v1 and was not imported.`,
            locationOf(pathKey, method, `callbacks/${name}`),
          );
        }
      }
      const responses = normalizeResponses3(
        op.responses,
        pathItem.doc,
        ctx,
        pathKey,
        method,
        examples,
      );
      operations.push(
        buildOperation(op, METHOD_TO_HTTP[method] as HttpMethod, pathKey, {
          parameters,
          requestBody,
          responses,
          ...(examples.length > 0 ? { examples } : {}),
          security: resolveSecurity(op.security, data.security),
        }),
      );
    }
    reportUnsupportedMethods(pathValue, pathKey, ctx);
  }
  return { api, securitySchemes, operations };
}

function normalizeSecuritySchemes(
  schemes: unknown,
  ctx: Context,
): Record<string, SecurityScheme> {
  if (schemes === undefined) return {};
  if (!isPlainObject(schemes)) {
    throw new PorticoError(
      'CONFIG_ERROR',
      '"components.securitySchemes" must be an object.',
    );
  }
  const out: Record<string, SecurityScheme> = {};
  for (const [name, raw] of Object.entries(schemes)) {
    const scheme = raw as Record<string, unknown>;
    if (!isPlainObject(scheme)) {
      throw new PorticoError(
        'CONFIG_ERROR',
        `Security scheme "${name}" must be an object.`,
      );
    }
    const type = scheme.type;
    if (type === 'apiKey') {
      out[name] = {
        type: 'apiKey',
        in:
          scheme.in === 'query'
            ? 'query'
            : scheme.in === 'cookie'
              ? 'cookie'
              : 'header',
        name: requiredString(scheme.name, `components.securitySchemes.${name}.name`),
      };
    } else if (type === 'http') {
      out[name] = {
        type: 'http',
        scheme: requiredString(
          scheme.scheme,
          `components.securitySchemes.${name}.scheme`,
        ),
      };
    } else if (type === 'oauth2') {
      out[name] = { type: 'oauth2' };
      ctx.note(
        'UNSUPPORTED_SECURITY_SCHEME',
        `Security scheme "${name}" (oauth2) is not supported in v1; operations requiring it are unavailable.`,
        `/components/securitySchemes/${name}`,
      );
    } else if (type === 'openIdConnect') {
      out[name] = { type: 'openIdConnect' };
      ctx.note(
        'UNSUPPORTED_SECURITY_SCHEME',
        `Security scheme "${name}" (openIdConnect) is not supported in v1; operations requiring it are unavailable.`,
        `/components/securitySchemes/${name}`,
      );
    } else if (type === 'mutualTLS') {
      out[name] = { type: 'mutualTLS' };
      ctx.note(
        'UNSUPPORTED_SECURITY_SCHEME',
        `Security scheme "${name}" (mutualTLS) is not supported in v1; operations requiring it are unavailable.`,
        `/components/securitySchemes/${name}`,
      );
    } else {
      ctx.note(
        'UNSUPPORTED_SECURITY_SCHEME',
        `Security scheme "${name}" (${String(type)}) is not recognized and was not imported.`,
        `/components/securitySchemes/${name}`,
      );
    }
  }
  return out;
}

function normalizeParameter3(
  located: Located,
  ctx: Context,
  pathKey: string,
  method: string,
): NormalizedParameter | undefined {
  const param = located.value as Record<string, unknown>;
  if (!isPlainObject(param)) {
    ctx.note(
      'INVALID_PARAMETER',
      `A parameter under ${method.toUpperCase()} ${pathKey} is not an object and was skipped.`,
      locationOf(pathKey, method, 'parameters'),
    );
    return undefined;
  }
  const location = param.in;
  if (typeof location !== 'string' || !PARAMETER_LOCATIONS.has(location)) {
    ctx.note(
      'INVALID_PARAMETER',
      `A parameter under ${method.toUpperCase()} ${pathKey} has an unsupported "in" value (${String(location)}) and was skipped.`,
      locationOf(pathKey, method, 'parameters'),
    );
    return undefined;
  }
  const name = param.name;
  if (typeof name !== 'string' || name === '') {
    throw new PorticoError(
      'CONFIG_ERROR',
      `Parameter under ${method.toUpperCase()} ${pathKey} is missing a name.`,
    );
  }
  let schema: Record<string, unknown> | undefined;
  if (isPlainObject(param.content)) {
    const entries = Object.entries(param.content);
    const first = entries[0];
    if (
      first !== undefined &&
      isPlainObject(first[1]) &&
      first[1].schema !== undefined
    ) {
      schema = ctx.store.bundleSchema(first[1].schema, located.doc);
    }
  } else if (param.schema !== undefined) {
    schema = ctx.store.bundleSchema(param.schema, located.doc);
  }
  return {
    in: location as ParameterLocation,
    name,
    required: location === 'path' ? true : param.required === true,
    ...(param.description !== undefined
      ? { description: String(param.description) }
      : {}),
    ...(schema !== undefined ? { schema } : {}),
  };
}

function normalizeRequestBody3(
  located: Located,
  ctx: Context,
  pathKey: string,
  method: string,
  examplesOut: unknown[],
): NormalizedRequestBody | undefined {
  const body = located.value as Record<string, unknown>;
  if (!isPlainObject(body)) {
    ctx.note(
      'INVALID_REQUEST_BODY',
      `Request body for ${method.toUpperCase()} ${pathKey} is not an object and was skipped.`,
      locationOf(pathKey, method, 'requestBody'),
    );
    return undefined;
  }
  const content = body.content;
  if (!isPlainObject(content)) {
    ctx.note(
      'REQUEST_BODY_NO_CONTENT',
      `Request body for ${method.toUpperCase()} ${pathKey} has no "content" map and was not imported.`,
      locationOf(pathKey, method, 'requestBody'),
    );
    return undefined;
  }
  const entries = Object.entries(content);
  collectMediaExamples(content, 'request', located.doc, ctx.store, examplesOut);
  const supported: Array<{
    contentType: string;
    kind: BodyKind;
    schema?: unknown;
  }> = [];
  for (const [contentType, media] of entries) {
    const kind = classifyContentType(contentType);
    if (kind === undefined) {
      ctx.note(
        'UNSUPPORTED_CONTENT_TYPE',
        `Request content type "${contentType}" for ${method.toUpperCase()} ${pathKey} is not supported in v1 and was not imported.`,
        locationOf(pathKey, method, 'requestBody'),
      );
    } else {
      supported.push({
        contentType,
        kind,
        ...(isPlainObject(media) && media.schema !== undefined
          ? { schema: media.schema }
          : {}),
      });
    }
  }
  if (supported.length === 0) return undefined;
  const firstKind = supported[0]?.kind;
  const kept = supported.filter((entry) => entry.kind === firstKind);
  for (const entry of supported.filter((item) => item.kind !== firstKind)) {
    ctx.note(
      'BODY_KIND_MIXED',
      `Request content type "${entry.contentType}" for ${method.toUpperCase()} ${pathKey} uses a different body kind than "${firstKind}"; only ${kept.map((item) => item.contentType).join(', ')} was imported.`,
      locationOf(pathKey, method, 'requestBody'),
    );
  }
  const primary = kept[0];
  return {
    contentTypes: kept.map((entry) => entry.contentType),
    required: body.required === true,
    ...(primary !== undefined && primary.schema !== undefined
      ? { schema: ctx.store.bundleSchema(primary.schema, located.doc) }
      : {}),
  };
}

function normalizeResponses3(
  responsesRaw: unknown,
  doc: LoadedDocument,
  ctx: Context,
  pathKey: string,
  method: string,
  examplesOut: unknown[],
): Record<string, NormalizedResponse> {
  const out: Record<string, NormalizedResponse> = {};
  if (!isPlainObject(responsesRaw)) {
    ctx.note(
      'INVALID_RESPONSES',
      `Responses for ${method.toUpperCase()} ${pathKey} are not an object.`,
      locationOf(pathKey, method),
    );
    return out;
  }
  for (const [status, raw] of Object.entries(responsesRaw)) {
    if (!isConcreteStatus(status)) {
      ctx.note(
        'RESPONSE_STATUS_RANGE',
        `Response key "${status}" for ${method.toUpperCase()} ${pathKey} is not a concrete status code and was not imported.`,
        locationOf(pathKey, method, 'responses'),
      );
      continue;
    }
    const response = derefStructural(ctx.store, { value: raw, doc });
    const value = response.value as Record<string, unknown>;
    if (!isPlainObject(value)) {
      ctx.note(
        'INVALID_RESPONSE',
        `Response "${status}" for ${method.toUpperCase()} ${pathKey} is not an object and was skipped.`,
        locationOf(pathKey, method, 'responses'),
      );
      continue;
    }
    if (isPlainObject(value.links)) {
      for (const linkName of Object.keys(value.links)) {
        ctx.note(
          'LINKS',
          `Link "${linkName}" on ${method.toUpperCase()} ${pathKey} response ${status} is not executable in v1 and was not imported.`,
          locationOf(pathKey, method, `responses/${status}/links/${linkName}`),
        );
      }
    }
    collectMediaExamples(
      value.content,
      `response:${status}`,
      response.doc,
      ctx.store,
      examplesOut,
    );
    let contentTypes: string[] = [];
    let schema: unknown;
    if (isPlainObject(value.content)) {
      const entries = Object.entries(value.content);
      const supported = entries.filter(([contentType]) =>
        isSupportedContentType(contentType),
      );
      for (const [contentType] of entries) {
        if (!isSupportedContentType(contentType)) {
          ctx.note(
            'UNSUPPORTED_CONTENT_TYPE',
            `Response content type "${contentType}" for ${method.toUpperCase()} ${pathKey} is not supported in v1 and was not imported.`,
            locationOf(pathKey, method, `responses/${status}/content`),
          );
        }
      }
      contentTypes = supported.map(([contentType]) => contentType);
      const first = supported[0];
      if (first !== undefined && isPlainObject(first[1])) {
        schema = first[1].schema;
      }
    }
    out[status] = {
      ...(value.description !== undefined
        ? { description: String(value.description) }
        : {}),
      ...(contentTypes.length > 0 ? { contentTypes } : {}),
      ...(schema !== undefined
        ? { schema: ctx.store.bundleSchema(schema, response.doc) }
        : {}),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

interface OperationExtras {
  parameters?: NormalizedParameter[];
  requestBody?: NormalizedRequestBody;
  responses: Record<string, NormalizedResponse>;
  examples?: unknown[];
  security: string[][];
}

function buildOperation(
  op: Record<string, unknown>,
  method: HttpMethod,
  pathKey: string,
  extras: OperationExtras,
): NormalizedOperation {
  const operationId = op.operationId;
  let normalizedId: string | undefined;
  if (typeof operationId === 'string' && operationId !== '') {
    if (OPERATION_ID_PATTERN.test(operationId)) {
      normalizedId = operationId;
    } else {
      normalizedId = undefined;
    }
  }
  const operation: NormalizedOperation = {
    ...(normalizedId !== undefined ? { operationId: normalizedId } : {}),
    method,
    path: pathKey,
    ...(op.summary !== undefined ? { summary: String(op.summary) } : {}),
    ...(op.description !== undefined ? { description: String(op.description) } : {}),
    ...(Array.isArray(op.tags) ? { tags: op.tags.map((tag) => String(tag)) } : {}),
    ...(op.deprecated === true ? { deprecated: true } : {}),
    ...(extras.parameters !== undefined && extras.parameters.length > 0
      ? { parameters: extras.parameters }
      : {}),
    ...(extras.requestBody !== undefined ? { requestBody: extras.requestBody } : {}),
    responses: extras.responses,
    ...(extras.examples !== undefined && extras.examples.length > 0
      ? { examples: extras.examples }
      : {}),
    security: extras.security,
  };
  return operation;
}

/**
 * Collect OAS 3.x media-type examples (request bodies and responses) into the
 * operation examples list. Example `$ref`s are resolved structurally.
 */
function collectMediaExamples(
  content: unknown,
  location: string,
  doc: LoadedDocument,
  store: DocumentStore,
  out: unknown[],
): void {
  if (!isPlainObject(content)) return;
  for (const [contentType, media] of Object.entries(content)) {
    if (!isPlainObject(media)) continue;
    if (media.example !== undefined) {
      out.push({ location, contentType, example: media.example });
    }
    if (isPlainObject(media.examples)) {
      for (const [name, rawExample] of Object.entries(media.examples)) {
        const resolved = derefStructural(store, { value: rawExample, doc });
        out.push({ location, contentType, name, example: resolved.value });
      }
    }
  }
}

/** Collect Swagger 2.0 example maps (`{ mimeType: example }`). */
function collectSwagger2Examples(
  examples: unknown,
  location: string,
  out: unknown[],
): void {
  if (!isPlainObject(examples)) return;
  for (const [contentType, example] of Object.entries(examples)) {
    out.push({ location, contentType, example });
  }
}

function resolveSecurity(opSecurity: unknown, rootSecurity: unknown): string[][] {
  if (opSecurity !== undefined) return normalizeSecurityRequirement(opSecurity);
  if (rootSecurity !== undefined) return normalizeSecurityRequirement(rootSecurity);
  return [];
}

function normalizeSecurityRequirement(value: unknown): string[][] {
  if (!Array.isArray(value)) {
    throw new PorticoError('CONFIG_ERROR', '"security" must be an array.');
  }
  return value.map((alternative) => {
    if (!isPlainObject(alternative)) {
      throw new PorticoError(
        'CONFIG_ERROR',
        'Each "security" alternative must be an object.',
      );
    }
    return Object.keys(alternative);
  });
}

function splitSupported(contentTypes: string[]): {
  kept: string[];
  dropped: string[];
} {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const contentType of contentTypes) {
    if (isSupportedContentType(contentType)) kept.push(contentType);
    else dropped.push(contentType);
  }
  return { kept, dropped };
}

function isConcreteStatus(status: string): boolean {
  return /^\d{3}$/.test(status) || status === 'default';
}
