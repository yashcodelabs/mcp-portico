# Catalog

Catalog v2 is the compiled, validated runtime allowlist of operations and
schemas for one backend API.

- `types.ts` - catalog v2, normalized API model (IR), and policy overlay types
- `canonical.ts` - deterministic serialization and checksums
- `schema.ts` - JSON Schema validation against `schemas/`
- `validate.ts` - semantic fail-closed checks (paths, security, content types)
- `ids.ts` - deterministic operation ID generation
- `compile.ts` - normalized model + policy overlay -> catalog v2
- `overlay.ts` - policy overlay loading and validation
- `diff.ts` - catalog change classification
- `load.ts` / `index.ts` - loading, validating, and indexing catalogs

The OpenAPI/Swagger importers produce the normalized API model that feeds
`compileCatalog`.
