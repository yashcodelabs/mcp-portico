# MCP interoperability test matrix

**Status:** Companion to the MCP compatibility contract
**Test file:** `test/integration/mcp-contract.test.ts`
**Updated:** 2026-08-09

The interoperability suite proves the
[MCP compatibility contract](mcp-compatibility-contract.md) with
deterministic protocol fixtures. It never depends on a specific model
provider, agent framework, vendor UI, or MCP SDK: every scenario is driven by
hand-written JSON-RPC messages against fixture backends started in-process,
with fixed request ids and stable assertions.

## Transport profiles under test

Each scenario in the suite runs against every supported transport profile:

| Profile        | Topology                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `direct-http`  | Client -> Portico over plain loopback HTTP (local deployment).                                                                                                |
| `proxied-http` | Client -> in-test reverse proxy -> Portico (remote deployment with a TLS-terminating intermediary; TLS itself is deployment-owned and out of contract scope). |

Both profiles exercise byte-identical contract expectations: lifecycle,
capabilities, discovery, calls, errors, and isolation behave the same through
an intermediary as they do directly.

## Scenario matrix

| #   | Scenario                           | Deterministic fixture                                                                             | Assertions                                                                                                              | Profiles |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | Initialization                     | `initialize` with fixed client info and request id                                                | `protocolVersion: 2025-06-18`; `capabilities: { tools: {}, resources: {} }`; `serverInfo.name: mcp-portico`; id echoed  | both     |
| 2   | Capability negotiation             | Client sends older protocol version and unknown capabilities/optional fields                      | Server still returns its own version and exactly the advertised capabilities; unknown fields do not change the response | both     |
| 3   | Notifications                      | `notifications/initialized`, unknown notification, `notifications/cancelled`                      | Each returns `202` with an empty body; none produce a JSON-RPC response                                                 | both     |
| 4   | Tool discovery                     | `tools/list` with and without `cursor`/`_meta`                                                    | Exactly the 8 fixed tools in stable order with JSON-Schema inputs; extra fields ignored                                 | both     |
| 5   | Resource discovery                 | `resources/list` and `resources/read` for usage, apis, and one connection                         | Tenant-scoped URIs and payloads; unknown resource returns `-32602 Unknown resource`                                     | both     |
| 6   | Protocol errors                    | Malformed JSON, batch array, missing method, bad `jsonrpc`, non-object params                     | HTTP 400 with `-32700`/`-32600` and `id: null`                                                                          | both     |
| 7   | Method/tool errors                 | Unknown method, unknown tool, missing tool name, non-object arguments                             | `-32601 Method not found`; `-32602 Unknown tool`; `-32602 Invalid params` (HTTP 200)                                    | both     |
| 8   | Authentication failures            | Missing, malformed, and well-formed-but-unknown credentials                                       | Identical HTTP 401 + `-32001 Invalid credentials.` bodies; nothing enumerates key material                              | both     |
| 9   | HTTP method handling               | `PUT /mcp`                                                                                        | HTTP 405 with `Allow: GET, POST`                                                                                        | both     |
| 10  | Session prerequisite               | Session-scoped tools before `select_connection`                                                   | `isError: true` with `No active session; select a connection first.`                                                    | both     |
| 11  | Session selection and inspection   | `list_connections`, `select_connection`, `get_session`, `search_operations`, `describe_operation` | Stable connection/session views; tag and text search; full catalog definition                                           | both     |
| 12  | Read execution                     | `call_operation` against the fixture backend                                                      | Upstream JSON body plus `status: 200` metadata; `isError` false                                                         | both     |
| 13  | Confirmation                       | Write call without token, repeated, with wrong token, with correct token                          | Deterministic identical tokens; mismatch error; executed call reaches the fixture                                       | both     |
| 14  | Binary responses                   | Fixture serves fixed octet payload                                                                | Text block `{ contentType, base64 }` decodes to the exact bytes; metadata carries status/content type                   | both     |
| 15  | Multipart attachments              | Multipart call with a `{ base64, filename, contentType }` part                                    | Fixture receives `multipart/form-data` with boundary, filename, and the decoded part bytes                              | both     |
| 16  | Bulk calls                         | Mixed batch: read, unknown operation, confirmation-required write, extra item field               | `failed` count; results in request order; generic NOT_FOUND error; per-item confirmation; extra fields ignored          | both     |
| 17  | Upstream failures                  | Fixture returns 500; fixture endpoint never responds with a short operation timeout               | 500 surfaced as `status: 500` metadata; timeout becomes `isError: true` with `Upstream request timed out.`              | both     |
| 18  | Connection probe                   | `test_connection` against the fixture root                                                        | `ok: true`, `status: 200`, bounded `durationMs`/`bytes`                                                                 | both     |
| 19  | Request ordering                   | Sequential mixed id types; five concurrent `tools/list` with distinct ids                         | Each response echoes exactly its own id; ordering is deterministic per request                                          | both     |
| 20  | Pagination-sized requests          | `search_operations` with `limit`, `page`, `cursor`, and no extra fields                           | Identical full result sets; no cursor behavior                                                                          | both     |
| 21  | Unknown optional fields            | Extra fields in params, tool arguments, and batch items; unknown operation argument               | Envelope/tool-level extras ignored; operation arguments rejected with a deterministic `USAGE` error                     | both     |
| 22  | Non-enumerating authorization      | Unknown vs unauthorized connection, operation, probe, and resource across tenants                 | Identical generic messages for unknown and unauthorized cases; discovery never leaks other tenants                      | both     |
| 23  | Cancellation                       | `notifications/cancelled` mid-session                                                             | `202` ack with no side effects; session remains usable                                                                  | both     |
| 24  | Session cleanup on registry reload | Select, `publish()` the same registry (revision bump)                                             | Session dropped; next call requires reselection; reselection succeeds                                                   | both     |
| 25  | Session cleanup on revocation      | Rewrite registry without the connection, publish                                                  | Discovery returns empty; session dropped; selection now fails generically                                               | both     |

## Determinism rules

- Request ids are fixed or incrementing; every assertion compares exact ids.
- Fixture backends return fixed payloads; binary fixtures use fixed bytes.
- Confirmation tokens are asserted to be repeatable across identical calls.
- No test consults a model, vendor API, agent UI, or external network; all
  backends and proxies run in-process on loopback.
- Each transport profile gets a fresh Portico server, registry, and catalog
  so profile runs are independent and order-stable.

## CI wiring

The suite is part of the integration test glob (`test/integration/*.test.ts`)
and is additionally run as an explicit step in the `check` job of
`.github/workflows/ci.yml`, which runs on Linux (`ubuntu-latest`) and macOS
(`macos-latest`) with Node 22 and 24:

```yaml
- name: Interop contract tests
  run: pnpm vitest run test/integration/mcp-contract.test.ts
```

Windows remains a secondary compatibility signal: the `windows-compat` job
(continue-on-error) runs the same integration glob including this suite.
