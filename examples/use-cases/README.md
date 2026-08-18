# MCP Portico domain use cases

MCP Portico is a client-neutral gateway: the MCP session, the fixed toolset,
confirmation semantics, and the security boundary are identical for every
MCP-compatible AI application. What changes between deployments is
backend-specific catalog and registry configuration.

These use cases show non-coding domains running on the same MCP surface. They
are credential-free: every secret is an `env:` reference and every token is a
placeholder. The fixture catalogs in `apis/` are compiled from the matching
OpenAPI documents with `mcp-portico catalog import` and exercised by
`test/integration/use-cases.test.ts` against loopback fixture backends.

## Use cases

| Use case                       | Document                                                                 | What it demonstrates                                                                       |
| ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Support agent                  | [support-agent.md](support-agent.md)                                     | Searching a ticketing API and reading a customer profile through catalog-gated operations. |
| Operations and finance         | [operations-finance.md](operations-finance.md)                           | Reading approved internal data when the application never sees a database or service URL.  |
| Workflow with confirmation     | [workflow-confirmation.md](workflow-confirmation.md)                     | Confirming a mutating operation with a token before the upstream call is made.             |
| Weather-aware fulfillment risk | [weather-orders-inventory/README.md](weather-orders-inventory/README.md) | Joining public weather with private orders and inventory to identify fulfillment risk.     |
| Codex local multi-backend demo | [registry.codex-demo.yaml](registry.codex-demo.yaml)                     | Combining a public weather API with local finance and support APIs through Codex MCP.      |

## Generic MCP behavior

Everything the AI application sees and drives:

- The MCP lifecycle (`initialize`, `notifications/initialized`) and the fixed
  Portico toolset: `list_connections`, `select_connection`, `get_session`,
  `search_operations`, `describe_operation`, `call_operation`,
  `call_operations`, and `test_connection`.
- Server-side session selection: the application picks a connection by id,
  and the server resolves tenant, backend, credentials, and policy.
- Risk and confirmation: read operations execute directly; write and
  destructive operations return a confirmation token that must be passed
  back before the upstream request is sent.
- Non-enumerating errors and tenant isolation; credentials never reach the
  client.

Generic MCP behavior is owned by MCP Portico and is identical across every
use case.

## Backend-specific catalog configuration

Everything an operator prepares per backend:

- The OpenAPI document (or AI-analysis output) for one API.
- The compiled catalog v2 artifact (`catalog import`) and its checksum.
- The registry record: a backend pinned to a catalog checksum, and a
  tenant-owned connection with base URL, network policy, upstream auth
  (`env:` references), and restrictive policy.
- Portico API keys for principals.

Catalog configuration is owned by the operator and differs per use case; none
of it is visible to the AI application as configuration.

## Shared setup

Each use case assumes Node.js 22+, `pnpm install`, and `pnpm build`, then
uses `mcp-portico` (that is, `pnpm exec mcp-portico` or
`node dist/cli/index.js`) from this directory. The complete import, key,
serve, and session flow is in the [main examples walkthrough](../README.md).

Commands use `$MCP_KEY` for the Portico API key and `$MCP_PORT=3000` for the
server port; substitute the values from `mcp-portico key create` and your
environment.
