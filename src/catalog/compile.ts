import { CATALOG_CHECKSUM_EXCLUDE, checksum } from './canonical';
import { deriveBodyKind } from './content';
import { generateOperationId } from './ids';
import { formatSchemaIssues, validateOverlaySchema } from './schema';
import { COMPILER_VERSION } from './types';
import { validateCatalog } from './validate';
import type {
  Catalog,
  CatalogBody,
  CatalogOperation,
  CatalogParameter,
  CatalogRequest,
  CatalogResponse,
  CatalogValidationIssue,
  CatalogWarning,
  CompileOptions,
  CompileResult,
  ConfirmationPolicy,
  HttpMethod,
  NormalizedApiModel,
  NormalizedOperation,
  OperationPolicy,
  PolicyOverlay,
  RiskLevel,
  SecurityScheme,
} from './types';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENCY = 4;

const SUPPORTED_HTTP_SCHEMES = new Set(['bearer', 'basic']);

/**
 * Compile a normalized API model plus an optional policy overlay into a
 * validated catalog v2 artifact. Fails closed: unsafe paths, duplicate
 * operation IDs, unresolved security schemes, and unsupported content types
 * are compile errors. Overlays restrict or annotate; they cannot invent
 * operations or change method/path/security.
 */
export function compileCatalog(
  model: NormalizedApiModel,
  overlay?: PolicyOverlay,
  options: CompileOptions = {},
): CompileResult {
  const errors: CatalogValidationIssue[] = [];
  const warnings: CatalogWarning[] = [];

  if (model.operations.length === 0) {
    errors.push({ code: 'EMPTY_MODEL', message: 'normalized model has no operations' });
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(model.api.id)) {
    errors.push({
      code: 'INVALID_API_ID',
      message: `api id "${model.api.id}" must match ^[a-z0-9][a-z0-9-]*$`,
    });
  }

  const overlayIssues = overlay === undefined ? [] : validateOverlaySchema(overlay);
  if (overlayIssues.length > 0) {
    errors.push({
      code: 'INVALID_OVERLAY',
      message: `policy overlay is invalid:\n${formatSchemaIssues(overlayIssues)}`,
    });
  }

  if (errors.length > 0) {
    throw new CompileError(errors);
  }

  const ids = assignOperationIds(model, errors);
  const assignedIds = new Set([...ids.values()]);
  for (const operationId of Object.keys(overlay?.operations ?? {})) {
    if (!assignedIds.has(operationId)) {
      errors.push({
        code: 'OVERLAY_UNKNOWN_OPERATION',
        message: `overlay references unknown operation "${operationId}"; overlays cannot invent operations`,
      });
    }
  }

  if (errors.length > 0) {
    throw new CompileError(errors);
  }

  const securitySchemes = model.securitySchemes;
  const operations: Record<string, CatalogOperation> = {};

  for (const operation of model.operations) {
    const operationId = ids.get(operation) as string;
    const policy = overlay?.operations[operationId];
    const security = operation.security ?? [];
    const { available, securityWarnings } = resolveSecurity(
      operationId,
      security,
      securitySchemes,
    );
    warnings.push(...securityWarnings);

    const risk = policy?.risk ?? operation.risk ?? defaultRisk(operation.method);
    const confirmation =
      policy?.confirmation ?? operation.confirmation ?? defaultConfirmation(risk);
    const request = compileRequest(operationId, operation, errors);

    operations[operationId] = {
      enabled: policy?.enabled ?? true,
      available,
      method: operation.method,
      path: operation.path,
      summary: policy?.summary ?? operation.summary,
      description: policy?.description ?? operation.description,
      tags: policy?.tags ?? operation.tags,
      deprecated: operation.deprecated,
      risk,
      confirmation,
      timeoutMs: policy?.timeoutMs ?? operation.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRequestBytes:
        policy?.maxRequestBytes ??
        operation.maxRequestBytes ??
        DEFAULT_MAX_REQUEST_BYTES,
      maxResponseBytes:
        policy?.maxResponseBytes ??
        operation.maxResponseBytes ??
        DEFAULT_MAX_RESPONSE_BYTES,
      maxConcurrency:
        policy?.maxConcurrency ?? operation.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      cache: mergeCache(policy?.cache, operation.cache),
      security,
      headers: policy?.headers,
      redactions: policy?.redactions ?? operation.redactions,
      examples: operation.examples,
      request,
      responses: compileResponses(operation, errors),
    };

    if (operation.operationId === undefined) {
      warnings.push({
        code: 'GENERATED_OPERATION_ID',
        message: `operation ${operation.method} ${operation.path} received generated id "${operationId}"`,
      });
    }
    if (policy?.risk === undefined && operation.risk === undefined) {
      warnings.push({
        code: 'INFERRED_RISK',
        message: `operation ${operationId} risk inferred as "${risk}" from method ${operation.method}`,
      });
    }
  }

  if (errors.length > 0) {
    throw new CompileError(errors);
  }

  const sourceChecksum =
    options.sourceChecksum ??
    checksum({ api: model.api, securitySchemes, operations: model.operations });
  const generatedAt = options.now?.toISOString() ?? new Date().toISOString();

  const catalog: Catalog = {
    catalogVersion: '2.0',
    api: model.api,
    provenance: {
      sourceType: options.sourceType ?? 'manual',
      sourceChecksum,
      generatedAt,
      compilerVersion: COMPILER_VERSION,
      confidence: options.confidence ?? 1,
      warnings,
    },
    checksum: '',
    securitySchemes,
    operations,
  };

  const semanticIssues = validateCatalog(catalog);
  if (semanticIssues.length > 0) {
    throw new CompileError(semanticIssues);
  }

  catalog.checksum = checksum(catalog, CATALOG_CHECKSUM_EXCLUDE);

  return { catalog, warnings };
}

export class CompileError extends Error {
  readonly issues: CatalogValidationIssue[];

  constructor(issues: CatalogValidationIssue[]) {
    super(`catalog compilation failed with ${issues.length} error(s)`);
    this.name = 'CompileError';
    this.issues = issues;
  }
}

function assignOperationIds(
  model: NormalizedApiModel,
  errors: CatalogValidationIssue[],
): Map<NormalizedOperation, string> {
  const ids = new Map<NormalizedOperation, string>();
  const seen = new Map<string, NormalizedOperation>();
  for (const operation of model.operations) {
    const operationId =
      operation.operationId ?? generateOperationId(operation.method, operation.path);
    ids.set(operation, operationId);
    const existing = seen.get(operationId);
    if (existing !== undefined) {
      errors.push({
        code: 'DUPLICATE_OPERATION_ID',
        message:
          `operation id "${operationId}" is generated for both ` +
          `${existing.method} ${existing.path} and ${operation.method} ${operation.path}`,
      });
    } else {
      seen.set(operationId, operation);
    }
  }
  return ids;
}

function defaultRisk(method: HttpMethod): RiskLevel {
  if (method === 'DELETE') return 'destructive';
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return 'read';
  return 'write';
}

function defaultConfirmation(risk: RiskLevel): ConfirmationPolicy {
  if (risk === 'destructive') return 'destructive';
  if (risk === 'write') return 'write';
  return 'never';
}

function resolveSecurity(
  operationId: string,
  security: string[][],
  schemes: Record<string, SecurityScheme>,
): { available: boolean; securityWarnings: CatalogWarning[] } {
  const warnings: CatalogWarning[] = [];
  let available = true;
  for (const alternative of security) {
    for (const schemeName of alternative) {
      const scheme = schemes[schemeName];
      if (scheme === undefined) {
        throw new CompileError([
          {
            code: 'UNRESOLVED_SECURITY_SCHEME',
            message: `operation ${operationId}: security scheme "${schemeName}" is not defined in the model`,
          },
        ]);
      }
      if (!isSupportedScheme(scheme)) {
        available = false;
        warnings.push({
          code: 'UNSUPPORTED_SECURITY_SCHEME',
          message:
            `operation ${operationId}: security scheme "${schemeName}" ` +
            `(${scheme.type}${scheme.scheme !== undefined ? `/${scheme.scheme}` : ''}) is not supported in v1; operation is unavailable`,
        });
      }
    }
  }
  return { available, securityWarnings: warnings };
}

function isSupportedScheme(scheme: SecurityScheme): boolean {
  if (scheme.type === 'apiKey') return true;
  if (scheme.type === 'http') {
    return (
      scheme.scheme !== undefined &&
      SUPPORTED_HTTP_SCHEMES.has(scheme.scheme.toLowerCase())
    );
  }
  return false;
}

function compileRequest(
  operationId: string,
  operation: NormalizedOperation,
  errors: CatalogValidationIssue[],
): CatalogRequest | undefined {
  const parameters = groupParameters(operationId, operation.parameters ?? [], errors);
  const body = compileBody(operationId, operation.requestBody, errors);
  if (parameters === undefined && body === undefined) return undefined;
  return {
    ...(parameters !== undefined ? { parameters } : {}),
    ...(body !== undefined ? { body } : {}),
  };
}

function groupParameters(
  operationId: string,
  parameters: NormalizedOperation['parameters'],
  errors: CatalogValidationIssue[],
): CatalogRequest['parameters'] | undefined {
  if (parameters === undefined || parameters.length === 0) return undefined;
  const grouped: NonNullable<CatalogRequest['parameters']> = {};
  const seen = new Set<string>();
  for (const parameter of parameters) {
    const key = `${parameter.in}:${parameter.name}`;
    if (seen.has(key)) {
      errors.push({
        code: 'DUPLICATE_PARAMETER',
        message: `operation ${operationId}: duplicate ${parameter.in} parameter "${parameter.name}"`,
      });
      continue;
    }
    seen.add(key);
    const compiled: CatalogParameter = {
      in: parameter.in,
      name: parameter.name,
      required: parameter.required ?? parameter.in === 'path',
      description: parameter.description,
      schema: parameter.schema,
    };
    (grouped[parameter.in] ??= []).push(compiled);
  }
  return grouped;
}

function compileBody(
  operationId: string,
  requestBody: NormalizedOperation['requestBody'],
  errors: CatalogValidationIssue[],
): CatalogBody | undefined {
  if (requestBody === undefined) return undefined;
  const kind = requestBody.kind ?? deriveBodyKind(requestBody.contentTypes);
  if (kind === undefined) {
    errors.push({
      code: 'UNSUPPORTED_CONTENT_TYPE',
      message: `operation ${operationId}: request body content types do not resolve to a single supported kind`,
    });
  }
  return {
    kind: kind ?? 'json',
    contentTypes: requestBody.contentTypes,
    required: requestBody.required,
    schema: requestBody.schema,
  };
}

function compileResponses(
  operation: NormalizedOperation,
  errors: CatalogValidationIssue[],
): Record<string, CatalogResponse> | undefined {
  const entries = Object.entries(operation.responses);
  if (entries.length === 0) return undefined;
  const responses: Record<string, CatalogResponse> = {};
  for (const [status, response] of entries) {
    responses[status] = {
      description: response.description,
      contentTypes: response.contentTypes,
      schema: response.schema,
    };
  }
  return responses;
}

function mergeCache(
  policy: OperationPolicy['cache'],
  operation: NormalizedOperation['cache'],
): CatalogOperation['cache'] {
  if (policy === undefined && operation === undefined) return undefined;
  return {
    eligible: policy?.eligible ?? operation?.eligible ?? false,
    ttlSeconds: policy?.ttlSeconds ?? operation?.ttlSeconds,
  };
}
