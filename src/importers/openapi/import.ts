/**
 * OpenAPI/Swagger import entry point (Phase 4).
 *
 * Import compiles an inert, credential-free catalog v2 artifact plus a
 * structured report. It never reads, mutates, or activates registry state:
 * a backend becomes visible only after an operator assigns scope/ownership,
 * pins the catalog checksum, creates tenant connections, and publishes a
 * validated registry snapshot.
 */

import path from 'node:path';

import { sha256Hex } from '../../catalog/canonical';
import { compileCatalog } from '../../catalog/compile';
import type { Catalog } from '../../catalog/types';
import { PorticoError } from '../../shared/errors';
import type { LoadedDocument } from './refs';
import { DocumentStore } from './refs';
import { normalizeDocument } from './normalize';
import { detectSpecVersion, parseDocumentText, readInputFile } from './parse';
import type {
  ImportOptions,
  ImportReport,
  ImportResult,
  UnsupportedFeature,
} from './types';
import { DEFAULT_IMPORT_LIMITS } from './types';

export async function importOpenApi(
  inputPath: string,
  options: ImportOptions,
): Promise<ImportResult> {
  const limits = { ...DEFAULT_IMPORT_LIMITS, ...options.limits };
  const remoteRefs = options.remoteRefs ?? { kind: 'deny' as const };
  const input = readInputFile(inputPath, limits);
  const sourceChecksum = `sha256:${sha256Hex(input.raw)}`;
  const data = parseDocumentText(input.raw, input.format, inputPath);
  const spec = detectSpecVersion(data);

  const root: LoadedDocument = {
    key: path.resolve(inputPath),
    dir: path.dirname(path.resolve(inputPath)),
    data,
    bytes: input.bytes,
    isRoot: true,
  };
  const store = new DocumentStore(root, limits, remoteRefs);
  await store.loadExternalClosure();

  const { model, unsupported, hints } = normalizeDocument(
    root,
    spec,
    store,
    options.apiId,
  );

  if (
    options.overlay !== undefined &&
    options.overlay.apiId !== undefined &&
    options.overlay.apiId !== options.apiId
  ) {
    throw new PorticoError(
      'CONFIG_ERROR',
      `Overlay apiId "${options.overlay.apiId}" does not match --api-id "${options.apiId}".`,
    );
  }

  const { catalog, warnings } = compileCatalog(model, options.overlay, {
    sourceType: 'openapi',
    sourceChecksum,
    confidence: 1,
    now: options.now,
  });

  const report = buildReport({
    inputPath,
    format: input.format,
    spec,
    sourceChecksum,
    bytes: input.bytes,
    model: {
      api: model.api,
      securitySchemes: model.securitySchemes,
      operations: model.operations,
    },
    catalog,
    warnings,
    unsupported,
    hints,
    overlayApplied: options.overlay !== undefined,
    overlayOperations:
      options.overlay === undefined
        ? 0
        : Object.keys(options.overlay.operations).length,
  });

  return { catalog, report };
}

interface ReportInput {
  inputPath: string;
  format: ImportReport['source']['format'];
  spec: ImportReport['source']['spec'];
  sourceChecksum: string;
  bytes: number;
  model: {
    api: ImportReport['api'];
    securitySchemes: Record<string, unknown>;
    operations: Array<{
      method: string;
      tags?: string[];
      requestBody?: { contentTypes?: string[] };
      responses: Record<string, { contentTypes?: string[] }>;
    }>;
  };
  catalog: Catalog;
  warnings: ImportReport['warnings'];
  unsupported: UnsupportedFeature[];
  hints: ImportReport['hints'];
  overlayApplied: boolean;
  overlayOperations: number;
}

function buildReport(input: ReportInput): ImportReport {
  const methods: Record<string, number> = {};
  const tags = new Set<string>();
  const requestContentTypes = new Set<string>();
  const responseContentTypes = new Set<string>();
  for (const operation of input.model.operations) {
    methods[operation.method] = (methods[operation.method] ?? 0) + 1;
    for (const tag of operation.tags ?? []) tags.add(tag);
    for (const contentType of operation.requestBody?.contentTypes ?? []) {
      requestContentTypes.add(contentType);
    }
    for (const response of Object.values(operation.responses)) {
      for (const contentType of response.contentTypes ?? []) {
        responseContentTypes.add(contentType);
      }
    }
  }
  const operations = Object.keys(input.catalog.operations);
  const available = operations.filter(
    (operationId) => input.catalog.operations[operationId]?.available === true,
  ).length;
  return {
    reportVersion: '1.0',
    source: {
      file: input.inputPath,
      format: input.format,
      spec: input.spec,
      sourceChecksum: input.sourceChecksum,
      bytes: input.bytes,
    },
    api: input.model.api,
    summary: {
      operations: operations.length,
      methods,
      tags: tags.size,
      securitySchemes: Object.keys(input.model.securitySchemes).length,
      contentTypes: {
        request: [...requestContentTypes].sort(),
        response: [...responseContentTypes].sort(),
      },
    },
    hints: {
      servers: [...input.hints.servers],
      ...(input.hints.basePath !== undefined ? { basePath: input.hints.basePath } : {}),
      schemes: [...input.hints.schemes],
    },
    unsupported: input.unsupported,
    warnings: input.warnings,
    ...(input.overlayApplied
      ? { overlay: { applied: true, operations: input.overlayOperations } }
      : {}),
    catalog: {
      checksum: input.catalog.checksum,
      operations: operations.length,
      available,
    },
  };
}
