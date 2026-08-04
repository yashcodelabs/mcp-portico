# Contributing to MCP Portico

## Prerequisites

- Node.js >= 22
- pnpm 11 (the repository pins `packageManager: pnpm@11.9.0`)

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

## Verification checklist

Run the full local gate before opening a pull request:

```bash
pnpm ci:check
```

This runs, in order:

1. Typecheck (`tsc --noEmit`)
2. Format check (Prettier)
3. Unit and integration tests (Vitest)
4. Fixture validation (JSON/YAML fixtures under `examples/` and `test/fixtures/`)
5. Brand-reference and secret sweep
6. Production build
7. CLI smoke test (built `mcp-portico` binary: `--help` and `serve`)

CI runs the same gate on Linux (Node 22 and 24), macOS (Node 22 and 24), and
Windows (Node 22).

## Security rules

- Never commit secrets, tokens, or live API keys; the secret sweep will fail CI.
- Never introduce legacy product names or identifiers (see the sweep terms in
  [docs/deprecation-inventory.md](docs/deprecation-inventory.md)); the brand
  sweep will fail CI. That inventory file is the only documented exception.
- All runtime outputs must pass through the shared redactor before being
  observed (logs, errors, MCP responses, inspector payloads, telemetry).
- Authentication and secret resolution go through the `IdentityProvider`,
  `SecretResolver`, and `UpstreamAuthProvider` interfaces; do not inline
  credential handling into tool handlers.
- Fail closed: unknown operations, content types, auth requirements, and target
  connections must be denied.

## Repository layout

```text
src/auth/          Portico identity and upstream auth provider contracts
src/catalog/       Catalog v2 schema, loader, validator, compiler (Phase 2)
src/cli/           Operator CLI only
src/importers/     OpenAPI 2.0 and 3.x adapters (Phase 4)
src/inspector/     Read-only operational UI (Phase 7)
src/mcp/           MCP HTTP transport and fixed tool registration (Phase 5)
src/registry/      Tenants, principals, backends, connections (Phase 3)
src/runtime/       Operation execution, transport selection, limits (Phase 5)
src/shared/        Brand, errors, redaction, config utilities
src/telemetry/     Audit and usage persistence (Phase 3)
schemas/           Published JSON Schemas (Phase 2)
examples/          Sample specs, overlays, registries, catalogs (later phases)
test/fixtures/     Importer and runtime fixtures
```
