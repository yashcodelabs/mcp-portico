# MCP Portico

MCP Portico turns OpenAPI descriptions or inspected backend source code into
policy-controlled MCP connections. One deployment can expose multiple backend
systems while isolating tenants, credentials, catalogs, and runtime sessions.

> **Status:** Phase 1 (foundation) complete. This repository is a fresh
> implementation of the plan in
> [docs/mcp-portico-implementation-plan.md](docs/mcp-portico-implementation-plan.md);
> the predecessor project is used only as a reference and is not part of this
> repository.

## What it does (planned)

- **Catalog as the gate:** operations are compiled from OpenAPI/Swagger or
  AI-analyzed backend metadata into a validated catalog. Only catalog-gated
  operations can run, keyed by stable operation ID.
- **One deployment, many backends:** a backend registry and tenant-scoped
  connections isolate URLs, credentials, and policies.
- **Fixed MCP toolset:** discovery, description, and gated execution instead of
  arbitrary method/path input.
- **Operator CLI:** catalog import/validate/diff, registry validation,
  connection testing, and usage analysis.

## Planned interface

```text
mcp-portico serve
mcp-portico catalog import <openapi-file>
mcp-portico catalog validate <catalog-file>
mcp-portico catalog diff <old-catalog> <new-catalog>
mcp-portico registry validate <registry-file>
mcp-portico connection test <connection-id>
```

## Current state (Phase 1)

- Product identity constants (`mcp-portico`, `MCP_PORTICO_*`, `x-mcp-portico-*`,
  `~/.config/mcp-portico`).
- Shared secret-redaction and structured-error utilities.
- `IdentityProvider`, `SecretResolver`, and `UpstreamAuthProvider` interfaces.
- Loopback-only binding validation for unauthenticated mode.
- Operator CLI skeleton with a health-check server (`mcp-portico serve`).
- Deprecation/removal inventory for the legacy modules
  ([docs/deprecation-inventory.md](docs/deprecation-inventory.md)).
- CI with formatting/typecheck, unit tests, integration tests, fixture
  validation, and brand/secret sweeps.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm ci:check
pnpm mcp-portico --help
pnpm serve
```

The unauthenticated server refuses to bind to non-loopback interfaces by
default; that guard is enforced by
`MCP_PORTICO_AUTH_MODE=none` + loopback-only binding validation.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance and
[SECURITY.md](SECURITY.md) for the security policy.

## License

Apache-2.0. See [LICENSE](LICENSE).
