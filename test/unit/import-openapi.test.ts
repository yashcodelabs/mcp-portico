import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalize } from '../../src/catalog/canonical';
import { CompileError } from '../../src/catalog/compile';
import { isPorticoError } from '../../src/shared/errors';
import { importOpenApi } from '../../src/importers/openapi/import';
import type { ImportOptions } from '../../src/importers/openapi/types';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'import');
const FIXED_NOW = new Date('2026-08-06T00:00:00.000Z');

function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

async function importIssues(
  file: string,
  options: Partial<ImportOptions> = {},
): Promise<string[]> {
  try {
    await importOpenApi(file, { apiId: 'x', ...options });
    return [];
  } catch (error) {
    if (error instanceof CompileError) {
      return error.issues.map((issue) => issue.code);
    }
    if (isPorticoError(error)) return [error.code];
    throw error;
  }
}

async function importMessage(
  file: string,
  options: Partial<ImportOptions> = {},
): Promise<string> {
  try {
    await importOpenApi(file, { apiId: 'x', ...options });
    return '';
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
}

async function importTempSpec(
  spec: Record<string, unknown>,
  options: Partial<ImportOptions> = {},
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'portico-import-regression-'));
  const file = path.join(directory, 'temp-spec.json');
  writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  try {
    return await importOpenApi(file, { apiId: 'x', now: FIXED_NOW, ...options });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('OpenAPI/Swagger import', () => {
  it('matches the golden imported catalog byte-for-byte', async () => {
    const { catalog } = await importOpenApi(fixture('petstore.openapi30.json'), {
      apiId: 'petstore',
      now: FIXED_NOW,
    });
    const golden = readFileSync(
      path.join(FIXTURES, 'golden', 'petstore.openapi30.catalog.json'),
      'utf8',
    );
    // The golden file is prettier-formatted; compare canonical compact JSON so
    // only semantic drift (not whitespace) fails the check.
    expect(JSON.stringify(catalog)).toBe(JSON.stringify(JSON.parse(golden)));
  });

  it('imports the OpenAPI 3.0 fixture into a valid, deterministic catalog', async () => {
    const first = await importOpenApi(fixture('petstore.openapi30.json'), {
      apiId: 'petstore',
      now: FIXED_NOW,
    });
    const second = await importOpenApi(fixture('petstore.openapi30.json'), {
      apiId: 'petstore',
      now: FIXED_NOW,
    });
    expect(JSON.stringify(first.catalog)).toBe(JSON.stringify(second.catalog));
    expect(canonicalize(first.catalog)).toBe(canonicalize(second.catalog));

    const ids = Object.keys(first.catalog.operations).sort();
    expect(ids).toEqual([
      'createPet',
      'deletePet',
      'getSummary',
      'listPets',
      'showPetById',
      'uploadPetPhoto',
    ]);
    const operation = first.catalog.operations['showPetById'];
    expect(operation).toBeDefined();
    expect(operation?.method).toBe('GET');
    expect(operation?.path).toBe('/pets/{petId}');
    expect(operation?.request?.parameters?.path?.[0]).toMatchObject({
      in: 'path',
      name: 'petId',
      required: true,
    });
    // Security: apiKey operations available; oauth2-only operation unavailable.
    expect(first.catalog.operations['listPets']?.available).toBe(true);
    expect(first.catalog.operations['getSummary']?.available).toBe(false);
    expect(
      first.catalog.provenance.warnings?.some(
        (warning) => warning.code === 'UNSUPPORTED_SECURITY_SCHEME',
      ),
    ).toBe(true);
  });

  it('produces identical catalogs from JSON and YAML representations', async () => {
    const fromJson = await importOpenApi(fixture('petstore.openapi30.json'), {
      apiId: 'petstore',
      now: FIXED_NOW,
    });
    const fromYaml = await importOpenApi(fixture('petstore.openapi30.yaml'), {
      apiId: 'petstore',
      now: FIXED_NOW,
    });
    // Only the source-file checksum may differ (the raw bytes of the JSON and
    // YAML documents differ); the normalized model and compiled catalog are
    // otherwise byte-identical.
    const excludeSource = (key: string, path: string): boolean =>
      key === 'checksum' ||
      path === 'provenance.generatedAt' ||
      path === 'provenance.sourceChecksum';
    expect(canonicalize(fromJson.catalog, excludeSource)).toBe(
      canonicalize(fromYaml.catalog, excludeSource),
    );
    expect(JSON.stringify(fromJson.catalog.api)).toBe(
      JSON.stringify(fromYaml.catalog.api),
    );
    expect(JSON.stringify(fromJson.catalog.operations)).toBe(
      JSON.stringify(fromYaml.catalog.operations),
    );
    expect(fromJson.report.summary).toEqual(fromYaml.report.summary);
  });

  it('imports the Swagger 2.0 fixture with body, formData, and security definitions', async () => {
    const { catalog, report } = await importOpenApi(fixture('petstore.swagger2.json'), {
      apiId: 'petstore',
      now: FIXED_NOW,
    });
    expect(Object.keys(catalog.operations).sort()).toEqual([
      'createPet',
      'deletePet',
      'listPets',
      'showPetById',
      'uploadPetPhoto',
    ]);
    const create = catalog.operations['createPet'];
    expect(create?.request?.body).toMatchObject({
      kind: 'json',
      contentTypes: ['application/json'],
      required: true,
    });
    const upload = catalog.operations['uploadPetPhoto'];
    expect(upload?.request?.body).toMatchObject({
      kind: 'multipart',
      contentTypes: ['multipart/form-data'],
    });
    expect(upload?.request?.body?.schema).toMatchObject({
      type: 'object',
      properties: {
        photo: { type: 'file' },
        caption: { type: 'string' },
      },
    });
    expect(catalog.securitySchemes).toMatchObject({
      apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      basic: { type: 'http', scheme: 'basic' },
      oauth2: { type: 'oauth2' },
    });
    // Non-authoritative routing hints are recorded for operator review only.
    expect(report.hints.servers).toEqual(['https://api.example.com/v1']);
    expect(report.hints.basePath).toBe('/v1');
    expect(report.hints.schemes).toEqual(['https']);
  });

  it('imports OpenAPI 3.1 with recursive schemas bundled into $defs', async () => {
    const { catalog } = await importOpenApi(fixture('petstore.openapi31.json'), {
      apiId: 'petstore',
      now: FIXED_NOW,
    });
    const getNode = catalog.operations['getNode'];
    const schema = getNode?.responses?.['200']?.schema as
      { $defs?: Record<string, unknown> } | undefined;
    expect(schema?.$defs?.components_schemas_Node).toBeDefined();
    const nodeDef = schema?.$defs?.components_schemas_Node as
      { properties?: Record<string, unknown> } | undefined;
    expect(nodeDef?.properties?.parent).toEqual({
      $ref: '#/$defs/components_schemas_Node',
    });
    expect(catalog.operations['getNode']?.available).toBe(false);
    expect(catalog.securitySchemes.openIdConnect).toMatchObject({
      type: 'openIdConnect',
    });
  });

  it('imports OpenAPI 3.2 with binary bodies, webhooks, and unsupported methods reported', async () => {
    const { catalog, report } = await importOpenApi(
      fixture('petstore.openapi32.json'),
      {
        apiId: 'petstore',
        now: FIXED_NOW,
      },
    );
    const uploadBlob = catalog.operations['uploadBlob'];
    expect(uploadBlob?.request?.body).toMatchObject({
      kind: 'binary',
      contentTypes: ['application/octet-stream'],
    });
    // application/xml response content is dropped and reported, not silent.
    const response = uploadBlob?.responses?.['200'];
    expect(response?.contentTypes).toEqual(['application/json']);
    expect(
      report.unsupported.some(
        (feature) =>
          feature.code === 'UNSUPPORTED_CONTENT_TYPE' &&
          feature.message.includes('application/xml'),
      ),
    ).toBe(true);
    expect(
      report.unsupported.some(
        (feature) =>
          feature.code === 'WEBHOOKS' && feature.message.includes('petUpdated'),
      ),
    ).toBe(true);
    expect(
      report.unsupported.some(
        (feature) =>
          feature.code === 'UNSUPPORTED_METHOD' && feature.message.includes('TRACE'),
      ),
    ).toBe(true);
    expect(Object.keys(catalog.operations).sort()).toEqual([
      'listPets',
      'ping',
      'uploadBlob',
    ]);
  });

  it('reports callbacks and links as unsupported without dropping the operation', async () => {
    const { catalog, report } = await importOpenApi(
      fixture('petstore.openapi30.json'),
      {
        apiId: 'petstore',
        now: FIXED_NOW,
      },
    );
    expect(catalog.operations['createPet']).toBeDefined();
    expect(
      report.unsupported.some(
        (feature) =>
          feature.code === 'CALLBACKS' && feature.message.includes('onPetCreated'),
      ),
    ).toBe(true);
    expect(
      report.unsupported.some(
        (feature) =>
          feature.code === 'LINKS' && feature.location?.includes('/links/self'),
      ),
    ).toBe(true);
  });

  it('applies a policy overlay during import and rejects an api id mismatch', async () => {
    const overlay = {
      overlayVersion: '1.0',
      apiId: 'petstore',
      operations: {
        listPets: { cache: { eligible: true, ttlSeconds: 60 } },
        deletePet: { enabled: false },
      },
    };
    const { catalog, report } = await importOpenApi(
      fixture('petstore.openapi30.json'),
      {
        apiId: 'petstore',
        overlay,
        now: FIXED_NOW,
      },
    );
    expect(catalog.operations['listPets']?.cache).toEqual({
      eligible: true,
      ttlSeconds: 60,
    });
    expect(catalog.operations['deletePet']?.enabled).toBe(false);
    expect(report.overlay).toEqual({ applied: true, operations: 2 });

    const mismatch = await importIssues(fixture('petstore.openapi30.json'), {
      apiId: 'petstore',
      overlay: { ...overlay, apiId: 'other' },
    });
    expect(mismatch).toEqual(['CONFIG_ERROR']);
  });

  it('records the import report summary and inert catalog checksum', async () => {
    const { catalog, report } = await importOpenApi(
      fixture('petstore.openapi30.json'),
      {
        apiId: 'petstore',
        now: FIXED_NOW,
      },
    );
    expect(report.source.spec).toEqual({ kind: 'openapi3', version: '3.0.3' });
    expect(report.source.format).toBe('json');
    expect(report.source.sourceChecksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.summary.operations).toBe(6);
    expect(report.summary.methods).toEqual({
      GET: 3,
      POST: 2,
      DELETE: 1,
    });
    expect(report.summary.tags).toBe(1);
    expect(report.summary.securitySchemes).toBe(2);
    expect(report.summary.contentTypes.request).toEqual([
      'application/json',
      'multipart/form-data',
    ]);
    expect(report.summary.contentTypes.response).toEqual(['application/json']);
    expect(report.hints.servers).toEqual(['https://api.example.com/v1']);
    expect(report.catalog.checksum).toBe(catalog.checksum);
    expect(report.catalog.available).toBe(5);
  });

  it('fails closed on unsupported spec versions and malformed documents', async () => {
    expect(await importIssues(fixture('invalid/unknown-version.json'))).toEqual([
      'CONFIG_ERROR',
    ]);
    expect(await importIssues(fixture('invalid/missing-info.json'))).toEqual([
      'CONFIG_ERROR',
    ]);
    expect(await importIssues(fixture('invalid/empty-paths.json'))).toContain(
      'EMPTY_MODEL',
    );
    expect(
      await importIssues(fixture('invalid/duplicate-operation-ids.json')),
    ).toContain('DUPLICATE_OPERATION_ID');
  });

  it('detects structural reference cycles', async () => {
    const message = await importMessage(fixture('invalid/structural-cycle.json'));
    expect(message).toContain('cycle');
  });

  it('denies external references unless explicitly permitted', async () => {
    const message = await importMessage(fixture('refs/root.json'));
    expect(message).toContain('not permitted');
  });

  it('loads permitted relative file references and bundles their schemas', async () => {
    const { catalog } = await importOpenApi(fixture('refs/root.json'), {
      apiId: 'refs',
      remoteRefs: {
        kind: 'allow',
        fileRefs: true,
        urlRefs: false,
        urlHosts: [],
        allowHttp: false,
        allowPrivateNetwork: false,
      },
      now: FIXED_NOW,
    });
    const schema = catalog.operations['getPet']?.responses?.['200']?.schema as
      { $defs?: Record<string, unknown> } | undefined;
    expect(schema?.$defs).toBeDefined();
    // The external file's own recursive ref is bundled deterministically.
    const defKeys = Object.keys(schema?.$defs ?? {});
    expect(defKeys.some((key) => key.includes('schemas_json'))).toBe(true);
  });

  it('refuses file references that escape the input directory', async () => {
    const message = await importMessage(fixture('refs/escape.json'), {
      remoteRefs: {
        kind: 'allow',
        fileRefs: true,
        urlRefs: false,
        urlHosts: [],
        allowHttp: false,
        allowPrivateNetwork: false,
      },
    });
    expect(message).toContain('escapes the input directory');
  });

  it('loads permitted remote URL references with redirect validation', async () => {
    const schemas = readFileSync(fixture('refs/schemas.json'), 'utf8');
    const server = http.createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/schemas.json' });
        response.end();
        return;
      }
      if (request.url === '/schemas.json') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(schemas);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolveListen) =>
      server.listen(0, '127.0.0.1', resolveListen),
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const directory = mkdtempSync(path.join(os.tmpdir(), 'portico-import-url-'));
    const specFile = path.join(directory, 'url-root.json');
    const spec = {
      openapi: '3.0.3',
      info: { title: 'URL refs', version: '1.0.0' },
      paths: {
        '/pets/{petId}': {
          get: {
            operationId: 'getPet',
            parameters: [
              { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
            ],
            responses: {
              '200': {
                description: 'Pet',
                content: {
                  'application/json': {
                    schema: { $ref: `http://127.0.0.1:${port}/redirect#/Pet` },
                  },
                },
              },
            },
          },
        },
      },
    };
    writeFileSync(specFile, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
    const allow: ImportOptions['remoteRefs'] = {
      kind: 'allow',
      fileRefs: false,
      urlRefs: true,
      urlHosts: ['127.0.0.1'],
      allowHttp: true,
      allowPrivateNetwork: true,
    };
    try {
      const { catalog } = await importOpenApi(specFile, {
        apiId: 'urlrefs',
        remoteRefs: allow,
        now: FIXED_NOW,
      });
      const schema = catalog.operations['getPet']?.responses?.['200']?.schema as
        { $defs?: Record<string, unknown> } | undefined;
      expect(schema?.$defs).toBeDefined();

      const denied = await importMessage(specFile, {
        remoteRefs: {
          kind: 'allow',
          fileRefs: false,
          urlRefs: true,
          urlHosts: ['other.example'],
          allowHttp: true,
          allowPrivateNetwork: true,
        },
      });
      expect(denied).toContain('not in the import allowlist');

      const defaultDenied = await importMessage(specFile);
      expect(defaultDenied).toContain('not permitted');
    } finally {
      rmSync(directory, { recursive: true, force: true });
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('enforces per-document size limits', async () => {
    const message = await importMessage(fixture('petstore.openapi30.json'), {
      limits: { maxBytesPerDocument: 128 },
    });
    expect(message).toContain('per-document limit');
  });

  it('keeps operations executable when an OR security alternative is supported', async () => {
    const { catalog, report } = await importTempSpec({
      openapi: '3.0.3',
      info: { title: 'OR security', version: '1.0.0' },
      paths: {
        '/a': {
          get: {
            operationId: 'a.get',
            responses: { 200: { description: 'ok' } },
            security: [{ apiKey: [] }, { oauth2: [] }],
          },
        },
        '/b': {
          get: {
            operationId: 'b.get',
            responses: { 200: { description: 'ok' } },
            security: [{ oauth2: [] }],
          },
        },
      },
      components: {
        securitySchemes: {
          apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
          oauth2: { type: 'oauth2' },
        },
      },
    });
    expect(catalog.operations['a.get']?.available).toBe(true);
    expect(catalog.operations['b.get']?.available).toBe(false);
    expect(report.catalog.available).toBe(1);
    const unsupported = (catalog.provenance.warnings ?? []).filter(
      (warning) => warning.code === 'UNSUPPORTED_SECURITY_SCHEME',
    );
    expect(unsupported).toHaveLength(2);
    expect(
      unsupported.some((warning) =>
        warning.message.includes('stays available through a supported alternative'),
      ),
    ).toBe(true);
    expect(
      unsupported.some((warning) =>
        warning.message.includes('operation is unavailable'),
      ),
    ).toBe(true);
  });

  it('fails closed on required request bodies with only unsupported content types', async () => {
    const { catalog, report } = await importTempSpec({
      openapi: '3.0.3',
      info: { title: 'Unsupported bodies', version: '1.0.0' },
      paths: {
        '/xml-required': {
          post: {
            operationId: 'xml.required',
            requestBody: {
              required: true,
              content: {
                'application/xml': { schema: { type: 'object' } },
              },
            },
            responses: { 200: { description: 'ok' } },
          },
        },
        '/xml-optional': {
          post: {
            operationId: 'xml.optional',
            requestBody: {
              required: false,
              content: {
                'application/xml': { schema: { type: 'object' } },
              },
            },
            responses: { 200: { description: 'ok' } },
          },
        },
      },
    });
    expect(catalog.operations['xml.required']?.available).toBe(false);
    expect(catalog.operations['xml.required']?.request?.body).toBeUndefined();
    expect(catalog.operations['xml.optional']?.available).toBe(true);
    expect(
      (catalog.provenance.warnings ?? []).some(
        (warning) => warning.code === 'UNSUPPORTED_REQUIRED_BODY',
      ),
    ).toBe(true);
    expect(report.catalog.available).toBe(1);

    const swagger = await importTempSpec(
      {
        swagger: '2.0',
        info: { title: 'Unsupported bodies', version: '1.0.0' },
        consumes: ['application/xml'],
        produces: ['application/json'],
        paths: {
          '/xml-required': {
            post: {
              operationId: 'xml.required.swagger',
              parameters: [
                {
                  name: 'body',
                  in: 'body',
                  required: true,
                  schema: { type: 'object' },
                },
              ],
              responses: { 200: { description: 'ok' } },
            },
          },
        },
      },
      { apiId: 'swagger' },
    );
    expect(swagger.catalog.operations['xml.required.swagger']?.available).toBe(false);
  });

  it('preserves declared generic media types in the catalog', async () => {
    const { catalog } = await importTempSpec({
      openapi: '3.0.3',
      info: { title: 'Media types', version: '1.0.0' },
      paths: {
        '/echo': {
          post: {
            operationId: 'echo',
            requestBody: {
              required: true,
              content: {
                'application/json; charset=utf-8': { schema: { type: 'object' } },
                'application/vnd.api+json': { schema: { type: 'object' } },
              },
            },
            responses: {
              200: {
                description: 'Echo',
                content: {
                  'text/plain; charset=utf-8': { schema: { type: 'string' } },
                  'application/problem+json': { schema: { type: 'object' } },
                },
              },
            },
          },
        },
      },
    });
    expect(catalog.operations['echo']?.request?.body?.contentTypes).toEqual([
      'application/json; charset=utf-8',
      'application/vnd.api+json',
    ]);
    expect(catalog.operations['echo']?.request?.body?.kind).toBe('json');
    expect(catalog.operations['echo']?.responses?.['200']?.contentTypes).toEqual([
      'text/plain; charset=utf-8',
      'application/problem+json',
    ]);
  });

  it('reports unsupported parameter serialization explicitly', async () => {
    const { catalog, report } = await importTempSpec({
      openapi: '3.0.3',
      info: { title: 'Serialization', version: '1.0.0' },
      paths: {
        '/search': {
          get: {
            operationId: 'search',
            parameters: [
              {
                name: 'tags',
                in: 'query',
                style: 'spaceDelimited',
                explode: false,
                schema: { type: 'array', items: { type: 'string' } },
              },
              {
                name: 'filter',
                in: 'query',
                content: {
                  'application/json': { schema: { type: 'object' } },
                },
              },
              {
                name: 'q',
                in: 'query',
                schema: { type: 'string' },
              },
            ],
            responses: { 200: { description: 'ok' } },
          },
        },
      },
    });
    expect(catalog.operations['search']?.available).toBe(true);
    const serialization = report.unsupported.filter(
      (feature) => feature.code === 'UNSUPPORTED_PARAMETER_SERIALIZATION',
    );
    expect(serialization.length).toBeGreaterThanOrEqual(4);
    expect(
      serialization.some((feature) => feature.message.includes('spaceDelimited')),
    ).toBe(true);
    expect(
      serialization.some((feature) => feature.message.includes('explode: false')),
    ).toBe(true);
    expect(
      serialization.some((feature) =>
        feature.message.includes('content-based serialization'),
      ),
    ).toBe(true);
    expect(serialization.some((feature) => feature.message.includes('array'))).toBe(
      true,
    );

    const swagger = await importTempSpec(
      {
        swagger: '2.0',
        info: { title: 'Serialization', version: '1.0.0' },
        paths: {
          '/search': {
            get: {
              operationId: 'search.swagger',
              parameters: [
                {
                  name: 'tags',
                  in: 'query',
                  type: 'array',
                  items: { type: 'string' },
                  collectionFormat: 'multi',
                },
              ],
              responses: { 200: { description: 'ok' } },
            },
          },
        },
      },
      { apiId: 'swagger' },
    );
    expect(
      swagger.report.unsupported.some(
        (feature) =>
          feature.code === 'UNSUPPORTED_PARAMETER_SERIALIZATION' &&
          feature.message.includes('collectionFormat "multi"'),
      ),
    ).toBe(true);
  });

  it('sanitizes server hints and redacts example credentials', async () => {
    const { catalog, report } = await importTempSpec({
      openapi: '3.0.3',
      info: { title: 'Credentials', version: '1.0.0' },
      servers: [
        { url: 'https://user:pass@api.example.com/v1?api_key=abc#frag' },
        { url: 'https://api.example.com/plain' },
      ],
      paths: {
        '/echo': {
          post: {
            operationId: 'echo',
            requestBody: {
              content: {
                'application/json': {
                  schema: { type: 'object' },
                  example: {
                    apiKey: 'sk-secret-value',
                    headers: { Authorization: 'Bearer token-value' },
                    name: 'Rex',
                  },
                },
              },
            },
            responses: { 200: { description: 'ok' } },
          },
        },
      },
    });
    expect(report.hints.servers).toEqual([
      'https://api.example.com/v1',
      'https://api.example.com/plain',
    ]);
    expect(
      report.unsupported.some(
        (feature) =>
          feature.code === 'SANITIZED_SERVER_HINT' &&
          feature.message.includes('userinfo, query, or fragment'),
      ),
    ).toBe(true);
    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toContain('sk-secret-value');
    expect(serialized).not.toContain('token-value');
    const examples = catalog.operations['echo']?.examples ?? [];
    expect(examples).toContainEqual({
      location: 'request',
      contentType: 'application/json',
      example: {
        apiKey: '<redacted>',
        headers: { Authorization: '<redacted>' },
        name: 'Rex',
      },
    });
  });

  it('sanitizes protected overlay headers during import', async () => {
    const overlay = {
      overlayVersion: '1.0',
      apiId: 'x',
      operations: {
        echo: {
          headers: {
            Authorization: 'Bearer secret-value',
            'X-Trace-Id': 'trace-123',
          },
        },
      },
    };
    const { catalog, report } = await importTempSpec(
      {
        openapi: '3.0.3',
        info: { title: 'Overlay headers', version: '1.0.0' },
        paths: {
          '/echo': {
            get: {
              operationId: 'echo',
              responses: { 200: { description: 'ok' } },
            },
          },
        },
      },
      { overlay },
    );
    expect(catalog.operations['echo']?.headers).toEqual({ 'X-Trace-Id': 'trace-123' });
    expect(JSON.stringify(catalog)).not.toContain('secret-value');
    expect(
      (catalog.provenance.warnings ?? []).some(
        (warning) =>
          warning.code === 'SANITIZED_PROTECTED_HEADER' &&
          warning.message.includes('Authorization'),
      ),
    ).toBe(true);
    expect(report.overlay).toEqual({ applied: true, operations: 1 });
  });

  it('rejects remote reference URLs that embed credentials', async () => {
    const schemas = readFileSync(fixture('refs/schemas.json'), 'utf8');
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(schemas);
    });
    await new Promise<void>((resolveListen) =>
      server.listen(0, '127.0.0.1', resolveListen),
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const directory = mkdtempSync(path.join(os.tmpdir(), 'portico-import-userinfo-'));
    const specFile = path.join(directory, 'userinfo-root.json');
    const spec = {
      openapi: '3.0.3',
      info: { title: 'Userinfo refs', version: '1.0.0' },
      paths: {
        '/pets/{petId}': {
          get: {
            operationId: 'getPet',
            parameters: [
              { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
            ],
            responses: {
              '200': {
                description: 'Pet',
                content: {
                  'application/json': {
                    schema: {
                      $ref: `http://alice:secret@127.0.0.1:${port}/schemas.json#/Pet`,
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    writeFileSync(specFile, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
    try {
      const message = await importMessage(specFile, {
        remoteRefs: {
          kind: 'allow',
          fileRefs: false,
          urlRefs: true,
          urlHosts: ['127.0.0.1'],
          allowHttp: true,
          allowPrivateNetwork: true,
        },
      });
      expect(message).toContain('userinfo');
    } finally {
      rmSync(directory, { recursive: true, force: true });
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('enforces remote reference byte limits before buffering the full body', async () => {
    const server = http.createServer((request, response) => {
      if (request.url === '/declared') {
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(8 * 1024),
        });
        response.end('x'.repeat(8 * 1024));
        return;
      }
      if (request.url === '/streamed') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('x'.repeat(700));
        response.end('x'.repeat(700));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolveListen) =>
      server.listen(0, '127.0.0.1', resolveListen),
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const directory = mkdtempSync(path.join(os.tmpdir(), 'portico-import-size-'));
    const specFile = path.join(directory, 'size-root.json');
    const spec = {
      openapi: '3.0.3',
      info: { title: 'Size refs', version: '1.0.0' },
      paths: {
        '/pets/{petId}': {
          get: {
            operationId: 'getPet',
            parameters: [
              { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
            ],
            responses: {
              '200': {
                description: 'Pet',
                content: {
                  'application/json': {
                    schema: {
                      $ref: `http://127.0.0.1:${port}/declared#/Pet`,
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    writeFileSync(specFile, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
    const allow: ImportOptions['remoteRefs'] = {
      kind: 'allow',
      fileRefs: false,
      urlRefs: true,
      urlHosts: ['127.0.0.1'],
      allowHttp: true,
      allowPrivateNetwork: true,
    };
    try {
      const declared = await importMessage(specFile, {
        remoteRefs: allow,
        limits: { maxBytesPerDocument: 1024 },
      });
      expect(declared).toContain('per-document limit');

      const streamedSpec =
        spec.paths['/pets/{petId}'].get.responses['200'].content['application/json'];
      streamedSpec.schema.$ref = `http://127.0.0.1:${port}/streamed#/Pet`;
      writeFileSync(specFile, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
      const streamed = await importMessage(specFile, {
        remoteRefs: allow,
        limits: { maxBytesPerDocument: 1024 },
      });
      expect(streamed).toContain('per-document limit');
    } finally {
      rmSync(directory, { recursive: true, force: true });
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('normalizes examples from request bodies, responses, and Swagger 2.0 maps', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'portico-import-examples-'));
    const oasSpec = path.join(directory, 'examples.oas.json');
    const swaggerSpec = path.join(directory, 'examples.swagger.json');
    writeFileSync(
      oasSpec,
      `${JSON.stringify(
        {
          openapi: '3.0.3',
          info: { title: 'Examples', version: '1.0.0' },
          paths: {
            '/echo': {
              post: {
                operationId: 'echo',
                requestBody: {
                  content: {
                    'application/json': {
                      schema: { type: 'object' },
                      example: { message: 'hello' },
                    },
                  },
                },
                responses: {
                  '200': {
                    description: 'Echo',
                    content: {
                      'application/json': {
                        schema: { type: 'object' },
                        examples: {
                          sample: { value: { message: 'hello back' } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(
      swaggerSpec,
      `${JSON.stringify(
        {
          swagger: '2.0',
          info: { title: 'Examples', version: '1.0.0' },
          produces: ['application/json'],
          paths: {
            '/echo': {
              post: {
                operationId: 'echo',
                examples: {
                  'application/json': { message: 'legacy example' },
                },
                responses: {
                  '200': {
                    description: 'Echo',
                    schema: { type: 'object' },
                    examples: {
                      'application/json': { message: 'response example' },
                    },
                  },
                },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    try {
      const oas = await importOpenApi(oasSpec, { apiId: 'examples', now: FIXED_NOW });
      const oasExamples = oas.catalog.operations['echo']?.examples ?? [];
      expect(oasExamples).toContainEqual({
        location: 'request',
        contentType: 'application/json',
        example: { message: 'hello' },
      });
      expect(oasExamples).toContainEqual({
        location: 'response:200',
        contentType: 'application/json',
        name: 'sample',
        example: { value: { message: 'hello back' } },
      });

      const swagger = await importOpenApi(swaggerSpec, {
        apiId: 'examples',
        now: FIXED_NOW,
      });
      const swaggerExamples = swagger.catalog.operations['echo']?.examples ?? [];
      expect(swaggerExamples).toContainEqual({
        location: 'operation',
        contentType: 'application/json',
        example: { message: 'legacy example' },
      });
      expect(swaggerExamples).toContainEqual({
        location: 'response:200',
        contentType: 'application/json',
        example: { message: 'response example' },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when a schema reference resolves to a non-schema value', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'portico-import-schema-'));
    const specFile = path.join(directory, 'bad-schema.json');
    writeFileSync(
      specFile,
      `${JSON.stringify(
        {
          openapi: '3.0.3',
          info: { title: 'Bad schema', version: '1.0.0' },
          paths: {
            '/x': {
              get: {
                operationId: 'getX',
                responses: {
                  '200': {
                    description: 'X',
                    content: {
                      'application/json': {
                        schema: { $ref: '#/components/schemas/NotASchema' },
                      },
                    },
                  },
                },
              },
            },
          },
          components: {
            schemas: {
              NotASchema: 'just a string',
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    try {
      const message = await importMessage(specFile);
      expect(message).toContain('not a valid schema');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('produces no catalog output that references registry or tenant state', async () => {
    const { catalog, report } = await importOpenApi(
      fixture('petstore.openapi30.json'),
      {
        apiId: 'petstore',
        now: FIXED_NOW,
      },
    );
    const serialized = JSON.stringify({ catalog, report });
    expect(serialized).not.toContain('tenant');
    expect(serialized).not.toContain('connection');
    expect(serialized).not.toContain('secret');
  });
});
