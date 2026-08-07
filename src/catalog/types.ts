/**
 * Catalog v2 domain types for MCP Portico.
 *
 * The catalog is the compiled, validated runtime allowlist of operations and
 * schemas for one backend API. The normalized API model is the intermediate
 * representation shared by all importers (Phase 4) and the compiler.
 */

export const CATALOG_VERSION = '2.0' as const;
export const OVERLAY_VERSION = '1.0' as const;
export const COMPILER_VERSION = '0.1.0' as const;

/**
 * AI-analysis confidence gate. AI-generated metadata (Phase 6) is inert until
 * an operator reviews it: operations below this confidence, or whose
 * authorization could not be resolved, compile as unavailable and therefore
 * can never be executed or activated.
 */
export const AI_CONFIDENCE_THRESHOLD = 0.6;
/** Fail-safe confidence when an AI document omits an explicit value. */
export const AI_DEFAULT_CONFIDENCE = 0.5;

export type HttpMethod =
  'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type RiskLevel = 'read' | 'write' | 'destructive';

export type ConfirmationPolicy = 'never' | 'write' | 'destructive' | 'always';

export type ParameterLocation = 'path' | 'query' | 'header' | 'cookie';

export type BodyKind = 'json' | 'form' | 'multipart' | 'binary' | 'text';

export type SourceType = 'openapi' | 'manual' | 'ai';

export type SecuritySchemeType =
  'apiKey' | 'http' | 'oauth2' | 'openIdConnect' | 'mutualTLS';

export type JsonSchema = Record<string, unknown>;

export interface ApiInfo {
  id: string;
  title: string;
  version: string;
}

export interface CatalogWarning {
  code: string;
  message: string;
}

export interface CatalogProvenance {
  sourceType: SourceType;
  sourceChecksum?: string;
  generatedAt?: string;
  compilerVersion?: string;
  confidence?: number;
  warnings?: CatalogWarning[];
}

export interface CatalogCachePolicy {
  eligible: boolean;
  ttlSeconds?: number;
}

export interface RedactionRule {
  fields?: string[];
  headers?: string[];
}

export interface CatalogParameter {
  in: ParameterLocation;
  name: string;
  required: boolean;
  description?: string;
  schema?: JsonSchema;
}

export interface CatalogBody {
  kind: BodyKind;
  contentTypes: string[];
  required?: boolean;
  schema?: JsonSchema;
}

export interface CatalogRequest {
  parameters?: {
    path?: CatalogParameter[];
    query?: CatalogParameter[];
    header?: CatalogParameter[];
    cookie?: CatalogParameter[];
  };
  body?: CatalogBody;
}

export interface CatalogResponse {
  description?: string;
  contentTypes?: string[];
  schema?: JsonSchema;
}

export interface CatalogOperation {
  enabled: boolean;
  available: boolean;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  risk: RiskLevel;
  confirmation: ConfirmationPolicy;
  timeoutMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxConcurrency: number;
  cache?: CatalogCachePolicy;
  security: string[][];
  headers?: Record<string, string>;
  redactions?: RedactionRule[];
  examples?: unknown[];
  request?: CatalogRequest;
  responses?: Record<string, CatalogResponse>;
}

export interface Catalog {
  catalogVersion: typeof CATALOG_VERSION;
  api: ApiInfo;
  provenance: CatalogProvenance;
  checksum: string;
  securitySchemes: Record<string, SecurityScheme>;
  operations: Record<string, CatalogOperation>;
}

// ---------------------------------------------------------------------------
// Normalized API model (the intermediate representation)
// ---------------------------------------------------------------------------

export interface SecurityScheme {
  type: SecuritySchemeType;
  in?: 'header' | 'query' | 'cookie';
  name?: string;
  scheme?: string;
  description?: string;
}

export interface NormalizedParameter {
  in: ParameterLocation;
  name: string;
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
}

export interface NormalizedRequestBody {
  contentTypes: string[];
  required?: boolean;
  schema?: JsonSchema;
  kind?: BodyKind;
}

export interface NormalizedResponse {
  description?: string;
  contentTypes?: string[];
  schema?: JsonSchema;
}

export interface NormalizedOperation {
  operationId?: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: NormalizedParameter[];
  requestBody?: NormalizedRequestBody;
  responses: Record<string, NormalizedResponse>;
  security?: string[][];
  /** Optional policy hints honored before the overlay (manual models). */
  risk?: RiskLevel;
  confirmation?: ConfirmationPolicy;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxConcurrency?: number;
  cache?: CatalogCachePolicy;
  redactions?: RedactionRule[];
  examples?: unknown[];
  /** AI analysis confidence (0..1) for this operation (Phase 6 artifacts). */
  aiConfidence?: number;
  /**
   * Authorization finding from AI analysis: "resolved" (a concrete security
   * requirement was found), "unresolved" (uncertain -> unavailable), or
   * "public" (no authorization found).
   */
  aiAuthStatus?: 'resolved' | 'unresolved' | 'public';
}

export interface NormalizedApiModel {
  api: ApiInfo;
  securitySchemes: Record<string, SecurityScheme>;
  operations: NormalizedOperation[];
}

// ---------------------------------------------------------------------------
// Policy overlay
// ---------------------------------------------------------------------------

export interface OperationPolicy {
  enabled?: boolean;
  risk?: RiskLevel;
  confirmation?: ConfirmationPolicy;
  summary?: string;
  description?: string;
  tags?: string[];
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxConcurrency?: number;
  cache?: { eligible?: boolean; ttlSeconds?: number };
  redactions?: RedactionRule[];
  headers?: Record<string, string>;
}

export interface PolicyOverlay {
  overlayVersion: typeof OVERLAY_VERSION;
  apiId?: string;
  description?: string;
  operations: Record<string, OperationPolicy>;
}

// ---------------------------------------------------------------------------
// Compilation and diffing
// ---------------------------------------------------------------------------

export interface CompileOptions {
  sourceType?: SourceType;
  sourceChecksum?: string;
  confidence?: number;
  /** Provenance warnings supplied by the importer (e.g. AI analysis notes). */
  warnings?: CatalogWarning[];
  now?: Date;
}

export interface CompileResult {
  catalog: Catalog;
  warnings: CatalogWarning[];
}

export type DiffKind =
  | 'schemaChanged'
  | 'riskChanged'
  | 'securityChanged'
  | 'limitsChanged'
  | 'metadataChanged';

export interface OperationDiff {
  operationId: string;
  kinds: DiffKind[];
  details: string[];
}

export interface CatalogDiff {
  additions: string[];
  removals: string[];
  changes: OperationDiff[];
}

export interface CatalogValidationIssue {
  code: string;
  message: string;
}
