# OpenAPI importer

Phase 4: converts Swagger 2.0 and OpenAPI 3.0/3.1/3.2 documents (JSON or
YAML) into the normalized API model, then the deterministic catalog compiler
produces an inert catalog v2 artifact plus a structured import report.

- `parse.ts` - input reading, JSON/YAML parsing, and spec-version detection
- `refs.ts` - reference resolution: local `#/...` refs always; external file
  and URL refs denied by default and only loaded under an explicit operator
  policy with protocol/host allowlists, DNS and redirect checks, timeouts,
  and byte/depth/document limits
- `normalize.ts` - Swagger 2.0 and OpenAPI 3.x adapters into the normalized
  model; unsupported features are reported, never silently dropped
- `import.ts` - orchestration: parse, resolve refs, normalize, apply an
  optional policy overlay, compile, and emit the report

Import is an operator-only build step. It never reads, mutates, or activates
registry state: a backend becomes visible only after an operator assigns
backend scope/ownership, pins the catalog checksum, creates tenant
connections, and publishes a validated registry snapshot.
