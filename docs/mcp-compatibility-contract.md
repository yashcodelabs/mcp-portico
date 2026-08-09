# MCP Portico compatibility contract

**Status:** Public contract for MCP clients (v1)
**Protocol version:** `2025-06-18`
**Server:** `mcp-portico` 0.1.0
**Updated:** 2026-08-09

This document is the public, client-neutral contract for integrating any
MCP-compatible AI application with MCP Portico. It is deliberately
independent of any model provider, agent framework, vendor UI, or backend
implementation. A client that follows this contract can connect to a Portico
deployment without reading Portico internals and without any backend-specific
knowledge.

## 1. Contract scope

MCP Portico exposes one MCP endpoint, one protocol version, one fixed
toolset, and one authentication model. The contract covers:

- the MCP lifecycle: initialize, capability negotiation, session handling,
  discovery, operation description, execution, errors, and shutdown;
- the fixed Portico tool contract with stable names, inputs, and outputs;
- supported transport profiles for local and remote deployments;
- limits and behavior for pagination, bulk calls, attachments, binary
  responses, confirmations, timeouts, and upstream failures;
- deterministic error and non-enumeration guarantees.

What the contract never requires of a client:

- backend-specific knowledge (URLs, credentials, catalog internals, or
  transport details per backend);
- the ability to select or override tenant, principal, connection, backend,
  or origin identity - identity is always derived from the Portico credential;
- support for server-to-client push; the v1 transport is request/response
  only;
- support for JSON-RPC batches; batches are rejected.

## 2. Transport profiles

### 2.1 Single endpoint

All MCP methods use JSON-RPC 2.0 over HTTP on a single endpoint:

```text
POST /mcp
```

| Aspect          | Contract                                                               |
| --------------- | ---------------------------------------------------------------------- |
| Request body    | JSON-RPC 2.0 request or notification object (`application/json`).      |
| Response body   | JSON-RPC 2.0 result/error object, or empty for notifications.          |
| Notifications   | Acknowledged with `202 Accepted` and an empty body.                    |
| Batches         | Not supported; an array payload is rejected with `-32600`.             |
| Streaming (SSE) | Not offered; the server never sends server-to-client notifications.    |
| `Accept`        | `application/json, text/event-stream` is accepted; responses are JSON. |

HTTP status mapping:

| HTTP status | Meaning                                                        |
| ----------- | -------------------------------------------------------------- |
| 200         | JSON-RPC response (success or application error).              |
| 202         | Notification acknowledged; empty body.                         |
| 400         | Parse error (`-32700`) or invalid request (`-32600`).          |
| 401         | Authentication failure (`-32001`).                             |
| 405         | Unsupported HTTP method; `Allow: GET, POST`.                   |
| 413         | MCP request body exceeds 10 MiB; non-JSON-RPC error object.    |
| 500         | No runtime configured (`-32003`) or unexpected internal error. |

### 2.2 Profile A: local loopback

A local deployment binds Portico to a loopback interface (`127.0.0.1`) and
serves plain HTTP. This profile is for development, operators, and
single-machine automation. The client connects directly to
`http://127.0.0.1:<port>/mcp`.

Expectations:

- No TLS is provided by the Portico process; TLS is optional only when the
  loopback interface is trusted.
- The server refuses remote binding without authentication (`--auth-mode
none` is loopback-only).
- Everything else in this contract applies unchanged.

### 2.3 Profile B: remote deployment

A remote deployment places Portico behind a TLS-terminating reverse proxy.
Clients connect to a public HTTPS URL that maps to the same `POST /mcp`
endpoint, for example `https://mcp.example.com/mcp`.

Expectations:

- TLS, DNS, and certificates are owned by the deployment, not by Portico.
- The proxy must preserve the request path, headers (including
  `Authorization`), and body; any proxy may additionally add
  `mcp-protocol-version` or hop-by-hop headers.
- Portico itself still speaks plain HTTP on its listener; the network policy
  that governs upstream backends is separate from client-facing TLS.
- The MCP contract is byte-for-byte identical to the local profile; only the
  base URL and TLS termination differ.

### 2.4 Choosing a connection profile

A client chooses a profile by the endpoint URL alone: loopback HTTP for
local, HTTPS for remote. There is no per-backend transport choice and no
backend-specific connection step. `list_connections` reveals only the
connections the authenticated principal may select, and `select_connection`
takes only a connection id from that list.

## 3. Protocol version and capabilities

`initialize` is unauthenticated and returns:

```json
{
  "protocolVersion": "2025-06-18",
  "capabilities": { "tools": {}, "resources": {} },
  "serverInfo": { "name": "mcp-portico", "version": "0.1.0" }
}
```

- The server advertises exactly `tools` and `resources` and never claims
  `subscribe`, `listChanged`, prompts, logging, or completions that the
  transport cannot deliver.
- The server returns its own supported `protocolVersion`; clients should use
  the returned value for the session. Requested client versions and client
  capabilities are accepted but do not change the server response.
- After `initialize`, the client sends `notifications/initialized`, which is
  acknowledged with `202` and an empty body.
- Because the transport cannot push, clients detect registry reloads by
  comparing the `registryRevision` embedded in every resource payload
  (`mcp-portico://usage`, `mcp-portico://apis`,
  `mcp-portico://apis/<connectionId>`) and re-read the resource when it
  changes.

## 4. Lifecycle

| Step | Method(s)                                              | Notes                                                         |
| ---- | ------------------------------------------------------ | ------------------------------------------------------------- |
| 1    | `initialize`                                           | Unauthenticated negotiation; returns protocol + capabilities. |
| 2    | `notifications/initialized`                            | Client-ready signal; `202` ack.                               |
| 3    | `tools/list`, `resources/list`                         | Discovery of the fixed toolset and tenant-scoped resources.   |
| 4    | `list_connections`                                     | Authorized connections for the authenticated principal.       |
| 5    | `select_connection`                                    | Creates the principal's active session (one per principal).   |
| 6    | `search_operations`, `describe_operation`              | Inspect the active connection's catalog.                      |
| 7    | `call_operation`, `call_operations`, `test_connection` | Execute or probe.                                             |
| 8    | Errors and shutdown                                    | See below.                                                    |

Session handling:

- The server keeps one active session per authenticated principal. Calling a
  session-scoped tool before `select_connection` fails with
  `No active session; select a connection first.`
- Every session-scoped call re-validates the session against the current
  registry snapshot. A registry reload, catalog change, or revocation drops
  the session; the next call returns the "no active session" error and the
  client must select again.
- A session belongs to exactly one principal and can never be reused across
  principals or tenants.

Shutdown and cancellation:

- There is no MCP `session/exit` or shutdown method. Clients end a session by
  closing the HTTP connection(s); sessions are in-memory and disappear with
  the process.
- `notifications/cancelled` is acknowledged with `202` but has no server
  side effects: in-flight tool calls are not interrupted. Client-side
  cancellation means aborting the HTTP request; the session remains valid and
  reusable.
- The server never sends `notifications/cancelled` or progress updates.

## 5. Fixed tool contract

### 5.1 Common conventions

- `tools/list` returns exactly eight tools, in stable order (see table).
- Tool arguments follow the tool's JSON Schema (`inputSchema`, draft
  2020-12). Extra unknown fields in tool arguments are ignored
  (forward-compatible), except operation arguments, which are
  schema-gated (see 7.9).
- Tool results are successful JSON-RPC results with
  `content: [{ type: "text", text }]`. JSON-shaped outputs are a JSON string
  in the text block.
- Tool-level failures are still successful JSON-RPC results with
  `isError: true` and a safe text message.
- The server never registers dynamic tools for backend operations; backend
  operations remain catalog data addressed by stable operation ids.

### 5.2 Tool reference

| #   | Tool                 | Arguments                                                           | Result summary                                                                   |
| --- | -------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | `list_connections`   | none                                                                | `{ connections: [{ id, backendId, baseUrl }] }`                                  |
| 2   | `select_connection`  | `connectionId` (required)                                           | `{ session: { id, tenantId, connectionId, catalogChecksum } }`                   |
| 3   | `get_session`        | none                                                                | Current session view (same shape as above).                                      |
| 4   | `search_operations`  | optional `query`, `tag`, `risk`                                     | `{ operations: [{ operationId, method, path, summary, risk, available }] }`      |
| 5   | `describe_operation` | `operationId` (required)                                            | `{ operation: { operationId, ...catalog definition } }`                          |
| 6   | `call_operation`     | `operationId` (required), `arguments` (object), `confirmationToken` | Executed result or confirmation request.                                         |
| 7   | `call_operations`    | `operations` (array of items)                                       | `{ results: [{ index, operationId, result \| confirmation \| error }], failed }` |
| 8   | `test_connection`    | `connectionId` (required), optional `method`, `path`                | `{ ok, status, durationMs, bytes, finalUrl, truncated, redirected, errorCode? }` |

### 5.3 Executed call result

A successful `call_operation` returns text blocks:

1. the response body - pretty-printed JSON, raw text, or for binary bodies
   the JSON object `{ "contentType": ..., "base64": ... }`;
2. an execution metadata line:
   `status: <code>; bytes: <n>; durationMs: <n>[; truncated: true][; contentType: <type>]`.

`requiresConfirmation` results return one text block:

```json
{
  "operationId": "...",
  "requiresConfirmation": true,
  "token": "<deterministic token>",
  "risk": "write | destructive",
  "message": "Operation \"...\" requires confirmation before execution."
}
```

### 5.4 Generic (non-enumerating) tool errors

| Failure                            | `isError` text                                           |
| ---------------------------------- | -------------------------------------------------------- |
| Unknown or unauthorized operation  | `Operation not found or not authorized.`                 |
| Unknown or unauthorized connection | `Invalid credentials.`                                   |
| Missing session                    | `No active session; select a connection first.`          |
| Unknown tool (JSON-RPC level)      | `-32602 Unknown tool`                                    |
| Confirmation mismatch              | `Confirmation token does not match the operation input.` |

## 6. Authentication and identity

Every method except `initialize` and notifications requires:

```http
Authorization: Bearer mpp_<keyId>_<secret>
```

- The credential identifies the calling client principal only. Tenant,
  principal, connection, backend, and origin are derived exclusively from the
  server-side registry; no tool argument or header can override them.
- Authentication failures (missing, malformed, unknown, or revoked
  credentials) are indistinguishable: HTTP `401` with JSON-RPC `-32001`,
  message `Invalid credentials.`
- Portico credentials are never forwarded upstream; upstream authentication
  is a separate server-owned contract.

## 7. Limits and behavior

### 7.1 Pagination

- v1 has no cursor-based pagination. `tools/list`, `resources/list`, and
  `search_operations` return complete result sets for the authorized scope.
- Unknown pagination fields (`cursor`, `page`, `limit`, `_meta`) in JSON-RPC
  params or fixed-tool arguments are ignored; the response is identical with
  or without them.
- Result sets are bounded by authorization (tenant, principal, connection
  allowlist) and catalog size, never by client-supplied limits.

### 7.2 Bulk calls

- `call_operations` executes independent items with bounded concurrency
  (2 workers), fail-soft: per-item results carry `error: { code, message }`
  instead of failing the batch.
- Results are always returned in request order (`index` 0..n) with a `failed`
  count.
- Each item is exactly `{ operationId, arguments?, confirmationToken? }`.
  Items cannot mix connections and cannot carry tenant/connection/backend
  identifiers.
- Write items that require confirmation return a per-item `confirmation`
  object; the client re-runs the batch with `confirmationToken` supplied.
- Unknown extra fields inside a batch item are ignored.

### 7.3 Attachments

- Multipart request bodies use parts shaped as
  `{ base64, filename?, contentType? }`; plain string fields are also
  allowed.
- Binary request bodies (`kind: binary`) are base64 strings.
- Request body size is bounded by the connection policy
  (`maxRequestBytes`) or the operation limit, default 10 MiB. Oversized
  bodies fail with a `USAGE` error (`Request body exceeds the N byte limit.`).
- The MCP request envelope itself is bounded at 10 MiB (HTTP `413`).

### 7.4 Binary responses

- Binary upstream responses are returned as a text block containing JSON
  `{ "contentType": "...", "base64": "..." }`, followed by the metadata
  block.
- Responses are read up to the connection/operation `maxResponseBytes`
  limit (default 10 MiB); when truncated, the metadata block includes
  `truncated: true` and the client may re-issue with a narrower scope.
- Redaction applies before encoding: secrets never appear in binary, text,
  or JSON bodies.

### 7.5 Confirmations

- Confirmation policy comes from the catalog operation (write/destructive)
  or connection policy (`never`, `write`, `destructive`, `always`).
- The confirmation token is deterministic for
  (principal, operation, canonical arguments); repeating the same call
  yields the same token.
- Executing without the token returns the `requiresConfirmation` result;
  executing with a mismatched token fails with the confirmation-mismatch
  error; executing with the correct token performs the call.
- Bulk items request confirmation per item; a single batch can mix executed
  and confirmation-pending items.

### 7.6 Timeouts

- Upstream calls default to a 30,000 ms timeout, overridable per operation
  or connection policy (`timeoutMs`, 1-600,000 ms in policy).
- Timeouts surface as tool errors with text `Upstream request timed out.`
  (details carry `errorCode: UPSTREAM_TIMEOUT`).
- Redirects are disabled by default; when a connection policy allows
  same-origin redirects, at most five hops are followed.

### 7.7 Upstream failures

- Upstream HTTP statuses are preserved in the result metadata (`status:`);
  the redacted response body is still returned. Health/audit state records
  the failure but the tool result is a normal `isError: false` result.
- Transport failures (DNS, connect, TLS, read, timeout, destination
  denied) become tool errors with `isError: true` and details:
  `UPSTREAM_ERROR`, `UPSTREAM_TIMEOUT`, `DESTINATION_DENIED`.
- Guard failures are explicit tool errors: `Connection rate limit exceeded.`,
  `Connection concurrency limit reached.`,
  `Connection circuit breaker is open; refusing the call.`

### 7.8 Forward compatibility

- Unknown optional fields in JSON-RPC params and in fixed-tool arguments are
  ignored, so clients may send newer optional metadata (`_meta`, future
  fields) without breaking.
- Operation arguments are intentionally strict: unknown keys are rejected
  with a `USAGE` error that lists the allowed keys, because unmodeled values
  must never reach an upstream request. Clients use `describe_operation` to
  learn the exact argument contract.
- Clients should pin to the `protocolVersion` returned by `initialize` and
  treat new optional fields as additive.

## 8. Error reference

| Code   | Meaning          | HTTP | Notes                                          |
| ------ | ---------------- | ---- | ---------------------------------------------- |
| -32700 | Parse error      | 400  | Malformed JSON body.                           |
| -32600 | Invalid request  | 400  | Batch, missing method, bad params.             |
| -32601 | Method not found | 200  | Unknown method.                                |
| -32602 | Invalid params   | 200  | Unknown tool, bad arguments, unknown resource. |
| -32603 | Internal error   | 500  | Unexpected server failure.                     |
| -32001 | AUTH             | 401  | `Invalid credentials.` (never enumerates).     |
| -32003 | CONFIG_ERROR     | 500  | `No runtime configured.`                       |

Application errors carry a machine-readable Portico code in `error.data`
(e.g. `{ "code": "AUTH" }`). Tool-level failures carry `isError: true` in the
result instead of a JSON-RPC error.

## 9. Non-enumeration guarantees

The server never reveals whether a resource exists outside the caller's
authorized scope:

- unknown and unauthorized connections produce identical `Invalid
credentials.` tool errors;
- unknown and unauthorized operations produce identical `Operation not found
or not authorized.` tool errors;
- unknown and cross-tenant resource URIs produce identical
  `-32602 Unknown resource` JSON-RPC errors;
- discovery (`list_connections`, `resources/list`) returns only authorized
  entries.

## 10. Conformance checklist

A conforming client:

- [ ] sends `initialize`, uses the returned `protocolVersion`, and sends
      `notifications/initialized`;
- [ ] authenticates every `tools/*` and `resources/*` request with a Portico
      bearer key;
- [ ] never sends tenant, connection, backend, or origin identifiers it did
      not receive from `list_connections`/`select_connection`;
- [ ] selects a connection before session-scoped tools and reselects when it
      receives `No active session; select a connection first.`;
- [ ] treats `isError: true` results as tool failures and JSON-RPC errors as
      protocol failures;
- [ ] completes confirmations with the returned token;
- [ ] treats results as complete (no cursor pagination) and tolerates
      unknown optional fields it sends;
- [ ] does not require push notifications; it polls resource payloads by
      comparing `registryRevision` when freshness matters.

Related documents: [MCP client integration guide](mcp-client-integration.md)
and [MCP interoperability test matrix](mcp-interoperability-matrix.md).
