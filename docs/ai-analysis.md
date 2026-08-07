# AI backend analysis (Phase 6)

MCP Portico lets an AI agent inspect a backend repository and produce the same
kind of inert import artifacts an OpenAPI file would provide. AI output is
never a live catalog: it is OpenAPI plus a policy overlay plus a review report,
and it only becomes executable after the normal deterministic import/validate
cycle and an explicit operator publish.

## Workflow

1. The operator runs the analysis skill (`.opencode/skills/mcp-portico-analyze`
   or its Cursor mirror) inside a backend repository checkout.
2. The skill inspects routes, controllers, DTOs/schemas, middleware,
   authentication, permissions, multipart fields, and response shapes.
3. The skill writes three inert artifacts into `analysis/out/`:
   `openapi.yaml`, `overlay.json`, and `review-report.json`.
4. The operator (or CI) compiles them through the standard pipeline:

   ```text
   mcp-portico catalog import analysis/out/openapi.yaml \
     --api-id <id> --ai \
     --overlay analysis/out/overlay.json \
     --output analysis/out/catalog.json \
     --report analysis/out/import-report.json
   mcp-portico catalog validate analysis/out/catalog.json
   mcp-portico catalog diff previous-catalog.json analysis/out/catalog.json
   ```

5. Activation is explicit and unchanged: an operator assigns backend
   scope/ownership, pins the catalog checksum, creates tenant connections, and
   publishes a validated registry snapshot. AI artifacts have no tenant access
   before that point, exactly like any other imported artifact.

## Artifact contract

### `openapi.yaml`

OpenAPI 3.2 (the importer also accepts 3.0, 3.1, and Swagger 2.0). Two
vendor-extension contracts carry the AI analysis metadata.

Root-level `x-mcp-portico` object (required when importing with `--ai`):

```json
{
  "x-mcp-portico": {
    "confidence": 0.85,
    "analyzer": "mcp-portico-analyze",
    "analyzerVersion": "0.1.0",
    "repo": "acme/orders-api",
    "commit": "abc123",
    "warnings": [
      { "code": "INFERRED_SCHEMA", "message": "Order schema inferred from DTO" }
    ]
  }
}
```

Operation-level `x-mcp-portico` object on every operation:

```json
{
  "x-mcp-portico": {
    "confidence": 0.9,
    "authStatus": "resolved"
  }
}
```

`authStatus` values:

| Value        | Meaning                                                      |
| ------------ | ------------------------------------------------------------ |
| `resolved`   | A concrete security requirement was found in the repo.       |
| `unresolved` | Authorization could not be determined; compiled unavailable. |
| `public`     | No authorization was found for the route.                    |

Rules:

- Every operation must carry an explicit `operationId`.
- `authStatus: "unresolved"` compiles the operation as unavailable
  (warning `UNRESOLVED_AUTHORIZATION`).
- Operation `confidence < 0.6` compiles the operation as unavailable
  (warning `LOW_CONFIDENCE`).
- Non-AI imports ignore `x-mcp-portico` entirely, so plain OpenAPI documents
  are never affected.

### `overlay.json`

Policy overlay v1, validated against `schemas/overlay.v1.schema.json`.
Operation keys are the `operationId` values from `openapi.yaml`. Overlays can
set risk, confirmation, cache, redactions, descriptions, and limits; they can
never invent operations.

### `review-report.json`

A free-form but stable report for operators:

```json
{
  "reportVersion": "1.0",
  "apiId": "orders",
  "repo": "acme/orders-api",
  "commit": "abc123",
  "analyzedAt": "2026-08-07T00:00:00.000Z",
  "frameworks": ["express"],
  "coverage": {
    "discoveredRoutes": 5,
    "modeledOperations": 4,
    "uncoveredRoutes": [
      { "method": "GET", "path": "/admin", "reason": "dynamic route" }
    ],
    "dynamicRoutes": []
  },
  "auth": {
    "resolved": ["orders.list"],
    "unresolved": ["orders.admin"],
    "public": ["health.get"]
  },
  "schemas": {
    "inferred": ["Order"],
    "explicit": ["OrderCreateRequest"]
  },
  "confidence": {
    "overall": 0.85,
    "perOperation": { "orders.list": 0.9 }
  },
  "warnings": [
    { "code": "INFERRED_SCHEMA", "message": "Order schema inferred from DTO" }
  ]
}
```

## Confidence and gating

- `AI_CONFIDENCE_THRESHOLD = 0.6`: operations below this confidence are
  unavailable and cannot be executed or activated.
- `AI_DEFAULT_CONFIDENCE = 0.5`: used (with an `AI_UNSET_CONFIDENCE` warning)
  when the root block omits `confidence`.
- Importing with `--ai` but without a root `x-mcp-portico` block fails with
  `AI_METADATA_REQUIRED` (fail closed; never silently treated as plain
  OpenAPI).
- Malformed confidence values (non-numeric or outside 0..1) fail the import.

The executor already rejects unavailable operations, so a low-confidence or
unresolved-auth operation can never be called, regardless of connection
configuration.

## Determinism

Reviewable diffs require deterministic artifacts:

- `openapi.yaml` and `overlay.json` contain no timestamps and no absolute
  paths (timestamps belong only in `review-report.json`).
- Paths are sorted, operations are ordered by `operationId`, and object keys
  use a fixed order.
- Re-running the skill on the same repository revision produces byte-identical
  artifacts, and the compiled catalog checksum is stable.

## Initial framework references

- `references/framework-neutral.md` - discovery guidance that applies to any
  codebase.
- Per-framework notes in the same directory: Express, Fastify, NestJS,
  FastAPI, Flask, and Spring Boot.
