# Telemetry

MCP Portico v1 usage telemetry is deliberately minimal and honest about its
limits.

## What exists

- Every tenant-facing action is already recorded as an audit event
  (`src/audit/log.ts`): authentication, discovery, connection selection,
  operation description, single and bulk execution, and connection tests.
  Each event is tenant- and principal-namespaced and never contains
  credentials.
- `summary.ts` derives tenant-safe usage summaries from audit events.
  Aggregation is either scoped to a single tenant first or grouped into
  per-tenant rows; unattributed events are never folded into a tenant's
  totals.
- `load.ts` reads exported audit events (JSON array or newline-delimited
  JSON) so the operator CLI can summarize usage offline.
- The `mcp-portico usage summary` CLI command renders the summary and
  always states the persistence limitation.
- The MCP `resources/read` surface exposes a `mcp-portico://usage` resource
  that is scoped to the authenticated tenant only.

## Persistence limitations (v1)

- The audit log is in-memory only: events live for the lifetime of one
  server process and are lost on restart.
- Nothing is written to disk automatically. There is no database backend,
  no usage file, and no retention policy in v1.
- The CLI summary only reflects events explicitly supplied with
  `--file`; with no file, it reports that no persisted data exists.
- The MCP usage resource reflects only the current process's in-memory
  events for the authenticated tenant.

## Tenant safety

Tenant filtering happens before any aggregation or pagination. A tenant
principal can only ever see its own tenant's rows, and operator (unscoped)
summaries keep every connection and operation row attributed to its tenant
so identical ids across tenants can never be merged or leaked.
