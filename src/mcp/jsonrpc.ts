/**
 * JSON-RPC 2.0 helpers for the MCP transport.
 *
 * The transport is single-endpoint (`POST /mcp`) and request/response only:
 * batches are not supported, notifications are acknowledged with an empty
 * 202, and every error carries a JSON-RPC error code plus (for application
 * failures) a Portico error code in `data`.
 */

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  /** Structured parameters; absent for notifications and parameterless calls. */
  params?: unknown;
  /** Absent for notifications. */
  id?: JsonRpcId;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export interface JsonRpcParseResult {
  request?: JsonRpcRequest;
  error?: JsonRpcErrorResponse;
}

/** Standard JSON-RPC 2.0 error codes. */
export const JSONRPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** MCP/Portico application error codes (JSON-RPC server error range). */
export const MCP_ERROR_CODES = {
  AUTH: -32001,
  CONFIG: -32003,
} as const;

const INVALID_REQUEST_MESSAGE = 'Invalid Request';

/**
 * Parse an unknown JSON-RPC request payload.
 *
 * Returns `request` for a structurally valid request (notifications keep
 * `id` undefined) and `error` with `id: null` for anything that is not a
 * valid JSON-RPC 2.0 request object. Batches are rejected.
 */
export function parseJsonRpc(body: unknown): JsonRpcParseResult {
  const invalid = (): JsonRpcParseResult => ({
    error: errorResponse(
      null,
      JSONRPC_ERROR_CODES.INVALID_REQUEST,
      INVALID_REQUEST_MESSAGE,
    ),
  });

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return invalid();
  }
  const record = body as Record<string, unknown>;
  if (record.jsonrpc !== '2.0') return invalid();

  const method = record.method;
  if (typeof method !== 'string' || method === '') return invalid();

  const params = record.params;
  if (params !== undefined && (typeof params !== 'object' || params === null)) {
    return invalid();
  }

  const id = record.id;
  if (
    id !== undefined &&
    typeof id !== 'string' &&
    typeof id !== 'number' &&
    id !== null
  ) {
    return invalid();
  }
  if (typeof id === 'number' && !Number.isFinite(id)) return invalid();

  return {
    request: {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
      ...(id !== undefined ? { id } : {}),
    },
  };
}

/** Build a JSON-RPC success response. */
export function success(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: '2.0', id, result };
}

/** Build a JSON-RPC error response. */
export function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  };
}
