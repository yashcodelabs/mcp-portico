# Use case: operations and finance agent

A finance AI application helps an analyst review open invoices and run
approved internal reports. The application reads data through catalog-gated
operation ids - it never sees a database connection string, a service URL,
or a way to point Portico at an arbitrary endpoint.

## The scenario

The AI application is any MCP-compatible finance, operations, or BI agent.
It authenticates to MCP Portico with a Portico API key, selects the
`acme-finance` connection, and calls only the operations compiled from the
Finance API catalog.

## What the agent does (generic MCP behavior)

1. Initialize an MCP session.
2. `tools/list` to see the fixed Portico toolset.
3. `select_connection` with `connectionId: acme-finance`.
4. `search_operations` with `risk: read` to find read-only operations.
5. `call_operation` for `invoices.list`, `invoices.get`, or `reports.run`.

The agent supplies operation arguments (filters, ids) only. The backend
origin, credentials, and network policy come from the operator-configured
connection; the catalog decides which operations exist. A request cannot
select an arbitrary origin, because the runtime executes only catalog
operation ids against the active connection.

## Backend-specific catalog configuration

Compile the fixture OpenAPI document into a catalog:

```bash
mcp-portico catalog import apis/finance.openapi.yaml \
  --api-id finance \
  --output apis/finance.catalog.json \
  --report /tmp/finance.report.json
```

Catalog operations:

| Operation       | Method | Path                    | Risk  | Confirmation |
| --------------- | ------ | ----------------------- | ----- | ------------ |
| `invoices.list` | GET    | `/invoices`             | read  | never        |
| `invoices.get`  | GET    | `/invoices/{invoiceId}` | read  | never        |
| `reports.run`   | GET    | `/reports/usage`        | read  | never        |
| `invoices.post` | POST   | `/invoices`             | write | write        |

`invoices.post` is compiled as a write operation and is exercised in the
[workflow with confirmation](workflow-confirmation.md) use case.

The checked-in [registry.yaml](registry.yaml) pins both fixture catalogs by
checksum. A tenant-owned connection looks like:

```yaml
version: 1
tenants:
  - id: acme
    name: Acme
principals:
  - id: acme-finance-agent
    tenantId: acme
    allowedConnectionIds: [acme-finance]
backends:
  - id: finance
    title: Finance API
    scope: global
    catalogRef: ./apis/finance.catalog.json
    catalogChecksum: <checksum from the import report>
connections:
  - id: acme-finance
    tenantId: acme
    backendId: finance
    baseUrl: https://finance.internal.example.com
    network:
      allowedProtocols: [https]
    auth:
      type: apiKey
      in: header
      name: X-API-Key
      valueRef: env:FINANCE_PROD_API_KEY
```

No database URL, table name, or query appears anywhere in the MCP surface:
the catalog and connection own that information, and the client sees only
connection ids and operation ids.

Create keys and serve:

```bash
export MCP_PORTICO_KEY_PEPPER='replace-with-a-long-random-pepper'
export FINANCE_PROD_API_KEY='replace-with-an-upstream-key'

mcp-portico key create --registry registry.yaml --tenant acme --principal acme-finance-agent
MCP_PORTICO_AUTH_MODE=bearer mcp-portico serve --registry registry.yaml
```

## The MCP session (generic MCP behavior)

Initialize and select the finance connection, then discover read-only
operations:

```bash
curl -sS --max-time 30 "http://127.0.0.1:$MCP_PORT/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $MCP_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"finance-agent","version":"0.0.0"}}}'
```

Send `notifications/initialized`, then:

```bash
curl -sS --max-time 30 "http://127.0.0.1:$MCP_PORT/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $MCP_KEY" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"select_connection","arguments":{"connectionId":"acme-finance"}}}'

curl -sS --max-time 30 "http://127.0.0.1:$MCP_PORT/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $MCP_KEY" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_operations","arguments":{"risk":"read"}}}'

curl -sS --max-time 30 "http://127.0.0.1:$MCP_PORT/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $MCP_KEY" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"call_operation","arguments":{"operationId":"invoices.list","arguments":{"status":"open"}}}}'

curl -sS --max-time 30 "http://127.0.0.1:$MCP_PORT/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $MCP_KEY" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"call_operation","arguments":{"operationId":"invoices.get","arguments":{"invoiceId":"INV-1"}}}}'
```

`test/integration/use-cases.test.ts` runs this flow against a loopback
fixture backend and asserts the upstream sees the configured API key - and
that the client never sees the backend origin.

## Generic MCP behavior vs backend-specific catalog configuration

| Layer       | Generic MCP behavior (Portico-owned)                    | Backend-specific catalog configuration (operator-owned)                         |
| ----------- | ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Session     | `initialize`, fixed toolset, connection selection by id | Registry: connections and principal allowlists                                  |
| Discovery   | `search_operations` by query, tag, or risk              | Catalog: operation ids, methods, paths, summaries, schemas                      |
| Execution   | `call_operation` with operation id and arguments        | Catalog and connection: risk, confirmation, limits, auth, base URL              |
| Data access | No client-supplied origin, tenant, or credentials       | Catalog and connection: operation allowlist, network policy, `env:` secret refs |
