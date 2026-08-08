/**
 * Fixed MCP toolset for MCP Portico.
 *
 * Every tool is a named, schema-described handler bound to the authenticated
 * principal and a `ToolContext` exposing the tenant runtime plus a
 * server-side active-session registry keyed by principal id. Sessions are
 * created by `select_connection` and re-validated against the current
 * registry snapshot on every use.
 */

import type { PorticoPrincipal } from '../auth/types';
import { CatalogIndex } from '../catalog/index';
import type { CatalogOperation, RiskLevel } from '../catalog/types';
import type {
  BatchItemResult,
  ExecuteOperationInput,
  ExecuteResult,
} from '../runtime/execution';
import type { TenantRuntime, TestConnectionOptions } from '../runtime/tenant';
import type { SessionState } from '../session/store';
import { isPorticoError, PorticoError } from '../shared/errors';

export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpToolResult {
  content: McpTextContent[];
  isError?: boolean;
}

/** Server-side active session registry keyed by principal id. */
export interface ActiveSessionRegistry {
  get(principalId: string): SessionState | undefined;
  set(principalId: string, session: SessionState): void;
  clear(principalId: string): void;
}

export class ActiveSessionStore implements ActiveSessionRegistry {
  private readonly sessions = new Map<string, SessionState>();

  get(principalId: string): SessionState | undefined {
    return this.sessions.get(principalId);
  }

  set(principalId: string, session: SessionState): void {
    this.sessions.set(principalId, session);
  }

  clear(principalId: string): void {
    this.sessions.delete(principalId);
  }

  clearAll(): void {
    this.sessions.clear();
  }
}

export interface ToolContext {
  runtime: TenantRuntime;
  sessions: ActiveSessionRegistry;
}

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema draft-2020-12 object schema for `arguments`. */
  inputSchema: Record<string, unknown>;
  handler(
    principal: PorticoPrincipal,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<McpToolResult>;
}

const RISK_LEVELS: readonly RiskLevel[] = ['read', 'write', 'destructive'];
const CALL_OPERATIONS_CONCURRENCY = 2;

const GENERIC_NOT_FOUND = 'Operation not found or not authorized.';
const GENERIC_AUTH = 'Invalid credentials.';

/** Build a single-text-block tool result. */
export function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], isError };
}

/**
 * Map an error to a safe tool-facing message. NOT_FOUND and AUTH never
 * enumerate resources or echo credentials.
 */
export function toolErrorMessage(error: unknown): string {
  if (isPorticoError(error)) {
    if (error.code === 'NOT_FOUND') return GENERIC_NOT_FOUND;
    if (error.code === 'AUTH') return GENERIC_AUTH;
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Build an error tool result with a safe, non-enumerating message. */
export function toolErrorResult(error: unknown): McpToolResult {
  return { content: [{ type: 'text', text: toolErrorMessage(error) }], isError: true };
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value === '') {
    throw new PorticoError('USAGE', `Missing required argument "${name}".`);
  }
  return value;
}

function requireSession(principal: PorticoPrincipal, ctx: ToolContext): SessionState {
  const session = ctx.sessions.get(principal.id);
  if (session === undefined) {
    throw new PorticoError('USAGE', 'No active session; select a connection first.');
  }
  try {
    return ctx.runtime.assertSession(session, principal);
  } catch (error) {
    // A stale or revoked session must not linger in the per-principal cache:
    // drop it so the client selects a connection again on the next call.
    if (isPorticoError(error) && error.code === 'AUTH') {
      ctx.sessions.clear(principal.id);
    }
    throw error;
  }
}

function catalogIndexFor(session: SessionState, ctx: ToolContext): CatalogIndex {
  const catalog = ctx.runtime.snapshot.catalogForConnection(session.connectionId);
  if (catalog === undefined) {
    throw new PorticoError('CONFIG_ERROR', 'Active session connection has no catalog.');
  }
  return new CatalogIndex(catalog);
}

function sessionView(session: SessionState): {
  id: string;
  tenantId: string;
  connectionId: string;
  catalogChecksum: string;
} {
  return {
    id: session.id,
    tenantId: session.tenantId,
    connectionId: session.connectionId,
    catalogChecksum: session.catalogChecksum,
  };
}

async function handleListConnections(
  principal: PorticoPrincipal,
  _args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<McpToolResult> {
  const connections = ctx.runtime.authorizedConnections(principal);
  return textResult(
    JSON.stringify({
      connections: connections.map((connection) => ({
        id: connection.id,
        backendId: connection.backendId,
        baseUrl: connection.baseUrl,
      })),
    }),
  );
}

async function handleSelectConnection(
  principal: PorticoPrincipal,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<McpToolResult> {
  const connectionId = requiredString(args, 'connectionId');
  const session = ctx.runtime.selectConnection(
    { principal, authMethod: 'static-bearer' },
    connectionId,
  );
  ctx.sessions.set(principal.id, session);
  return textResult(JSON.stringify({ session: sessionView(session) }));
}

async function handleGetSession(
  principal: PorticoPrincipal,
  _args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<McpToolResult> {
  const session = requireSession(principal, ctx);
  return textResult(JSON.stringify({ session: sessionView(session) }));
}

async function handleSearchOperations(
  principal: PorticoPrincipal,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<McpToolResult> {
  const session = requireSession(principal, ctx);
  const index = catalogIndexFor(session, ctx);

  const query = args.query === undefined ? undefined : String(args.query);
  const tag = args.tag === undefined ? undefined : String(args.tag);
  const risk = args.risk === undefined ? undefined : String(args.risk);
  if (risk !== undefined && !(RISK_LEVELS as readonly string[]).includes(risk)) {
    throw new PorticoError(
      'USAGE',
      `Invalid risk "${risk}"; expected one of: read, write, destructive.`,
    );
  }

  let ids = index.ids();
  if (tag !== undefined) {
    const tagged = new Set(index.byTag(tag));
    ids = ids.filter((id) => tagged.has(id));
  }
  if (risk !== undefined) {
    const risky = new Set(index.byRisk(risk as RiskLevel));
    ids = ids.filter((id) => risky.has(id));
  }
  if (query !== undefined && query !== '') {
    const needle = query.toLowerCase();
    ids = ids.filter((id) => {
      const operation = index.get(id);
      if (operation === undefined) return false;
      return (
        id.toLowerCase().includes(needle) ||
        (operation.summary ?? '').toLowerCase().includes(needle) ||
        (operation.description ?? '').toLowerCase().includes(needle)
      );
    });
  }

  const operations = ids.map((id) => {
    const operation = index.get(id) as CatalogOperation;
    return {
      operationId: id,
      method: operation.method,
      path: operation.path,
      summary: operation.summary,
      risk: operation.risk,
      available: operation.available,
    };
  });
  return textResult(JSON.stringify({ operations }));
}

async function handleDescribeOperation(
  principal: PorticoPrincipal,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<McpToolResult> {
  const session = requireSession(principal, ctx);
  const index = catalogIndexFor(session, ctx);
  const operationId = requiredString(args, 'operationId');
  const operation = index.get(operationId);
  if (operation === undefined) {
    throw new PorticoError('NOT_FOUND', GENERIC_NOT_FOUND);
  }
  return textResult(JSON.stringify({ operation: { operationId, ...operation } }));
}

function operationInput(
  operationId: string,
  rawArguments: unknown,
  confirmationToken: unknown,
): ExecuteOperationInput {
  let argumentsValue: Record<string, unknown>;
  if (rawArguments === undefined) {
    argumentsValue = {};
  } else if (
    typeof rawArguments === 'object' &&
    rawArguments !== null &&
    !Array.isArray(rawArguments)
  ) {
    argumentsValue = rawArguments as Record<string, unknown>;
  } else {
    throw new PorticoError('USAGE', 'Argument "arguments" must be an object.');
  }
  return {
    operationId,
    arguments: argumentsValue,
    ...(confirmationToken !== undefined
      ? { confirmationToken: String(confirmationToken) }
      : {}),
  };
}

async function handleCallOperation(
  principal: PorticoPrincipal,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<McpToolResult> {
  const session = requireSession(principal, ctx);
  const operationId = requiredString(args, 'operationId');
  const input = operationInput(operationId, args.arguments, args.confirmationToken);
  const result = await ctx.runtime.executeOperation(session, principal, input);
  return executionResult(result);
}

function executionResult(result: ExecuteResult): McpToolResult {
  if (result.requiresConfirmation) {
    return textResult(
      JSON.stringify({
        operationId: result.operationId,
        requiresConfirmation: true,
        token: result.token,
        risk: result.risk,
        message: result.message,
      }),
    );
  }

  const content: McpTextContent[] = [];
  const body = result.body;
  if (body !== undefined) {
    if (body.kind === 'json') {
      content.push({ type: 'text', text: JSON.stringify(body.data, null, 2) });
    } else if (body.kind === 'text') {
      content.push({ type: 'text', text: body.text ?? '' });
    } else {
      // Binary payloads are base64-encoded; the content type rides alongside.
      content.push({
        type: 'text',
        text: JSON.stringify({
          contentType: result.contentType,
          base64: body.base64,
        }),
      });
    }
  }
  const metadata = [
    `status: ${result.status}`,
    `bytes: ${result.bytes}`,
    `durationMs: ${result.durationMs}`,
  ];
  if (result.truncated) metadata.push('truncated: true');
  if (result.contentType !== undefined) {
    metadata.push(`contentType: ${result.contentType}`);
  }
  content.push({ type: 'text', text: metadata.join('; ') });
  return { content, isError: false };
}

interface BatchItemSpec {
  operationId: string;
  arguments?: Record<string, unknown>;
  confirmationToken?: string;
}

function asBatchItem(value: unknown): BatchItemSpec | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.operationId !== 'string' || record.operationId === '') {
    return undefined;
  }
  let argumentsValue: Record<string, unknown> | undefined;
  if (record.arguments !== undefined) {
    if (
      typeof record.arguments !== 'object' ||
      record.arguments === null ||
      Array.isArray(record.arguments)
    ) {
      return undefined;
    }
    argumentsValue = record.arguments as Record<string, unknown>;
  }
  const confirmationToken =
    typeof record.confirmationToken === 'string' ? record.confirmationToken : undefined;
  return {
    operationId: record.operationId,
    ...(argumentsValue !== undefined ? { arguments: argumentsValue } : {}),
    ...(confirmationToken !== undefined ? { confirmationToken } : {}),
  };
}

function errorCodeOf(error: unknown): string {
  return isPorticoError(error) ? error.code : 'INTERNAL';
}

async function handleCallOperations(
  principal: PorticoPrincipal,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<McpToolResult> {
  const raw = args.operations;
  if (!Array.isArray(raw)) {
    throw new PorticoError('USAGE', 'Missing required argument "operations".');
  }
  const session = requireSession(principal, ctx);
  const specs = raw.map((item) => asBatchItem(item));
  const results: BatchItemResult[] = [];
  let failed = 0;
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= specs.length) return;
      const spec = specs[index];
      const operationId = spec?.operationId ?? '';
      try {
        if (spec === undefined) {
          throw new PorticoError(
            'USAGE',
            'Each batch item requires a string "operationId".',
          );
        }
        const result = await ctx.runtime.executeOperation(session, principal, {
          operationId: spec.operationId,
          arguments: spec.arguments ?? {},
          ...(spec.confirmationToken !== undefined
            ? { confirmationToken: spec.confirmationToken }
            : {}),
        });
        if (result.requiresConfirmation) {
          results.push({
            index,
            operationId,
            confirmation: {
              requiresConfirmation: true,
              token: result.token,
              risk: result.risk,
              message: result.message,
            },
          });
        } else {
          results.push({ index, operationId, result });
        }
      } catch (error) {
        failed += 1;
        results.push({
          index,
          operationId,
          error: { code: errorCodeOf(error), message: toolErrorMessage(error) },
        });
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(CALL_OPERATIONS_CONCURRENCY, specs.length) },
    () => worker(),
  );
  await Promise.all(workers);
  results.sort((left, right) => left.index - right.index);
  return textResult(JSON.stringify({ results, failed }));
}

async function handleTestConnection(
  principal: PorticoPrincipal,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<McpToolResult> {
  const connectionId = requiredString(args, 'connectionId');
  const options: TestConnectionOptions = {};
  if (args.method !== undefined) options.method = String(args.method);
  if (args.path !== undefined) options.path = String(args.path);
  const result = await ctx.runtime.testConnection(principal, connectionId, options);
  return textResult(
    JSON.stringify({
      ok: result.ok,
      status: result.status,
      durationMs: result.durationMs,
      bytes: result.bytes,
      finalUrl: result.finalUrl,
      ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
      truncated: result.truncated,
      redirected: result.redirected,
    }),
  );
}

const emptyObjectSchema: Record<string, unknown> = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

/**
 * The 8 fixed MCP tools. Order is stable and exposed by `tools/list`.
 */
export const FIXED_TOOLS: readonly McpTool[] = [
  {
    name: 'list_connections',
    description:
      'List the connections the authenticated principal is authorized to select.',
    inputSchema: emptyObjectSchema,
    handler: handleListConnections,
  },
  {
    name: 'select_connection',
    description: 'Select a connection and create the active session for the principal.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: {
          type: 'string',
          description: 'Connection id to select.',
        },
      },
      required: ['connectionId'],
      additionalProperties: false,
    },
    handler: handleSelectConnection,
  },
  {
    name: 'get_session',
    description:
      "Return the principal's active session, re-validated against the registry.",
    inputSchema: emptyObjectSchema,
    handler: handleGetSession,
  },
  {
    name: 'search_operations',
    description:
      "Search the active connection's catalog by tag, risk, or free-text query.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive text query.' },
        tag: { type: 'string', description: 'Catalog tag to filter by.' },
        risk: {
          type: 'string',
          enum: ['read', 'write', 'destructive'],
          description: 'Risk level to filter by.',
        },
      },
      additionalProperties: false,
    },
    handler: handleSearchOperations,
  },
  {
    name: 'describe_operation',
    description: 'Return the full catalog definition of one operation.',
    inputSchema: {
      type: 'object',
      properties: {
        operationId: {
          type: 'string',
          description: 'Stable catalog operation id.',
        },
      },
      required: ['operationId'],
      additionalProperties: false,
    },
    handler: handleDescribeOperation,
  },
  {
    name: 'call_operation',
    description:
      'Execute one catalog operation. Write operations return a confirmation token on first call.',
    inputSchema: {
      type: 'object',
      properties: {
        operationId: {
          type: 'string',
          description: 'Stable catalog operation id.',
        },
        arguments: {
          type: 'object',
          description: 'Named path/query/header/body arguments.',
        },
        confirmationToken: {
          type: 'string',
          description: 'Token from a previous confirmation result.',
        },
      },
      required: ['operationId'],
      additionalProperties: false,
    },
    handler: handleCallOperation,
  },
  {
    name: 'call_operations',
    description:
      'Execute a batch of operations with bounded concurrency and per-item failures.',
    inputSchema: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              operationId: { type: 'string' },
              arguments: { type: 'object' },
              confirmationToken: { type: 'string' },
            },
            required: ['operationId'],
            additionalProperties: false,
          },
        },
      },
      required: ['operations'],
      additionalProperties: false,
    },
    handler: handleCallOperations,
  },
  {
    name: 'test_connection',
    description:
      'Probe a connection under its network and auth policy (operator health check).',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: {
          type: 'string',
          description: 'Connection id to probe.',
        },
        method: {
          type: 'string',
          description: 'HTTP method (default GET).',
        },
        path: {
          type: 'string',
          description: 'Request path (default /).',
        },
      },
      required: ['connectionId'],
      additionalProperties: false,
    },
    handler: handleTestConnection,
  },
];
