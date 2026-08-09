# Inspector

A read-only, tenant-scoped operational view served by `mcp-portico serve` under
`/inspector`.

## Endpoints

| Endpoint                                   | Auth   | Description                                            |
| ------------------------------------------ | ------ | ------------------------------------------------------ |
| `GET /inspector`                           | none   | HTML shell; the page fetches data with the API key     |
| `GET /inspector/api/meta`                  | none   | Product, version, auth mode, registry revision         |
| `GET /inspector/api/overview`              | bearer | Tenant, principal, summary, authorized connections     |
| `GET /inspector/api/connections`           | bearer | Authorized connections with catalog and health summary |
| `GET /inspector/api/connections/:id`       | bearer | Connection detail: operations, warnings, runtime state |
| `POST /inspector/api/connections/:id/test` | bearer | Safe connection probe under the normal probe pipeline  |
| `GET /inspector/api/audit`                 | bearer | Tenant-filtered audit activity (`?limit=`, max 500)    |

## Rules

- Every data endpoint authenticates the operator with a Portico API key and
  returns only that tenant's view. There is no cross-tenant or
  deployment-wide summary on the HTTP inspector.
- Pagination, counts, and aggregations are computed after tenant filtering.
- All payloads pass through the shared redactor; connection secrets are never
  included - only the auth type and secret reference names.
- Unknown or unauthorized connection ids return the same non-enumerating
  `NOT_FOUND` shape.
- The only mutating action is the safe connection test, which runs under the
  normal rate, concurrency, circuit-breaker, health, and audit isolation.
