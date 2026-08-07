/**
 * MCP streamable-HTTP transport handler.
 *
 * One endpoint (`POST /mcp`) speaks JSON-RPC 2.0. `initialize` is
 * unauthenticated; `tools/list` and `tools/call` require an
 * `Authorization: Bearer mpp_...` Portico API key. Application failures are
 * reported with JSON-RPC error codes in the -320xx server range and the
 * matching Portico code in `error.data`.
 */

import type { PorticoPrincipal } from '../auth/types';
import type { TenantRuntime } from '../runtime/tenant';
import { PRODUCT_VERSION } from '../shared/brand';
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

type AuthResult =
  | { kind: 'ok'; principal: PorticoPrincipal; runtime: TenantRuntime }
  | { kind: 'error'; status: number; response: JsonRpcErrorResponse };

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
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          }),
        );
      case 'tools/list':
        return this.handleToolsList(id, headers);
      case 'tools/call':
        return this.handleToolsCall(id, headers, request.params);
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

    const ctx: ToolContext = { runtime: auth.runtime, sessions: this.sessions };
    try {
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
      return { kind: 'ok', principal: auth.principal, runtime: this.runtime };
    } catch {
      return this.authFailure(id);
    }
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
