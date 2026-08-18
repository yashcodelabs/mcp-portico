# Local dummy backends

Two tiny dependency-free HTTP servers that stand in for "internal" APIs so the
Portico local demo works offline and deterministically.

| Port | API         | Auth                                       |
| ---- | ----------- | ------------------------------------------ |
| 4010 | Finance API | `X-API-Key: finance-demo-key`              |
| 4020 | Support API | `Authorization: Bearer support-demo-token` |

The data served matches the contracts in `../apis/finance.openapi.yaml` and
`../apis/support.openapi.yaml`.

## Run

```bash
node examples/use-cases/mock-backends/server.mjs
```

Both servers start in one process. Stop with `Ctrl+C`.

## Verify directly

```bash
curl -H "X-API-Key: finance-demo-key" http://127.0.0.1:4010/invoices
curl -H "Authorization: Bearer support-demo-token" http://127.0.0.1:4020/tickets
```

Portico never exposes these URLs or credentials to MCP clients; the client
only sees connection ids from the registry.
