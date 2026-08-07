---
name: mcp-portico-analyze
description: Analyze a backend repository and produce inert, deterministic MCP Portico import artifacts (OpenAPI 3.2, policy overlay, review report). Never activates or edits catalogs or registry entries.
---

# mcp-portico-analyze

Analyze a backend repository and produce inert, deterministic, reviewable
import artifacts for MCP Portico. The output feeds the standard
import/validate/diff pipeline — it is never a production catalog, never a
registry edit, and never an activation. AI output becomes executable only
after an operator compiles and validates it, assigns backend scope and
ownership, pins the catalog checksum, creates tenant connections, and
publishes a validated registry snapshot.

## Purpose

Inspect the repository's routes, controllers and handlers, DTOs and schemas,
middleware, authentication, permissions, multipart fields, and response
shapes, then emit three inert artifacts into `analysis/out/` exactly as
specified by `docs/ai-analysis.md`. Attach provenance and per-operation
confidence so operators can review and gate everything.

## Output contract

Write exactly these three files and nothing else:

| Artifact                          | Contents                                                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `analysis/out/openapi.yaml`       | OpenAPI 3.2 document with a root `x-mcp-portico` block and a per-operation `x-mcp-portico` block on every operation                     |
| `analysis/out/overlay.json`       | Policy overlay v1 (validated against `schemas/overlay.v1.schema.json`); operation keys are the `operationId` values from `openapi.yaml` |
| `analysis/out/review-report.json` | Stable, free-form review report for operators: coverage, auth, schemas, confidence, warnings                                            |

Do not write `catalog.json`, registry files, or any file outside
`analysis/out/`.

### Root `x-mcp-portico` block (openapi.yaml)

Required when importing with `--ai`:

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

`repo` is the repository identifier and `commit` the analyzed revision. Every
warning uses a stable `code` plus a `message`.

### Per-operation `x-mcp-portico` block

Every operation must carry an explicit `operationId` and this block:

```json
{
  "x-mcp-portico": {
    "confidence": 0.9,
    "authStatus": "resolved"
  }
}
```

`confidence` is a number in `0..1`; `authStatus` is one of `resolved`,
`unresolved`, or `public`.

### `authStatus` semantics

| Value        | Meaning                                                      |
| ------------ | ------------------------------------------------------------ |
| `resolved`   | A concrete security requirement was found in the repo.       |
| `unresolved` | Authorization could not be determined; compiled unavailable. |
| `public`     | No authorization was found for the route.                    |

Gating rules:

- `authStatus: "unresolved"` compiles the operation as unavailable (warning
  `UNRESOLVED_AUTHORIZATION`).
- `confidence < 0.6` compiles the operation as unavailable (warning
  `LOW_CONFIDENCE`).
- `AI_CONFIDENCE_THRESHOLD = 0.6`. `AI_DEFAULT_CONFIDENCE = 0.5` is used only
  when the root block omits `confidence`, with an `AI_UNSET_CONFIDENCE`
  warning.
- Importing with `--ai` but without a root `x-mcp-portico` block fails with
  `AI_METADATA_REQUIRED`. Non-AI imports ignore `x-mcp-portico` entirely.

### `overlay.json`

Policy overlay v1 with `overlayVersion: "1.0"` and an `operations` object
keyed by operationId. Overlays can set risk, confirmation, cache,
redactions, descriptions, and limits. They can never invent operations: every
key must exist in `openapi.yaml`.

### `review-report.json`

Free-form but stable. Follow the shape in `docs/ai-analysis.md`:
`reportVersion`, `apiId` (must match the `--api-id` used at import), `repo`,
`commit`, `analyzedAt`, `frameworks`, `coverage`, `auth`, `schemas`,
`confidence`, and `warnings`. This is the only artifact that may contain a
timestamp.

## Determinism

- `openapi.yaml` and `overlay.json` contain no timestamps and no absolute
  paths; timestamps belong only in `review-report.json`.
- Paths are sorted, operations are ordered by `operationId`, and object keys
  use a fixed order.
- Re-running on the same repository revision yields byte-identical
  `openapi.yaml` and `overlay.json` (and therefore a stable compiled catalog
  checksum). `review-report.json` differs at most in its `analyzedAt`
  timestamp.
- Record repository paths relative to the repository root; never write
  absolute paths into artifacts.

## Confidence

Assign each operation a confidence in `0..1` from evidence, not hope:

- `0.9+`: request flow fully traced, auth proven, schemas declared.
- `0.7-0.89`: mostly traced with minor inference (for example, response
  shape).
- `0.5-0.69`: partial evidence; substantial inference or uncertainty.
- Below `0.5`: dominated by guessing; keep the operation out of the
  document.

Rules:

- Inferred schemas lower confidence and add an `INFERRED_SCHEMA` warning.
- Uncertain authorization must lower confidence and use `authStatus:
"unresolved"` rather than guessing.
- An operation with `confidence < 0.6` or `authStatus: "unresolved"` stays in
  the document; the compiler marks it unavailable, so it can never be
  executed or activated.

## Discovery workflow

1. Read `references/framework-neutral.md` completely.
2. Read the matching per-framework reference (`express.md`, `fastify.md`,
   `nestjs.md`, `fastapi.md`, `flask.md`, or `spring.md`) when the repository
   uses one of those frameworks.
3. Trace routes, handlers, schemas, middleware, auth, permissions, multipart
   fields, and response shapes; record everything that could not be resolved.
4. Write the three artifacts per the contract above.

## Required verification

After writing the artifacts, run the standard pipeline and confirm each step:

```text
mcp-portico catalog import analysis/out/openapi.yaml \
  --api-id <id> --ai \
  --overlay analysis/out/overlay.json \
  --output analysis/out/catalog.json \
  --report analysis/out/import-report.json
mcp-portico catalog validate analysis/out/catalog.json
mcp-portico catalog diff previous-catalog.json analysis/out/catalog.json
```

- Import must not fail with `AI_METADATA_REQUIRED`, malformed confidence, or
  overlay-schema errors; fix the artifacts and re-run.
- Validate the compiled catalog; it must pass.
- Diff against the previous revision's catalog when one exists and confirm
  every addition, removal, and schema change matches the analysis.

## Hard rules

- Never write or modify registry files, connections, or any file outside
  `analysis/out/` during analysis.
- Never invent endpoints, parameters, or schemas; every operation must trace
  to repository code.
- Never emit secrets or real credentials; redact values found in the repo and
  use `<TOKEN>` / `<API_KEY>` placeholders in examples.
- Treat AI output as inert until an operator activates it: no tenant access,
  no execution, and no publication without the normal validated registry
  cycle.

## Checklist

Discovery completeness:

- [ ] Framework identified and the matching reference used.
- [ ] Every route traced to a handler; uncovered and dynamic routes
      recorded.
- [ ] Schemas, DTOs, and validators recorded; inferred schemas flagged.
- [ ] Middleware, auth guards, and permissions traced per route.
- [ ] Multipart field names and response shapes recorded.

Artifact validation:

- [ ] Exactly three artifacts written to `analysis/out/`; no other files
      touched.
- [ ] Every operation has an explicit `operationId` and `x-mcp-portico`
      block with `confidence` in `0..1` and a valid `authStatus`.
- [ ] Determinism rules followed: sorted paths, operationId order, no
      timestamps or absolute paths outside `review-report.json`.
- [ ] Import, validate, and diff all pass.

Activation handoff:

- [ ] Summary handed to the operator: coverage, unresolved auth, inferred
      schemas, warnings.
- [ ] No registry or connection changes made; activation left to the
      operator.
