import {
  defaultSecretResolver,
  isSecretReference,
  resolveSecretOrLiteral,
} from '../auth/secrets';
import {
  defaultUpstreamAuthRegistry,
  type UpstreamAuthRegistry,
} from '../auth/upstream';
import type { SecretResolver, UpstreamRequest } from '../auth/types';
import { newAuditEvent, type AuditLog } from '../audit/log';
import { canonicalize } from '../catalog/canonical';
import type {
  Catalog,
  CatalogOperation,
  ConfirmationPolicy,
  RedactionRule,
  SecurityScheme,
} from '../catalog/types';
import { scopeKey, type LimitsStore } from '../limits/store';
import type { Connection, ConnectionPolicy } from '../registry/types';
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
  assertSameOrigin,
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
const DEFAULT_MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const NOT_FOUND_MESSAGE = 'Operation not found or not authorized.';
const SECRET_REDACTION = '<redacted>';

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

    if (needsConfirmation(operation, connection.policy)) {
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
    if (
      connection.policy?.disabledOperations?.includes(operationId) === true ||
      !catalogOperationAuthSatisfied(catalog, operation, connection)
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
    // Catalog artifacts are operator-controlled, but a malformed path (for
    // example `//other.example/...` or a backslash escape) must never move a
    // request off the connection's configured origin. This is the last
    // defense before dispatch; redirects are separately policy-bound.
    assertSameOrigin(url, connection.baseUrl, 'CONFIG_ERROR');
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
    // Defense in depth: an auth provider may only keep its own credential
    // header; every other protected header is stripped again after injection.
    sanitizeUpstreamHeaders(request.headers, {
      allow:
        connection.auth.type === 'bearer' || connection.auth.type === 'basic'
          ? ['authorization']
          : [],
    });
    for (const [name, value] of request.query) {
      url.searchParams.set(name, value);
    }

    const maxRequestBytes =
      connection.policy?.maxRequestBytes ??
      operation.maxRequestBytes ??
      DEFAULT_MAX_REQUEST_BYTES;
    const encoded =
      validated.body === undefined
        ? undefined
        : encodeRequestBody(operation.request?.body?.kind ?? 'json', validated.body, {
            maxBytes: maxRequestBytes,
          });
    assertRequestContentTypeAllowed(
      connection.policy?.allowedContentTypes,
      encoded?.contentType,
    );
    const requestHeaders: Record<string, string> = Object.fromEntries(request.headers);
    const init: DispatchInit = {
      method: operation.method,
      headers: requestHeaders,
      redactQueryParams: request.secretQueryParams,
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

    const secrets = await collectUpstreamSecrets(connection, this.secrets);
    const redactionRules = [
      ...(connection.policy?.redactions ?? []),
      ...(operation.redactions ?? []),
    ];
    const redactedHeaders = redactResponseHeaders(
      dispatched.headers,
      redactionRules,
      this.redactor,
    );
    const contentType = dispatched.headers['content-type'];
    assertResponseContentTypeAllowed(
      connection.policy?.allowedContentTypes,
      dispatched.body,
      contentType,
    );
    const body = buildRedactedResponseBody(
      dispatched.body,
      contentType,
      redactionRules,
      secrets,
      this.redactor,
    );

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
        clientId: context.principal.clientId,
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
        clientId: context.principal.clientId,
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

function effectiveConfirmation(
  operation: CatalogOperation,
  policy: ConnectionPolicy | undefined,
): ConfirmationPolicy {
  return policy?.confirmation ?? operation.confirmation;
}

function needsConfirmation(
  operation: CatalogOperation,
  policy: ConnectionPolicy | undefined,
): boolean {
  const confirmation = effectiveConfirmation(operation, policy);
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

/**
 * Build the redacted response body for every body kind:
 * - JSON data is redacted by sensitive field names and by secret value;
 * - text is redacted by secret value;
 * - binary payloads have every occurrence of a resolved secret byte
 *   sequence replaced before base64 encoding.
 */
function buildRedactedResponseBody(
  raw: Buffer,
  contentType: string | undefined,
  rules: RedactionRule[],
  secrets: string[],
  baseRedactor: Redactor,
): OperationResultBody | undefined {
  const body = buildResponseBody(raw, contentType);
  if (body?.kind === 'json' && body.data !== undefined) {
    const data = redactDataSecrets(
      redactJsonData(body.data, rules, baseRedactor),
      secrets,
    );
    return { ...body, data };
  }
  if (body?.kind === 'text' && body.text !== undefined) {
    return { ...body, text: redactStringSecrets(body.text, secrets) };
  }
  if (body?.kind === 'binary') {
    return {
      ...body,
      base64: redactBufferSecrets(raw, secrets).toString('base64'),
    };
  }
  return body;
}

function redactResponseHeaders(
  headers: Record<string, string>,
  rules: RedactionRule[],
  baseRedactor: Redactor,
): Record<string, string> {
  let redacted = baseRedactor.redactHeaders(headers) as Record<string, string>;
  const headerNames = rules.flatMap((rule) => rule.headers ?? []);
  if (headerNames.length > 0) {
    redacted = new Redactor({ sensitiveHeaders: headerNames }).redactHeaders(
      redacted,
    ) as Record<string, string>;
  }
  return redacted;
}

/** Resolve every credential the connection may have sent upstream. */
async function collectUpstreamSecrets(
  connection: Connection,
  secrets: SecretResolver,
): Promise<string[]> {
  const values: string[] = [];
  const resolve = (reference: string): Promise<string | undefined> =>
    secrets.resolve(reference);
  switch (connection.auth.type) {
    case 'bearer': {
      const token = await resolve(connection.auth.tokenRef);
      if (token !== undefined) values.push(token, `Bearer ${token}`);
      break;
    }
    case 'apiKey': {
      const value = await resolve(connection.auth.valueRef);
      if (value !== undefined) values.push(value);
      break;
    }
    case 'basic': {
      const username = await resolve(connection.auth.usernameRef);
      const password = await resolve(connection.auth.passwordRef);
      if (username !== undefined) values.push(username);
      if (password !== undefined) values.push(password);
      if (username !== undefined && password !== undefined) {
        const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString(
          'base64',
        );
        values.push(encoded, `Basic ${encoded}`);
      }
      break;
    }
    case 'staticHeaders':
      for (const value of Object.values(connection.auth.headers)) {
        if (isSecretReference(value)) {
          const resolved = await resolve(value);
          if (resolved !== undefined) values.push(resolved);
        }
      }
      break;
    case 'none':
      break;
  }
  for (const value of Object.values(connection.staticHeaders ?? {})) {
    if (isSecretReference(value)) {
      const resolved = await resolve(value);
      if (resolved !== undefined) values.push(resolved);
    }
  }
  return [...new Set(values)]
    .filter((value) => value.length >= 4)
    .sort((left, right) => right.length - left.length);
}

function redactStringSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    out = out.split(secret).join(SECRET_REDACTION);
  }
  return out;
}

function redactDataSecrets(data: unknown, secrets: string[]): unknown {
  if (typeof data === 'string') return redactStringSecrets(data, secrets);
  if (Array.isArray(data)) {
    return data.map((item) => redactDataSecrets(item, secrets));
  }
  if (data !== null && typeof data === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      out[key] = redactDataSecrets(value, secrets);
    }
    return out;
  }
  return data;
}

/** Replace every occurrence of a resolved secret's UTF-8 bytes with '*'. */
function redactBufferSecrets(raw: Buffer, secrets: string[]): Buffer {
  const out = Buffer.from(raw);
  for (const secret of secrets) {
    const needle = Buffer.from(secret, 'utf8');
    if (needle.byteLength === 0 || needle.byteLength > out.byteLength) continue;
    const replacement = Buffer.alloc(needle.byteLength, 0x2a);
    let searchFrom = 0;
    for (;;) {
      const at = out.indexOf(needle, searchFrom);
      if (at === -1) break;
      replacement.copy(out, at);
      searchFrom = at + needle.byteLength;
    }
  }
  return out;
}

function mediaTypeOf(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function assertRequestContentTypeAllowed(
  allowed: string[] | undefined,
  contentType: string | undefined,
): void {
  if (allowed === undefined || contentType === undefined) return;
  const media = mediaTypeOf(contentType);
  if (media === '' || !allowed.some((entry) => entry.toLowerCase() === media)) {
    throw new PorticoError(
      'USAGE',
      'Request content type is not allowed by the connection policy.',
    );
  }
}

function assertResponseContentTypeAllowed(
  allowed: string[] | undefined,
  raw: Buffer,
  contentType: string | undefined,
): void {
  if (allowed === undefined) return;
  if (raw.length === 0 && contentType === undefined) return;
  const media = mediaTypeOf(contentType);
  if (media === '' || !allowed.some((entry) => entry.toLowerCase() === media)) {
    throw new PorticoError(
      'API_ERROR',
      'Response content type is not allowed by the connection policy.',
    );
  }
}

/**
 * A catalog operation's security requirements are satisfiable when at least
 * one alternative is fully covered by the connection's auth type. Mirrors
 * the registry validator's compatibility rule so execution enforces exact
 * auth/catalog compatibility even for programmatically built snapshots.
 */
export function catalogOperationAuthSatisfied(
  catalog: Catalog,
  operation: CatalogOperation,
  connection: Connection,
): boolean {
  if (operation.security.length === 0) return true;
  return operation.security.some((alternative) =>
    alternative.every((schemeName) => {
      const scheme = catalog.securitySchemes[schemeName];
      return scheme !== undefined && connectionSatisfiesScheme(connection, scheme);
    }),
  );
}

function connectionSatisfiesScheme(
  connection: Connection,
  scheme: SecurityScheme,
): boolean {
  switch (scheme.type) {
    case 'http':
      if (scheme.scheme === 'bearer') return connection.auth.type === 'bearer';
      if (scheme.scheme === 'basic') return connection.auth.type === 'basic';
      return false;
    case 'apiKey':
      return connection.auth.type === 'apiKey';
    case 'oauth2':
    case 'openIdConnect':
    case 'mutualTLS':
      return false;
  }
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
