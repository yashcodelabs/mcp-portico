# Legacy module deprecation and removal inventory

This inventory records every module carried over from the predecessor project
and its disposition during the MCP Portico migration. The predecessor project
is preserved as a read-only reference at its original location and is not part
of this repository; no code from it is copied without adaptation.

> This file is the only documented exception to the brand-reference sweep.
> Legacy product names appear here intentionally so the rest of the repository
> can remain clean.

## Legacy product names and identifiers to sweep

The following strings must never reappear outside this file:

| Kind               | Legacy value                                    | Replacement                   |
| ------------------ | ----------------------------------------------- | ----------------------------- |
| Product name       | `mcpify`                                        | `MCP Portico` / `mcp-portico` |
| Product name       | `dfx`, `dfanx`, `digitalfanexperience`          | `MCP Portico`                 |
| Team identifiers   | `dev-grizzlies`, `dev-hawks`, `dev-chicago-sky` | none                          |
| Environment prefix | `DFX_*` (and `MCPIFY_*` if present)             | `MCP_PORTICO_*`               |
| Client headers     | `x-dfx-*` (and `x-mcpify-*` if present)         | `x-mcp-portico-*`             |
| Config home        | `~/.config/dfx-cli`                             | `~/.config/mcp-portico`       |
| Server name        | `dfx-mcp`                                       | `mcp-portico`                 |

## Disposition legend

- **Preserve and adapt** - generic infrastructure reused by MCP Portico, with
  product-specific behavior removed.
- **Replace** - superseded by a new MCP Portico module; the legacy module is
  removed.
- **Remove** - deleted; no replacement.

## Preserve and adapt

| Legacy module                                                | Disposition        | Lands in                           | Phase |
| ------------------------------------------------------------ | ------------------ | ---------------------------------- | ----- |
| Streamable HTTP MCP transport and session cleanup            | Preserve and adapt | `src/mcp/`                         | 5     |
| MCP Apps integration and API Explorer concept                | Preserve and adapt | `src/mcp/`                         | 5-7   |
| Catalog loading, checksumming, and schema-validation ideas   | Preserve and adapt | `src/catalog/`                     | 2     |
| Request body attachments and multipart MCP parsing           | Preserve and adapt | `src/runtime/`                     | 5     |
| Bulk execution with bounded concurrency                      | Preserve and adapt | `src/runtime/`                     | 5     |
| Usage telemetry and inspector middleware                     | Preserve and adapt | `src/telemetry/`, `src/inspector/` | 3, 7  |
| Confirmation semantics for mutating operations               | Preserve and adapt | `src/runtime/`                     | 5     |
| Origin checks, request limits, and structured error handling | Preserve and adapt | `src/runtime/`, `src/shared/`      | 3-5   |

## Replace or remove

| Legacy module                                                               | Disposition | Replacement                     | Phase |
| --------------------------------------------------------------------------- | ----------- | ------------------------------- | ----- |
| `src/bin.ts` and `src/commands/register.ts` domain commands                 | Remove      | `src/cli/` operator CLI         | 1, 7  |
| `src/core/operations.ts` and `src/core/shared-operations.ts`                | Remove      | catalog-driven execution        | 5, 7  |
| `src/mcp/cli-proxy.ts`                                                      | Remove      | none                            | 7     |
| `src/mcp/intent-aliases.ts`                                                 | Remove      | none                            | 7     |
| First-class/domain tools in `src/mcp/tools.ts`                              | Replace     | fixed MCP toolset               | 5     |
| Hardcoded path rewrites and body exceptions in `src/mcp/policy.ts`          | Replace     | catalog policy                  | 5     |
| Fixed org/workspace/env/locale context and headers                          | Remove      | tenant/principal identity       | 3     |
| `asset_upload` and `/api/assets` special handling                           | Replace     | generic transports              | 5     |
| `src/lib/auth-login.ts` and portal/cookie authentication                    | Replace     | `IdentityProvider`              | 3     |
| Preset files, preset UI, and preset activation tools                        | Replace     | registry/connections            | 3, 7  |
| Legacy config home, environment variables, headers, names, docs, and skills | Replace     | `src/shared/brand.ts` constants | 1     |
| NestJS/backend-specific catalog source analyzer                             | Replace     | AI analysis skill               | 6     |
| CLI/MCP parity runner and reports                                           | Remove      | none                            | 7     |

## Removal policy

- No legacy module is deleted until its replacement exists and passes the
  relevant phase exit criteria.
- The old runtime stays callable through Phase 4; the clean cutover happens in
  Phase 5, and legacy deletion finishes in Phase 7.
- The brand-reference and secret sweeps run in CI on every change, so legacy
  names and credentials cannot reappear.
