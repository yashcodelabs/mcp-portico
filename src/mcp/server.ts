/**
 * MCP streamable-HTTP transport handler.
 *
 * One endpoint (`POST /mcp`) speaks JSON-RPC 2.0. `initialize` is
 * unauthenticated; `tools/*` and `resources/*` require an
 * `Authorization: Bearer mpp_...` Portico API key. Application failures are
 * reported with JSON-RPC error codes in the -320xx server range and the
 * matching Portico code in `error.data`.
 *
 * Identity boundaries are server-owned: tenant, principal, and client
 * identity come exclusively from the authenticated credential, and every
 * tool call re-validates its arguments against the advertised input schema
 * so tenant/principal/connection/origin override keys are rejected.
 *
 * The transport is request/response only (no SSE), so the server never
 * pushes notifications: `capabilities` advertises exactly the surface that
 * works over the current JSON-RPC exchange. Resource payloads embed the
 * registry revision so clients can detect reloads and re-read metadata.
 */

import type { PorticoAuthResult, PorticoPrincipal } from '../auth/types';
import type { TenantRuntime } from '../runtime/tenant';
import { PRODUCT_VERSION } from '../shared/brand';
import { summarizeAudit } from '../telemetry/summary';
import {
  errorResponse,
  JSONRPC_ERROR_CODES,
  MCP_ERROR_CODES,
  parseJsonRpc,
  success,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcResponse,
} from './jsonrpc';
import {
  ActiveSessionStore,
  assertToolArgumentsValid,
  FIXED_TOOLS,
  toolErrorMessage,
  type ActiveSessionRegistry,
  type McpTool,
  type ToolContext,
} from './tools';

export interface McpHttpResponse {
  status: number;
  body: string;
  contentType: string;
}

const MCP_PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'mcp-portico', version: PRODUCT_VERSION };
const USAGE_RESOURCE_URI = 'mcp-portico://usage';
const APIS_RESOURCE_URI = 'mcp-portico://apis';

type AuthOk = {
  kind: 'ok';
  principal: PorticoPrincipal;
  runtime: TenantRuntime;
  /** The full authenticated credential result for this request. */
  auth: PorticoAuthResult;
};

type AuthResult =
  AuthOk | { kind: 'error'; status: number; response: JsonRpcErrorResponse };

interface ConnectionResourceView {
  id: string;
  backendId: string;
  baseUrl: string;
  catalog?: {
    apiId: string;
    title: string;
    version: string;
    checksum: string;
    totals: { operations: number; available: number; enabled: number };
    operations: Array<{
      operationId: string;
      method: string;
      path: string;
      risk: string;
      available: boolean;
      enabled: boolean;
    }>;
  };
}

export class McpServer {
  readonly tools: readonly McpTool[] = FIXED_TOOLS;
  private readonly sessions: ActiveSessionRegistry = new ActiveSessionStore();

  constructor(private readonly runtime: TenantRuntime | undefined) {}

  /**
   * Handle one HTTP request body for `POST /mcp`. Returns an HTTP status, a
   * JSON-RPC response body (empty for notifications), and the content type.
   */
  async handleHttp(
    bodyText: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<McpHttpResponse> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return this.respond(
        400,
        errorResponse(null, JSONRPC_ERROR_CODES.PARSE_ERROR, 'Parse error'),
      );
    }

    const { request, error } = parseJsonRpc(parsed);
    if (error !== undefined) return this.respond(400, error);
    if (request === undefined) {
      return this.respond(
        400,
        errorResponse(null, JSONRPC_ERROR_CODES.INVALID_REQUEST, 'Invalid Request'),
      );
    }

    const { method, id } = request;
    if (method === 'notifications/initialized') {
      return this.accepted();
    }
    if (id === undefined) {
      // Unrecognized notification: acknowledge without a response body.
      return this.accepted();
    }

    switch (method) {
      case 'initialize':
        return this.respond(
          200,
          success(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {
              tools: {},
              // Resources are list/read only. subscribe and listChanged are
              // intentionally not advertised: this transport cannot push
              // server-to-client notifications, so clients detect changes
              // by comparing `registryRevision` in resource payloads.
              resources: {},
            },
            serverInfo: SERVER_INFO,
          }),
        );
      case 'tools/list':
        return this.handleToolsList(id, headers);
      case 'tools/call':
        return this.handleToolsCall(id, headers, request.params);
      case 'resources/list':
        return this.handleResourcesList(id, headers);
      case 'resources/read':
        return this.handleResourcesRead(id, headers, request.params);
      default:
        return this.respond(
          200,
          errorResponse(id, JSONRPC_ERROR_CODES.METHOD_NOT_FOUND, 'Method not found'),
        );
    }
  }

  private async handleToolsList(
    id: JsonRpcId,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<McpHttpResponse> {
    const auth = await this.authenticate(id, headers);
    if (auth.kind === 'error') return this.respond(auth.status, auth.response);
    return this.respond(
      200,
      success(id, {
        tools: this.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      }),
    );
  }

  private async handleToolsCall(
    id: JsonRpcId,
    headers: Record<string, string | string[] | undefined>,
    params: unknown,
  ): Promise<McpHttpResponse> {
    const auth = await this.authenticate(id, headers);
    if (auth.kind === 'error') return this.respond(auth.status, auth.response);

    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      return this.respond(
        200,
        errorResponse(id, JSONRPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params'),
      );
    }
    const record = params as Record<string, unknown>;
    const name = record.name;
    if (typeof name !== 'string' || name === '') {
      return this.respond(
        200,
        errorResponse(id, JSONRPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params'),
      );
    }

    const tool = this.tools.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      return this.respond(
        200,
        errorResponse(id, JSONRPC_ERROR_CODES.INVALID_PARAMS, 'Unknown tool'),
      );
    }

    let args: Record<string, unknown>;
    const rawArgs = record.arguments;
    if (rawArgs === undefined) {
      args = {};
    } else if (
      typeof rawArgs === 'object' &&
      rawArgs !== null &&
      !Array.isArray(rawArgs)
    ) {
      args = rawArgs as Record<string, unknown>;
    } else {
      return this.respond(
        200,
        errorResponse(id, JSONRPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params'),
      );
    }

    const ctx: ToolContext = {
      runtime: auth.runtime,
      sessions: this.sessions,
      auth: auth.auth,
    };
    try {
      // Server-side schema enforcement: identity/connection/origin override
      // keys are rejected before any handler can observe them.
      assertToolArgumentsValid(tool, args);
      const result = await tool.handler(auth.principal, args, ctx);
      return this.respond(200, success(id, result));
    } catch (error) {
      // Tool-level failures are successful JSON-RPC results with isError.
      return this.respond(
        200,
        success(id, {
          content: [{ type: 'text', text: toolErrorMessage(error) }],
          isError: true,
        }),
      );
    }
  }

  private async authenticate(
    id: JsonRpcId,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AuthResult> {
    if (this.runtime === undefined) {
      return {
        kind: 'error',
        status: 500,
        response: errorResponse(id, MCP_ERROR_CODES.CONFIG, 'No runtime configured.', {
          code: 'CONFIG_ERROR',
        }),
      };
    }
    const header = headerValue(headers, 'authorization');
    const match = header === undefined ? undefined : /^Bearer\s+(.+)$/i.exec(header);
    const credential = match?.[1]?.trim();
    if (credential === undefined || credential === '') {
      return this.authFailure(id);
    }
    try {
      const auth = await this.runtime.authenticate(credential);
      this.revalidateActiveSession(auth.principal);
      return {
        kind: 'ok',
        principal: auth.principal,
        runtime: this.runtime,
        auth,
      };
    } catch {
      return this.authFailure(id);
    }
  }

  /**
   * Re-validate the principal's cached active session against the current
   * snapshot after every successful authentication. A registry reload or a
   * principal/connection revocation invalidates the canonical session store
   * eagerly; this clears the per-principal cache so the client must select a
   * connection again instead of reusing a stale session.
   */
  private revalidateActiveSession(principal: PorticoPrincipal): void {
    if (this.runtime === undefined) return;
    const session = this.sessions.get(principal.id);
    if (session === undefined) return;
    try {
      this.runtime.assertSession(session, principal);
    } catch {
      this.sessions.clear(principal.id);
    }
  }

  private async handleResourcesList(
    id: JsonRpcId,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<McpHttpResponse> {
    const auth = await this.authenticate(id, headers);
    if (auth.kind === 'error') return this.respond(auth.status, auth.response);
    const connections = auth.runtime.authorizedConnections(auth.principal);
    const resources = [
      {
        uri: USAGE_RESOURCE_URI,
        name: 'Usage summary',
        description:
          'Tenant-scoped usage summary from in-memory audit events; not persisted and resets on restart.',
        mimeType: 'application/json',
      },
      {
        uri: APIS_RESOURCE_URI,
        name: 'API Explorer',
        description:
          "Metadata for the authenticated principal's authorized connections and catalogs.",
        mimeType: 'application/json',
      },
      ...connections.map((connection) => ({
        uri: connectionResourceUri(connection.id),
        name: `API: ${connection.id}`,
        description: 'Catalog and connection metadata for one authorized connection.',
        mimeType: 'application/json',
      })),
    ];
    return this.respond(200, success(id, { resources }));
  }

  private async handleResourcesRead(
    id: JsonRpcId,
    headers: Record<string, string | string[] | undefined>,
    params: unknown,
  ): Promise<McpHttpResponse> {
    const auth = await this.authenticate(id, headers);
    if (auth.kind === 'error') return this.respond(auth.status, auth.response);
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      return this.respond(
        200,
        errorResponse(id, JSONRPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params'),
      );
    }
    const uri = (params as Record<string, unknown>).uri;
    if (typeof uri !== 'string' || uri === '') {
      return this.respond(
        200,
        errorResponse(id, JSONRPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params'),
      );
    }
    const content = this.resourceContent(auth, uri);
    if (content === undefined) {
      // Same shape for unknown, unauthorized, and cross-tenant URIs.
      return this.respond(
        200,
        errorResponse(id, JSONRPC_ERROR_CODES.INVALID_PARAMS, 'Unknown resource'),
      );
    }
    return this.respond(200, success(id, { contents: [content] }));
  }

  private resourceContent(
    auth: AuthOk,
    uri: string,
  ): { uri: string; mimeType: string; text: string } | undefined {
    const revision = auth.runtime.snapshot.revision;
    if (uri === USAGE_RESOURCE_URI) {
      const events = auth.runtime.audit.forTenant(auth.principal.tenantId);
      const summary = summarizeAudit(events, {
        tenantId: auth.principal.tenantId,
      });
      return resourceContents(uri, {
        resource: 'usage',
        tenantId: auth.principal.tenantId,
        registryRevision: revision,
        ...summary,
      });
    }
    if (uri === APIS_RESOURCE_URI) {
      return resourceContents(uri, {
        resource: 'apis',
        tenantId: auth.principal.tenantId,
        registryRevision: revision,
        connections: this.connectionViews(auth),
      });
    }
    const match = /^mcp-portico:\/\/apis\/([^/]+)$/.exec(uri);
    if (match !== null) {
      const connectionId = decodeURIComponent(match[1] ?? '');
      const connection = this.connectionViews(auth).find(
        (candidate) => candidate.id === connectionId,
      );
      if (connection === undefined) return undefined;
      return resourceContents(uri, {
        resource: 'connection',
        tenantId: auth.principal.tenantId,
        registryRevision: revision,
        connection,
      });
    }
    return undefined;
  }

  private connectionViews(auth: AuthOk): ConnectionResourceView[] {
    const runtime = auth.runtime;
    return runtime.authorizedConnections(auth.principal).map((connection) => {
      const catalog = runtime.snapshot.catalogForConnection(connection.id);
      return {
        id: connection.id,
        backendId: connection.backendId,
        baseUrl: connection.baseUrl,
        catalog:
          catalog === undefined
            ? undefined
            : {
                apiId: catalog.api.id,
                title: catalog.api.title,
                version: catalog.api.version,
                checksum: catalog.checksum,
                totals: {
                  operations: Object.keys(catalog.operations).length,
                  available: Object.values(catalog.operations).filter(
                    (operation) => operation.available,
                  ).length,
                  enabled: Object.values(catalog.operations).filter(
                    (operation) => operation.enabled,
                  ).length,
                },
                operations: Object.entries(catalog.operations)
                  .map(([operationId, operation]) => ({
                    operationId,
                    method: operation.method,
                    path: operation.path,
                    risk: operation.risk,
                    available: operation.available,
                    enabled: operation.enabled,
                  }))
                  .sort((left, right) =>
                    left.operationId.localeCompare(right.operationId),
                  ),
              },
      };
    });
  }

  private authFailure(id: JsonRpcId): AuthResult {
    return {
      kind: 'error',
      status: 401,
      response: errorResponse(id, MCP_ERROR_CODES.AUTH, 'Invalid credentials.', {
        code: 'AUTH',
      }),
    };
  }

  private respond(status: number, response: JsonRpcResponse): McpHttpResponse {
    return {
      status,
      body: JSON.stringify(response),
      contentType: 'application/json',
    };
  }

  private accepted(): McpHttpResponse {
    return { status: 202, body: '', contentType: 'application/json' };
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (value === undefined) return undefined;
    return Array.isArray(value) ? (value[0] ?? undefined) : value;
  }
  return undefined;
}

function connectionResourceUri(connectionId: string): string {
  return `${APIS_RESOURCE_URI}/${encodeURIComponent(connectionId)}`;
}

function resourceContents(
  uri: string,
  payload: unknown,
): { uri: string; mimeType: string; text: string } {
  return {
    uri,
    mimeType: 'application/json',
    text: JSON.stringify(payload, null, 2),
  };
}
