/**
 * OpenAPI/Swagger importer (Phase 4) types.
 *
 * Import is an operator-only build step. It produces an inert, credential-free
 * catalog plus a structured report; it never creates, updates, or activates a
 * registry entry or connection.
 */

import type { Catalog, CatalogWarning, PolicyOverlay } from '../../catalog/types';

export type ImportFormat = 'json' | 'yaml';

export interface SpecVersion {
  kind: 'swagger2' | 'openapi3';
  version: string;
}

export interface ImportLimits {
  /** Maximum bytes per input document (root or external reference). */
  maxBytesPerDocument: number;
  /** Maximum aggregate bytes across all documents in one import. */
  maxTotalBytes: number;
  /** Maximum number of external reference documents per import. */
  maxDocuments: number;
  /** Maximum `$ref` nesting depth (schema bundling and document scans). */
  maxRefDepth: number;
  /** Maximum number of bundled schema definitions per schema root. */
  maxSchemaDefs: number;
  /** Maximum serialized size of one bundled schema. */
  maxBundleBytes: number;
  /** Timeout for fetching remote reference documents. */
  timeoutMs: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxBytesPerDocument: 25 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxDocuments: 64,
  maxRefDepth: 32,
  maxSchemaDefs: 512,
  maxBundleBytes: 64 * 1024 * 1024,
  timeoutMs: 10_000,
};

/**
 * Remote reference policy. Defaults to `deny`: any `$ref` that escapes the
 * root document fails the import until an operator explicitly permits it.
 */
export type RemoteRefPolicy =
  | { kind: 'deny' }
  | {
      kind: 'allow';
      /** Permit relative file `$ref`s that stay inside the input directory. */
      fileRefs: boolean;
      /** Permit http(s) URL `$ref`s whose host is in `urlHosts`. */
      urlRefs: boolean;
      /** Hostnames allowed for URL `$ref`s. */
      urlHosts: string[];
      /** Permit `http:` in addition to `https:` for URL `$ref`s. */
      allowHttp: boolean;
      /** Permit private/loopback URL `$ref` destinations. */
      allowPrivateNetwork: boolean;
    };

export interface ImportOptions {
  /** Catalog API id, supplied explicitly by the operator. */
  apiId: string;
  /** Optional policy overlay applied during compilation. */
  overlay?: PolicyOverlay;
  /** External `$ref` policy; defaults to deny. */
  remoteRefs?: RemoteRefPolicy;
  /** Size/depth limits; defaults to `DEFAULT_IMPORT_LIMITS`. */
  limits?: Partial<ImportLimits>;
  /** Fixed timestamp for deterministic output (tests). */
  now?: Date;
}

export interface UnsupportedFeature {
  code: string;
  message: string;
  /** Readable document location, e.g. /paths/~1pets/get/callbacks. */
  location?: string;
}

export interface ImportReport {
  reportVersion: '1.0';
  source: {
    file: string;
    format: ImportFormat;
    spec: SpecVersion;
    sourceChecksum: string;
    bytes: number;
  };
  api: {
    id: string;
    title: string;
    version: string;
  };
  summary: {
    operations: number;
    methods: Record<string, number>;
    tags: number;
    securitySchemes: number;
    contentTypes: {
      request: string[];
      response: string[];
    };
  };
  /** Non-authoritative routing hints recorded for operator review only. */
  hints: {
    servers: string[];
    basePath?: string;
    schemes: string[];
  };
  unsupported: UnsupportedFeature[];
  warnings: CatalogWarning[];
  overlay?: {
    applied: boolean;
    operations: number;
  };
  catalog: {
    checksum: string;
    operations: number;
    available: number;
  };
}

export interface ImportResult {
  catalog: Catalog;
  report: ImportReport;
}
