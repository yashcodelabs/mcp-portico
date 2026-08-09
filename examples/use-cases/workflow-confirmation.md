# Use case: workflow agent with confirmation

A workflow AI application creates an invoice as part of an approvals flow.
Mutating operations never reach the backend on the first call: MCP Portico
returns a confirmation token, and the application repeats the call with that
token to execute it.

## The scenario

The AI application is any MCP-compatible workflow, automation, or enterprise
copilot. It selects the `acme-finance` connection and calls `invoices.post`.
The first call returns a token without touching the backend; the second
call, with the token, performs the create.

## What the agent does (generic MCP behavior)

1. Initialize an MCP session and select the `acme-finance` connection.
2. Call `call_operation` with `operationId: invoices.post` and the invoice
   body. The result is a confirmation envelope: `requiresConfirmation:
true`, a `token`, and `risk: write`. No upstream request is made.
3. Present the pending operation to a user or policy step, then call
   `call_operation` again with the same arguments and the
   `confirmationToken`.
4. The second call executes and returns the backend response.

Confirmation is generic MCP behavior: the catalog records each operation's
risk, and Portico requires a token for write and destructive operations. An
operator can only tighten this, for example with connection policy
`confirmation: always`.

## Backend-specific catalog configuration

This use case reuses the finance fixture: `apis/finance.openapi.yaml`
compiles to `apis/finance.catalog.json`, where `invoices.post` is a write
operation (`risk: write`, `confirmation: write`). The registry is the same
[registry.yaml](registry.yaml); the connection may tighten policy:

```yaml
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
    policy:
      confirmation: always
```

The rest of the registry - tenant, principal, backend, checksum - is
unchanged from the [operations and finance](operations-finance.md) use case.

## The MCP session (generic MCP behavior)

Initialize, select `acme-finance`, then call the write operation once
without a token:

```bash
curl -sS --max-time 30 "http://127.0.0.1:$MCP_PORT/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $MCP_KEY" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"call_operation","arguments":{"operationId":"invoices.post","arguments":{"body":{"customerId":"C-1","amount":42.5,"currency":"USD"}}}}}'
```

The response is a confirmation envelope, not a backend result:

```json
{
  "operationId": "invoices.post",
  "requiresConfirmation": true,
  "token": "<sha256 hex digest>",
  "risk": "write",
  "message": "Operation \"invoices.post\" requires confirmation before execution."
}
```

Nothing was sent to the backend. Repeat the call with the token:

```bash
curl -sS --max-time 30 "http://127.0.0.1:$MCP_PORT/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $MCP_KEY" \
  -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"call_operation","arguments":{"operationId":"invoices.post","arguments":{"body":{"customerId":"C-1","amount":42.5,"currency":"USD"}},"confirmationToken":"<token-from-the-previous-response>"}}}'
```

The response now contains the created invoice plus metadata such as
`status: 201`. Tokens are deterministic per operation, input, and principal,
so one agent cannot replay another agent's confirmation.
`test/integration/use-cases.test.ts` asserts the upstream receives exactly
one POST, and only after the token is supplied.

## Generic MCP behavior vs backend-specific catalog configuration

| Layer        | Generic MCP behavior (Portico-owned)                                   | Backend-specific catalog configuration (operator-owned)          |
| ------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Risk model   | `read` executes immediately; `write` and `destructive` require a token | Catalog: per-operation risk and confirmation policy              |
| Confirmation | Token returned on first call; upstream call only with matching token   | Connection policy may tighten to `confirmation: always`          |
| Execution    | `call_operation` with arguments plus `confirmationToken`               | Catalog and connection: operation schema, auth, limits, base URL |
| Safety       | Pending and confirmed outcomes are audited server-side                 | Connection: upstream auth and network policy                     |
