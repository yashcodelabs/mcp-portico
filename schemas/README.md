# Published JSON Schemas

- `catalog.v2.schema.json` - catalog v2, the compiled runtime allowlist of
  operations and schemas for one backend API.
- `overlay.v1.schema.json` - policy overlay v1, the human-reviewed rules
  applied during catalog compilation.
- `registry.v1.schema.json` - registry v1, the version-controlled tenants,
  principals, backends, and connections that form the multi-tenant security
  model. Catalogs are referenced by file and pinned by checksum; secrets are
  referenced as `env:VARIABLE_NAME`, never stored.
