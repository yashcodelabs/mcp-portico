# Changelog

All notable changes to MCP Portico are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-08

First generic release under Apache-2.0. MCP Portico turns OpenAPI descriptions
or AI-analyzed backend source code into policy-controlled, multi-tenant MCP
connections.

### Added

- Foundation, branding, and safety harness (Phase 1): operator CLI, license,
  security policy, brand/secret sweeps, and CI.
- Catalog v2 and the deterministic compiler (Phase 2): stable operation IDs,
  policy overlays, checksums, warnings, and reviewable diffs.
- Tenant registry, connections, and authentication (Phase 3): tenants,
  principals, hashed bearer API keys, per-connection upstream auth providers,
  monotonic connection policy, and tenant-scoped isolation.
- OpenAPI and Swagger importers (Phase 4): Swagger 2.0 and OpenAPI 3.0/3.1/3.2,
  JSON and YAML, safe reference resolution, and structured import reports.
- Operation runtime and generic transports (Phase 5): the fixed MCP toolset,
  schema-validated execution, JSON/form/multipart/binary/text transports,
  confirmation for write/destructive operations, response limits, redaction,
  rate/concurrency/circuit isolation, and batch execution.
- AI backend-analysis skill (Phase 6): repository inspection produces
  deterministic OpenAPI + overlay + review-report artifacts, gated by
  confidence so uncertain findings can never be activated.
- Read-only tenant-scoped inspector, examples, migration notes, audits, and
  release packaging (Phase 7).

### Security

- Credentials are stored only as environment references; catalogs, registries,
  logs, and responses are redacted.
- Unauthorized tenants, backends, connections, and operations return the same
  non-enumerating error shapes.
- SSRF protections: destination allowlists, DNS checks, and redirect policy
  apply to every upstream call.

### Removed

- All predecessor-project surfaces. There is no compatibility layer; see
  [docs/migration.md](docs/migration.md).
