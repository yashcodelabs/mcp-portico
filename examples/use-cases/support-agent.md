# Use case: support agent

A service-desk AI application helps an analyst triage tickets. The agent
searches the ticketing API and reads the requesting customer's profile -
without knowing the backend's URL, credentials, or request signing details.

## The scenario

The AI application is any MCP-compatible support or service-desk agent. It
authenticates to MCP Portico with a Portico API key, selects the
`acme-support` connection, and calls catalog operations compiled from the
Support Desk API.

## What the agent does (generic MCP behavior)

1. Initialize an MCP session (`initialize`, `notifications/initialized`).
2. `tools/list` to see the fixed Portico toolset.
3. `list_connections` to see which connections the principal may select.
4. `select_connection` with `connectionId: acme-support`.
5. `search_operations` with `query: "ticket"` to discover catalog
   operations.
6. `call_operation` for `tickets.list` and `customers.get`.

The agent never supplies a URL, a tenant id, an upstream credential, or a
backend origin. The Support Desk API shown here is read-only; write and
destructive operations follow the confirmation flow in the
[workflow with confirmation](workflow-confirmation.md) use case.

## Backend-specific catalog configuration

Compile the fixture OpenAPI document into a catalog:

```bash
mcp-portico catalog import apis/support.openapi.yaml \
  --api-id support \
  --output apis/support.catalog.json \
  --report /tmp/support.report.json
```

The catalog exposes exactly these operations:

| Operation       | Method | Path                      | Risk | Confirmation |
| --------------- | ------ | ------------------------- | ---- | ------------ |
| `tickets.list`  | GET    | `/tickets`                | read | never        |
| `tickets.get`   | GET    | `/tickets/{ticketId}`     | read | never        |
| `customers.get` | GET    | `/customers/{customerId}` | read | never        |

Pin the catalog in a registry and create a tenant-owned connection. The
checked-in [registry.yaml](registry.yaml) already does this; the snippet
below is the same shape:

```yaml
version: 1
tenants:
  - id: acme
    name: Acme
principals:
  - id: acme-support-agent
    tenantId: acme
    allowedConnectionIds: [acme-support]
backends:
  - id: support
    title: Support Desk API
    scope: global
    catalogRef: ./apis/support.catalog.json
    catalogChecksum: <checksum from the import report>
connections:
  - id: acme-support
    tenantId: acme
    backendId: support
    baseUrl: https://support.internal.example.com
    network:
      allowedProtocols: [https]
    auth:
      type: bearer
      tokenRef: env:SUPPORT_PROD_TOKEN
```

`catalogChecksum` comes from the import report (or from the `checksum` field
of the compiled catalog). Replacing `baseUrl` with your deployment changes
only the connection; the catalog and its checksum stay the same.

Create keys and serve:

```bash
export MCP_PORTICO_KEY_PEPPER='replace-with-a-long-random-pepper'
export SUPPORT_PROD_TOKEN='replace-with-an-upstream-token'

mcp-portico key create --registry registry.yaml --tenant acme --principal acme-support-agent
MCP_PORTICO_AUTH_MODE=bearer mcp-portico serve --registry registry.yaml
```

`key create` writes the principal's key id and digest into `registry.yaml`
and prints a one-time token; use it as `$MCP_KEY` below. `serve` refuses to
start if a secret reference is missing or a destination is not allowed.

## The MCP session (generic MCP behavior)

Any MCP client drives the same session flow. Initialize and select the
connection:

```bash
curl -sS --max-time 30 "http://127.0.0.1:$MCP_PORT/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $MCP_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"support-agent","version":"0.0.0"}}}'
```

Send `notifications/initialized` (HTTP 202), then select the connection:

```bash
curl -sS --max-time 30 "http://127.0.0.1:$MCP_PORT/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $MCP_KEY" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"select_connection","arguments":{"connectionId":"acme-support"}}}'
```

Search the active connection's catalog and call operations:

```bash
curl -sS --max-time 30 "http://127.0.0.1:$MCP_PORT/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $MCP_KEY" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_operations","arguments":{"query":"ticket"}}}'

curl -sS --max-time 30 "http://127.0.0.1:$MCP_PORT/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $MCP_KEY" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"call_operation","arguments":{"operationId":"tickets.list","arguments":{"status":"open","limit":5}}}}'

curl -sS --max-time 30 "http://127.0.0.1:$MCP_PORT/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $MCP_KEY" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"call_operation","arguments":{"operationId":"customers.get","arguments":{"customerId":"C-1"}}}}'
```

The server authenticates the client, re-validates the session, and executes
only the catalog operation against the operator-configured connection.
`test/integration/use-cases.test.ts` runs this flow against a loopback
fixture backend.

## Generic MCP behavior vs backend-specific catalog configuration

| Layer     | Generic MCP behavior (Portico-owned)                                                                 | Backend-specific catalog configuration (operator-owned)                                     |
| --------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Session   | `initialize`, fixed toolset, connection selection by id                                              | Registry: which connections exist and which principal may select them                       |
| Discovery | `search_operations`, `describe_operation` on the active connection                                   | Catalog: operation ids, methods, paths, summaries, schemas                                  |
| Execution | `call_operation` with operation id and arguments; server-side auth, network policy, redaction, audit | Catalog and connection: risk, confirmation, limits, auth type, `env:` secret refs, base URL |
| Security  | Credentials never exposed; tenant isolation; non-enumerating errors                                  | Connection: upstream auth, network policy, destination allowlist                            |
