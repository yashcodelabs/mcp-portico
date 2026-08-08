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

1. Dependency audit (`pnpm audit --prod`)
2. Typecheck (`tsc --noEmit`)
3. Format check (Prettier)
4. Unit and integration tests (Vitest)
5. Fixture validation (JSON/YAML fixtures under `examples/` and `test/fixtures/`)
6. Brand-reference and secret sweep
7. Production build
8. CLI smoke test (built `mcp-portico` binary: `--help` and `serve`)
9. Package smoke test (tarball contents, dependency licenses, doc links, and
   installed CLI behavior)

CI runs the same gate on Linux (Node 22 and 24), macOS (Node 22 and 24), and
Windows (Node 22).

## Release checklist

Linux and macOS CI are the release gates; Windows CI is a non-blocking
compatibility signal. Before publishing a release:

1. Run the full local gate: `pnpm ci:check`.
2. Run the dependency and license audits explicitly:
   `pnpm audit:deps` (production vulnerabilities) and `pnpm test:pack`
   (package contents, license audit of every installed production
   dependency, and packaged documentation link check).
3. Run the brand and secret sweeps: `pnpm sweep:brand` and
   `pnpm sweep:secrets`.
4. Pack with `pnpm pack`. The `prepack` script rebuilds `dist/` first, so the
   tarball always contains fresh build output; never pack an existing `dist/`.
5. Verify the walkthrough commands in
   [examples/README.md](examples/README.md) from a clean checkout
   (`pnpm install && pnpm build`, then import, validate, key create, serve,
   and an MCP session). CI runs the import/validate/key-create part of the
   walkthrough on every Linux/macOS run.
6. Confirm the published package contains only the intended files: the
   `files` allowlist in `package.json` plus `dist/`, `schemas/`, `examples/`,
   the user-facing `docs/` files (`registry.md`, `migration.md`,
   `deprecation-inventory.md`), `CHANGELOG.md`, `CONTRIBUTING.md`,
   `SECURITY.md`, `LICENSE`, and `README.md`. Dev-only documents
   (`docs/mcp-portico-implementation-plan.md`, `docs/ai-analysis.md`,
   `docs/assets/`) are referenced from the README via GitHub URLs and are not
   shipped.
7. Update `CHANGELOG.md` with the release notes before tagging.

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
