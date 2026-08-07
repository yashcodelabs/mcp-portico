import { defaultSecretResolver, resolveSecretOrLiteral } from '../auth/secrets';
import {
  defaultUpstreamAuthRegistry,
  type UpstreamAuthRegistry,
} from '../auth/upstream';
import type { SecretResolver, UpstreamRequest } from '../auth/types';
import { newAuditEvent, type AuditLog } from '../audit/log';
import { canonicalize } from '../catalog/canonical';
import type { Catalog, CatalogOperation, RedactionRule } from '../catalog/types';
import { scopeKey, type LimitsStore } from '../limits/store';
import type { Connection } from '../registry/types';
import { sanitizeUpstreamHeaders } from '../security/headers';
import { defaultRedactor, Redactor } from '../shared/redact';
import { PorticoError } from '../shared/errors';
import type { CacheStore } from './cache';
import type { CircuitBreakerStore } from './circuit';
import {
  confirmationTokenFor,
  type BatchItemResult,
  type BatchOptions,
  type BatchResult,
  type ExecuteContext,
  type ExecuteOperationInput,
  type ExecuteOperationResult,
  type ExecuteResult,
  type ExecutorOptions,
  type OperationExecutor,
  type OperationResultBody,
} from './execution';
import type { HealthStore } from './health';
import {
  buildQuery,
  dispatchUpstream,
  encodeRequestBody,
  renderPath,
  type DispatchInit,
} from './transports';
import {
  compileJsonSchema,
  validateOperationArguments,
  type ValidatedArguments,
} from './validate';

/**
 * Phase 5 operation execution engine.
 *
 * The executor is the enforcement point for a single `call_operation`: it
 * re-authorizes the session against the current registry snapshot, enforces
 * confirmation, validates arguments against catalog schemas, applies
 * tenant/connection isolation (rate, concurrency, circuit breaker, health,
 * audit, cache), renders and dispatches the upstream request under the
 * connection's network policy, and redacts the response before it can be
 * observed. No method accepts tenant, principal, backend, connection, or
 * base-URL values from client-controlled input.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const NOT_FOUND_MESSAGE = 'Operation not found or not authorized.';

export function createOperationExecutor(options: ExecutorOptions): OperationExecutor {
  return new OperationExecutorImpl(options);
}

class OperationExecutorImpl implements OperationExecutor {
  private readonly limits: LimitsStore;
  private readonly audit: AuditLog;
  private readonly caches: CacheStore;
  private readonly circuitBreakers: CircuitBreakerStore;
  private readonly health: HealthStore;
  private readonly secrets: SecretResolver;
  private readonly upstreamAuth: UpstreamAuthRegistry;
  private readonly redactor: Redactor;
  private readonly validateResponses: boolean;

  constructor(options: ExecutorOptions) {
    this.limits = options.limits;
    this.audit = options.audit;
    this.caches = options.caches;
    this.circuitBreakers = options.circuitBreakers;
    this.health = options.health;
    this.secrets = options.secrets ?? defaultSecretResolver;
    this.upstreamAuth = options.upstreamAuth ?? defaultUpstreamAuthRegistry;
    this.redactor = options.redactor ?? defaultRedactor;
    this.validateResponses = options.validateResponses ?? false;
  }

  async execute(
    context: ExecuteContext,
    input: ExecuteOperationInput,
  ): Promise<ExecuteResult> {
    const { operation, connection, catalog } = this.authorize(
      context,
      input.operationId,
    );
    const operationId = input.operationId;

    if (needsConfirmation(operation)) {
      const expected = confirmationTokenFor(
        context.principal.id,
        operationId,
        input.arguments,
      );
      if (input.confirmationToken === undefined) {
        return {
          operationId,
          requiresConfirmation: true,
          token: expected,
          risk: confirmationRisk(operation.risk),
          message: `Operation "${operationId}" requires confirmation before execution.`,
        };
      }
      if (input.confirmationToken !== expected) {
        throw new PorticoError(
          'USAGE',
          'Confirmation token does not match the operation input.',
        );
      }
    }

    const validated = validateOperationArguments(operation, input.arguments);

    const tenantId = context.principal.tenantId;
    const policy = connection.policy ?? {};
    const rateKey = scopeKey(tenantId, connection.id, context.principal.id);
    if (policy.rateLimitPerMinute !== undefined) {
      const rate = this.limits.rateLimit(rateKey, policy.rateLimitPerMinute);
      if (!rate.allowed) {
        throw new PorticoError('API_ERROR', 'Connection rate limit exceeded.', {
          details: { retryAfterMs: rate.retryAfterMs },
        });
      }
    }

    const concurrencyKey = scopeKey(tenantId, connection.id);
    const concurrencyLimit =
      policy.maxConcurrency ?? operation.maxConcurrency ?? Number.POSITIVE_INFINITY;
    if (!this.limits.acquireConcurrency(concurrencyKey, concurrencyLimit)) {
      throw new PorticoError('API_ERROR', 'Connection concurrency limit reached.');
    }

    const circuitKey = scopeKey(tenantId, connection.id);
    if (this.circuitBreakers.state(circuitKey) === 'open') {
      this.limits.releaseConcurrency(concurrencyKey);
      throw new PorticoError(
        'API_ERROR',
        'Connection circuit breaker is open; refusing the call.',
      );
    }

    const startedAt = Date.now();
    try {
      const cacheKey = this.cacheKeyFor(
        context,
        connection,
        catalog,
        operationId,
        input,
      );
      if (cacheKey !== undefined) {
        const cached = this.caches.get(cacheKey);
        if (cached !== undefined) return cached as ExecuteOperationResult;
      }

      const result = await this.dispatch(
        context,
        operation,
        connection,
        validated,
        operationId,
        startedAt,
      );
      if (cacheKey !== undefined && result.status >= 200 && result.status < 300) {
        this.caches.set(cacheKey, result);
      }
      this.recordSuccess(context, connection, catalog, operationId, result);
      return result;
    } catch (error) {
      this.recordFailure(context, connection, catalog, operationId, error, startedAt);
      throw error;
    } finally {
      this.limits.releaseConcurrency(concurrencyKey);
    }
  }

  async executeBatch(
    context: ExecuteContext,
    inputs: ExecuteOperationInput[],
    options: BatchOptions = {},
  ): Promise<BatchResult> {
    const concurrency = Math.max(1, options.concurrency ?? 2);
    const failFast = options.failFast ?? false;
    const tokens = options.confirmationTokens ?? {};
    const results: BatchItemResult[] = new Array(inputs.length);
    let failed = 0;
    let aborted = false;
    let cursor = 0;

    const runWorker = async (): Promise<void> => {
      for (;;) {
        if (aborted) return;
        const index = cursor;
        cursor += 1;
        if (index >= inputs.length) return;
        const input = inputs[index];
        if (input === undefined) return;
        const operationId = input.operationId;
        const effective: ExecuteOperationInput =
          input.confirmationToken === undefined && tokens[operationId] !== undefined
            ? { ...input, confirmationToken: tokens[operationId] }
            : input;
        try {
          const result = await this.execute(context, effective);
          if (result.requiresConfirmation) {
            results[index] = {
              index,
              operationId,
              confirmation: {
                requiresConfirmation: true,
                token: result.token,
                risk: result.risk,
                message: result.message,
              },
            };
          } else {
            results[index] = { index, operationId, result };
          }
        } catch (error) {
          failed += 1;
          results[index] = { index, operationId, error: toBatchError(error) };
          if (failFast) aborted = true;
        }
      }
    };

    const workerCount = Math.min(concurrency, inputs.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    if (aborted) {
      for (let index = 0; index < inputs.length; index += 1) {
        if (results[index] === undefined) {
          failed += 1;
          results[index] = {
            index,
            operationId: inputs[index]?.operationId ?? '',
            error: {
              code: 'ABORTED',
              message: 'Batch aborted after an earlier failure.',
            },
          };
        }
      }
    }

    return { results, failed };
  }

  private authorize(
    context: ExecuteContext,
    operationId: string,
  ): { operation: CatalogOperation; connection: Connection; catalog: Catalog } {
    const principalRecord = context.snapshot.principal(context.principal.id);
    const connection =
      principalRecord === undefined
        ? undefined
        : context.snapshot.authorizeConnection(
            principalRecord,
            context.session.connectionId,
          );
    const catalog =
      connection === undefined
        ? undefined
        : context.snapshot.catalogForConnection(connection.id);
    const operation = catalog?.operations[operationId];
    if (
      principalRecord === undefined ||
      connection === undefined ||
      catalog === undefined ||
      operation === undefined ||
      !operation.enabled ||
      !operation.available
    ) {
      throw new PorticoError('NOT_FOUND', NOT_FOUND_MESSAGE);
    }
    return { operation, connection, catalog };
  }

  private cacheKeyFor(
    context: ExecuteContext,
    connection: Connection,
    catalog: Catalog,
    operationId: string,
    input: ExecuteOperationInput,
  ): string | undefined {
    const operation = catalog.operations[operationId];
    if (
      operation === undefined ||
      operation.cache?.eligible !== true ||
      operation.method !== 'GET'
    ) {
      return undefined;
    }
    return this.caches.key({
      tenantId: context.principal.tenantId,
      connectionId: connection.id,
      catalogChecksum: catalog.checksum,
      operationId,
      input: canonicalize(input.arguments),
      principalId: context.principal.id,
    });
  }

  private async dispatch(
    context: ExecuteContext,
    operation: CatalogOperation,
    connection: Connection,
    validated: ValidatedArguments,
    operationId: string,
    startedAt: number,
  ): Promise<ExecuteOperationResult> {
    const url = new URL(renderPath(operation.path, validated.path), connection.baseUrl);
    url.search = buildQuery(validated.query);

    const headers = new Map<string, string>();
    for (const [name, value] of Object.entries(validated.headers)) {
      headers.set(name.toLowerCase(), value);
    }
    for (const [name, value] of Object.entries(connection.staticHeaders ?? {})) {
      const resolved = await resolveSecretOrLiteral(value, this.secrets);
      if (resolved !== undefined) headers.set(name.toLowerCase(), resolved);
    }
    sanitizeUpstreamHeaders(headers);

    const request: UpstreamRequest = { url, headers, query: new Map() };
    const auth = this.upstreamAuth.toConnectionAuth(connection.auth);
    const provider = this.upstreamAuth.get(connection.auth.type);
    await provider.validate(auth);
    await provider.apply(request, auth, this.secrets);
    for (const [name, value] of request.query) {
      url.searchParams.set(name, value);
    }

    const encoded =
      validated.body === undefined
        ? undefined
        : encodeRequestBody(operation.request?.body?.kind ?? 'json', validated.body);
    const requestHeaders: Record<string, string> = Object.fromEntries(request.headers);
    const init: DispatchInit = {
      method: operation.method,
      headers: requestHeaders,
    };
    if (encoded?.body !== undefined) {
      init.body = encoded.body;
      requestHeaders['content-type'] =
        encoded.contentType ?? 'application/octet-stream';
    }

    const network = connection.network ?? {};
    const timeoutMs =
      connection.policy?.timeoutMs ?? operation.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxResponseBytes =
      connection.policy?.maxResponseBytes ??
      operation.maxResponseBytes ??
      DEFAULT_MAX_RESPONSE_BYTES;

    const dispatched = await dispatchUpstream(url, init, {
      timeoutMs,
      maxResponseBytes,
      network,
    });
    const durationMs = Date.now() - startedAt;

    const redactedHeaders = this.redactor.redactHeaders(dispatched.headers) as Record<
      string,
      string
    >;
    const contentType = dispatched.headers['content-type'];
    let body = buildResponseBody(dispatched.body, contentType);
    if (body?.kind === 'json' && body.data !== undefined) {
      body = {
        ...body,
        data: redactJsonData(body.data, operation.redactions, this.redactor),
      };
    }

    if (this.validateResponses) {
      this.validateResponse(operation, dispatched.status, body);
    }

    return {
      operationId,
      status: dispatched.status,
      headers: redactedHeaders,
      ...(contentType !== undefined ? { contentType } : {}),
      ...(body !== undefined ? { body } : {}),
      bytes: dispatched.body.length,
      truncated: dispatched.truncated,
      durationMs,
      requiresConfirmation: false,
    };
  }

  private validateResponse(
    operation: CatalogOperation,
    status: number,
    body: OperationResultBody | undefined,
  ): void {
    if (status < 200 || status >= 300 || body?.kind !== 'json') return;
    const responses = operation.responses ?? {};
    const response = responses[String(status)] ?? responses['default'];
    if (response?.schema === undefined) return;
    const validate = compileJsonSchema(response.schema);
    if (!validate(body.data)) {
      throw new PorticoError(
        'API_ERROR',
        'Upstream response failed schema validation.',
      );
    }
  }

  private recordSuccess(
    context: ExecuteContext,
    connection: Connection,
    catalog: Catalog,
    operationId: string,
    result: ExecuteOperationResult,
  ): void {
    const success = result.status >= 200 && result.status < 400;
    const circuitKey = scopeKey(context.principal.tenantId, connection.id);
    if (success) {
      this.circuitBreakers.onSuccess(circuitKey);
    } else {
      this.circuitBreakers.onFailure(circuitKey);
    }
    const errorCode = success
      ? undefined
      : result.status >= 400
        ? `HTTP_${result.status}`
        : undefined;
    this.health.record(context.principal.tenantId, connection.id, {
      ok: success,
      statusCode: result.status,
      durationMs: result.durationMs,
      ...(errorCode !== undefined ? { errorCode } : {}),
    });
    this.audit.record(
      newAuditEvent({
        tenantId: context.principal.tenantId,
        principalId: context.principal.id,
        connectionId: connection.id,
        backendId: connection.backendId,
        catalogChecksum: catalog.checksum,
        registryRevision: context.snapshot.revision,
        operation: operationId,
        action: 'call_operation',
        outcome: success ? 'success' : 'failure',
        durationMs: result.durationMs,
        ...(errorCode !== undefined ? { errorCode } : {}),
      }),
    );
  }

  private recordFailure(
    context: ExecuteContext,
    connection: Connection,
    catalog: Catalog,
    operationId: string,
    error: unknown,
    startedAt: number,
  ): void {
    const circuitKey = scopeKey(context.principal.tenantId, connection.id);
    this.circuitBreakers.onFailure(circuitKey);
    const errorCode = error instanceof PorticoError ? error.code : 'REQUEST_FAILED';
    const durationMs = Date.now() - startedAt;
    this.health.record(context.principal.tenantId, connection.id, {
      ok: false,
      durationMs,
      errorCode,
    });
    this.audit.record(
      newAuditEvent({
        tenantId: context.principal.tenantId,
        principalId: context.principal.id,
        connectionId: connection.id,
        backendId: connection.backendId,
        catalogChecksum: catalog.checksum,
        registryRevision: context.snapshot.revision,
        operation: operationId,
        action: 'call_operation',
        outcome: 'failure',
        durationMs,
        errorCode,
      }),
    );
  }
}

function needsConfirmation(operation: CatalogOperation): boolean {
  const confirmation = operation.confirmation;
  if (confirmation === 'always') return true;
  if (confirmation === 'write') return operation.risk !== 'read';
  if (confirmation === 'destructive') return operation.risk === 'destructive';
  return false;
}

function confirmationRisk(risk: CatalogOperation['risk']): 'write' | 'destructive' {
  return risk === 'destructive' ? 'destructive' : 'write';
}

function buildResponseBody(
  raw: Buffer,
  contentType: string | undefined,
): OperationResultBody | undefined {
  if (raw.length === 0 && contentType === undefined) return undefined;
  const mediaType = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (mediaType === 'application/json' || mediaType.endsWith('+json')) {
    try {
      return { kind: 'json', data: JSON.parse(raw.toString('utf8')) };
    } catch {
      return { kind: 'text', text: raw.toString('utf8') };
    }
  }
  if (mediaType.startsWith('text/')) {
    return { kind: 'text', text: raw.toString('utf8') };
  }
  return { kind: 'binary', base64: raw.toString('base64') };
}

function redactJsonData(
  data: unknown,
  rules: RedactionRule[] | undefined,
  baseRedactor: Redactor,
): unknown {
  let out = baseRedactor.redact(data);
  if (rules !== undefined) {
    const fields = rules.flatMap((rule) => rule.fields ?? []);
    if (fields.length > 0) {
      out = new Redactor({ sensitiveFields: fields }).redact(out);
    }
  }
  return out;
}

function toBatchError(error: unknown): { code: string; message: string } {
  if (error instanceof PorticoError) {
    if (error.code === 'NOT_FOUND' || error.code === 'AUTH') {
      return { code: error.code, message: NOT_FOUND_MESSAGE };
    }
    return { code: error.code, message: error.message };
  }
  return { code: 'INTERNAL', message: 'Internal execution error.' };
}
