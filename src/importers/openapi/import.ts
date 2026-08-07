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
import { AI_DEFAULT_CONFIDENCE } from '../../catalog/types';
import type { Catalog, CatalogWarning, SourceType } from '../../catalog/types';
import { PorticoError } from '../../shared/errors';
import type { LoadedDocument } from './refs';
import { DocumentStore } from './refs';
import { normalizeDocument } from './normalize';
import { detectSpecVersion, parseDocumentText, readInputFile } from './parse';
import { isPlainObject } from './util';
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
  const sourceType: SourceType = options.sourceType ?? 'openapi';
  const input = readInputFile(inputPath, limits);
  const sourceChecksum = `sha256:${sha256Hex(input.raw)}`;
  const data = parseDocumentText(input.raw, input.format, inputPath);
  const spec = detectSpecVersion(data);
  const aiMetadata = sourceType === 'ai' ? parseAiMetadata(data, inputPath) : undefined;

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
    sourceType,
    sourceChecksum,
    confidence: aiMetadata?.confidence ?? 1,
    warnings: aiMetadata?.warnings,
    now: options.now,
  });

  const report = buildReport({
    inputPath,
    format: input.format,
    spec,
    sourceChecksum,
    bytes: input.bytes,
    sourceType,
    confidence: aiMetadata?.confidence ?? 1,
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
  sourceType: SourceType;
  confidence: number;
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
    sourceType: input.sourceType,
    confidence: input.confidence,
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

interface AiMetadata {
  confidence: number;
  analyzer?: string;
  analyzerVersion?: string;
  repo?: string;
  commit?: string;
  warnings: CatalogWarning[];
}

/**
 * Parse the root-level `x-mcp-portico` metadata block required for AI imports.
 * Fails closed: AI-generated input without this marker is rejected instead of
 * being treated as a plain OpenAPI document.
 */
function parseAiMetadata(data: unknown, inputPath: string): AiMetadata {
  const raw = isPlainObject(data) ? data['x-mcp-portico'] : undefined;
  if (raw === undefined) {
    throw new PorticoError(
      'CONFIG_ERROR',
      `AI import requires an "x-mcp-portico" metadata block at the document root: ${inputPath}`,
      {
        details: {
          issues: [
            {
              code: 'AI_METADATA_REQUIRED',
              message:
                'Run the analysis skill with its output template so the root metadata block is emitted',
            },
          ],
        },
      },
    );
  }
  if (!isPlainObject(raw)) {
    throw new PorticoError(
      'CONFIG_ERROR',
      `"x-mcp-portico" must be an object at the document root: ${inputPath}`,
    );
  }
  const warnings: CatalogWarning[] = [];
  let confidence = AI_DEFAULT_CONFIDENCE;
  if (raw.confidence !== undefined) {
    if (
      typeof raw.confidence !== 'number' ||
      !Number.isFinite(raw.confidence) ||
      raw.confidence < 0 ||
      raw.confidence > 1
    ) {
      throw new PorticoError(
        'CONFIG_ERROR',
        `"x-mcp-portico.confidence" must be a number between 0 and 1: ${inputPath}`,
      );
    }
    confidence = raw.confidence;
  } else {
    warnings.push({
      code: 'AI_UNSET_CONFIDENCE',
      message: `"x-mcp-portico.confidence" is missing; using ${AI_DEFAULT_CONFIDENCE}`,
    });
  }
  if (raw.warnings !== undefined) {
    if (!Array.isArray(raw.warnings)) {
      throw new PorticoError(
        'CONFIG_ERROR',
        `"x-mcp-portico.warnings" must be an array: ${inputPath}`,
      );
    }
    for (const item of raw.warnings) {
      if (
        !isPlainObject(item) ||
        typeof item.code !== 'string' ||
        typeof item.message !== 'string'
      ) {
        throw new PorticoError(
          'CONFIG_ERROR',
          `"x-mcp-portico.warnings" entries must be objects with string "code" and "message": ${inputPath}`,
        );
      }
      warnings.push({ code: item.code, message: item.message });
    }
  }
  const optionalString = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined;
  const analyzer = optionalString(raw.analyzer);
  const analyzerVersion = optionalString(raw.analyzerVersion);
  const repo = optionalString(raw.repo);
  const commit = optionalString(raw.commit);
  return {
    confidence,
    ...(analyzer !== undefined ? { analyzer } : {}),
    ...(analyzerVersion !== undefined ? { analyzerVersion } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(commit !== undefined ? { commit } : {}),
    warnings,
  };
}
