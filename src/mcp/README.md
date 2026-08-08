# MCP Transport and Tools

MCP Portico exposes a fixed toolset over JSON-RPC 2.0 using the MCP streamable
HTTP transport on a single endpoint: `POST /mcp`.

## Transport

- Endpoint: `POST /mcp` with `Content-Type: application/json`.
- Requests are JSON-RPC 2.0 request objects; responses are JSON-RPC result or
  error objects. Batches are not supported.
- Notifications (requests without an `id`), including
  `notifications/initialized`, are acknowledged with `202 Accepted` and an
  empty body.
- A malformed body returns JSON-RPC error `-32700` (Parse error) with HTTP 400;
  structurally invalid requests return `-32600` (Invalid Request).
- Unknown methods return JSON-RPC error `-32601` (Method not found).
- Unsupported HTTP methods receive `405` with `Allow: GET, POST`.

| Method                      | HTTP      | Auth   | Purpose                                                                      |
| --------------------------- | --------- | ------ | ---------------------------------------------------------------------------- |
| `initialize`                | POST /mcp | none   | Protocol negotiation; returns `protocolVersion: 2025-06-18` and server info. |
| `notifications/initialized` | POST /mcp | none   | Client-ready signal; acknowledged with 202.                                  |
| `tools/list`                | POST /mcp | Bearer | Lists the fixed toolset.                                                     |
| `tools/call`                | POST /mcp | Bearer | Invokes one of the fixed tools.                                              |
| `resources/list`            | POST /mcp | Bearer | Lists the authenticated tenant's resources (usage + API Explorer metadata).  |
| `resources/read`            | POST /mcp | Bearer | Reads one tenant-scoped resource by URI.                                     |

## Resources (API Explorer / MCP Apps metadata)

`resources/list` returns three kinds of URIs, all scoped to the
authenticated principal:

| URI                       | Contents                                                                      |
| ------------------------- | ----------------------------------------------------------------------------- |
| `mcp-portico://usage`     | Tenant-scoped usage summary derived from in-memory audit events.              |
| `mcp-portico://apis`      | API Explorer overview: every authorized connection with its catalog metadata. |
| `mcp-portico://apis/<id>` | One authorized connection: connection metadata plus the full operation list.  |

`resources/read` requires `{ uri }` and returns standard MCP resource
contents (`contents[0].text` is a JSON string). Unknown, unauthorized, and
cross-tenant URIs all return the same `-32602 Unknown resource` error.

### Refresh contract

The transport is request/response only (no SSE), so the server cannot push
`notifications/resources/list_changed` or `notifications/resources/updated`.
For that reason `initialize` advertises only `capabilities: { tools: {},
resources: {} }` and never claims `subscribe` or `listChanged` support.
Clients detect a registry reload by comparing `registryRevision` embedded in
every resource payload (and `checksum` per catalog) and re-read the resource
when it changes. All client notifications, including
`notifications/initialized`, are acknowledged with `202` and an empty body.

## Authentication

Every `tools/list` and `tools/call` request must carry a Portico API key:

```http
Authorization: Bearer mpp_<keyId>_<secret>
```

- Keys are verified against the registry using the HMAC keyed by
  `MCP_PORTICO_KEY_PEPPER`; the registry stores only the key id and digest.
- Authentication failures return JSON-RPC error `-32001` (`AUTH`) with HTTP 401
  and the generic message `Invalid credentials.` — never the presented
  credential or the registered key material.
- With no runtime configured, `tools/list` and `tools/call` return `-32003`
  (`CONFIG_ERROR`, `No runtime configured.`).

## Fixed toolset

The 8 fixed tools (stable order, exposed by `tools/list`):

| Tool                 | Description                                                               |
| -------------------- | ------------------------------------------------------------------------- |
| `list_connections`   | List the connections the authenticated principal may select.              |
| `select_connection`  | Select a connection and create the active session for the principal.      |
| `get_session`        | Return the principal's active session, re-validated against the registry. |
| `search_operations`  | Search the active connection's catalog by tag, risk, or free-text query.  |
| `describe_operation` | Return the full catalog definition of one operation.                      |
| `call_operation`     | Execute one catalog operation; write operations require confirmation.     |
| `call_operations`    | Execute a batch (concurrency 2, fail-soft) with per-item results.         |
| `test_connection`    | Probe a connection under its network and auth policy.                     |

Tool-level failures are reported as successful JSON-RPC results with
`{ content: [{ type: "text", text }], isError: true }` per MCP convention.
Unknown and unauthorized operations share the generic message
`Operation not found or not authorized.` so a catalog's contents can never be
enumerated across tenant boundaries.

## Session model

- The server keeps one active session per authenticated principal
  (`principalId -> sessionId`) in memory.
- `select_connection` validates authorization, creates a session via the
  tenant runtime, and stores it keyed by principal id.
- Session-scoped tools (`get_session`, `search_operations`,
  `describe_operation`, `call_operation`, `call_operations`) re-validate the
  stored session against the current registry snapshot on every call; stale,
  revoked, or cross-tenant sessions are rejected with generic errors.
- The cached active session is re-validated after every successful
  authentication and dropped as soon as it is stale (registry reload) or
  revoked (principal/connection removed), so the next call returns
  `No active session; select a connection first.`
- Calling a session-scoped tool before `select_connection` fails with
  `No active session; select a connection first.`

## Binary responses

Operation responses with binary bodies are returned as MCP text content
containing the base64-encoded payload together with the response content type:

```json
{ "contentType": "application/octet-stream", "base64": "..." }
```

All tool results are text content blocks. For executed operations, a separate
text block carries execution metadata: `status`, `bytes`, `durationMs`, plus
`truncated` and `contentType` when applicable.
