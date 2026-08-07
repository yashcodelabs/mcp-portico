/**
 * Phase 5 operation execution contracts.
 *
 * The MCP tool layer calls `TenantRuntime.executeOperation`, which delegates
 * to an `OperationExecutor`. The executor is the enforcement point: it
 * re-authorizes the session, validates input against catalog schemas, renders
 * the upstream request (path/query/headers/body), applies the connection's
 * auth provider and network policy, enforces confirmation, isolation
 * (rate/concurrency/circuit/health/audit/cache), response limits, and
 * redaction. No executor method accepts tenant, principal, backend,
 * connection, or base-URL values from client-controlled input.
 */

import type { PorticoPrincipal, SecretResolver } from '../auth/types';
import type { AuditLog } from '../audit/log';
import { createHash } from 'node:crypto';
import { canonicalize } from '../catalog/canonical';
import type { LimitsStore } from '../limits/store';
import type { RegistrySnapshot } from '../registry/snapshot';
import type { SessionState } from '../session/store';
import type { Redactor } from '../shared/redact';
import type { UpstreamAuthRegistry } from '../auth/upstream';
import type { CacheStore } from './cache';
import type { CircuitBreakerStore } from './circuit';
import type { HealthStore } from './health';

export type ExecutionBodyKind = 'json' | 'text' | 'binary';

export interface ExecuteOperationInput {
  /** Stable catalog operation ID. */
  operationId: string;
  /**
   * Named arguments: path/query/header/cookie parameter names, plus the
   * reserved key "body" for the request body value. Unmodeled keys are
   * rejected.
   */
  arguments: Record<string, unknown>;
  /**
   * Deterministic token returned by a previous ConfirmationRequiredResult;
   * required for operations whose confirmation policy demands it.
   */
  confirmationToken?: string;
}

export interface OperationResultBody {
  kind: ExecutionBodyKind;
  /** Parsed JSON value (json bodies). */
  data?: unknown;
  /** Decoded text (text bodies). */
  text?: string;
  /** Base64-encoded payload (binary bodies). */
  base64?: string;
}

export interface ExecuteOperationResult {
  operationId: string;
  status: number;
  /** Response headers, sensitive values redacted. */
  headers: Record<string, string>;
  contentType?: string;
  body?: OperationResultBody;
  bytes: number;
  truncated: boolean;
  durationMs: number;
  requiresConfirmation: false;
}

export interface ConfirmationRequiredResult {
  operationId: string;
  requiresConfirmation: true;
  token: string;
  risk: 'write' | 'destructive';
  message: string;
}

export type ExecuteResult = ExecuteOperationResult | ConfirmationRequiredResult;

export interface ExecuteContext {
  snapshot: RegistrySnapshot;
  session: SessionState;
  principal: PorticoPrincipal;
}

export interface BatchOptions {
  /** Maximum concurrent executions. Defaults to 2. */
  concurrency?: number;
  /** Fail fast on the first error (default false: fail-soft, per-item errors). */
  failFast?: boolean;
  /** Confirmation tokens keyed by operationId. */
  confirmationTokens?: Record<string, string>;
}

export interface BatchItemResult {
  index: number;
  operationId: string;
  result?: ExecuteOperationResult;
  confirmation?: Omit<ConfirmationRequiredResult, 'operationId'>;
  error?: {
    code: string;
    message: string;
  };
}

export interface BatchResult {
  results: BatchItemResult[];
  failed: number;
}

export interface ExecutorOptions {
  limits: LimitsStore;
  audit: AuditLog;
  caches: CacheStore;
  circuitBreakers: CircuitBreakerStore;
  health: HealthStore;
  /** Defaults to the environment secret resolver. */
  secrets?: SecretResolver;
  /** Defaults to the built-in upstream auth registry. */
  upstreamAuth?: UpstreamAuthRegistry;
  /** Defaults to the shared default redactor. */
  redactor?: Redactor;
  /** Validate upstream JSON responses against catalog schemas when true. */
  validateResponses?: boolean;
}

export interface OperationExecutor {
  execute(
    context: ExecuteContext,
    input: ExecuteOperationInput,
  ): Promise<ExecuteResult>;
  executeBatch(
    context: ExecuteContext,
    inputs: ExecuteOperationInput[],
    options?: BatchOptions,
  ): Promise<BatchResult>;
}

/**
 * Deterministic confirmation token for an operation + input, scoped to the
 * principal so one principal's confirmation cannot be replayed by another.
 */
export function confirmationTokenFor(
  principalId: string,
  operationId: string,
  argumentsValue: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(`${principalId}|${operationId}|${canonicalize(argumentsValue)}`, 'utf8')
    .digest('hex');
}
