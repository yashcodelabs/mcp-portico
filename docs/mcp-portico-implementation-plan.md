# MCP Portico implementation plan

**Status:** Approved for planning  
**Date:** 2026-08-02  
**Target:** Replace the product-specific CLI/MCP server with a generic, multi-tenant MCP frontend for HTTP APIs.

## 1. Product definition

MCP Portico turns OpenAPI descriptions or inspected backend source code into policy-controlled MCP connections. One deployment can expose multiple backend systems while isolating tenants, credentials, catalogs, and runtime sessions.

The catalog is the runtime gate. MCP Portico must reject any operation, content type, authentication requirement, or target connection that is not explicitly present and enabled in the compiled catalog and registry.

### Locked decisions

- Product name: **MCP Portico**
- Repository and npm package: `mcp-portico`
- Executable: `mcp-portico`
- Environment prefix: `MCP_PORTICO_*`
- Config home: `~/.config/mcp-portico`
- License: Apache-2.0
- Administration in v1: config-as-code plus an operator CLI
- Runtime topology in v1: one process/replica
- Registry in v1: version-controlled YAML/JSON files
- Secret source in v1: environment-variable references
- Client authentication in v1: hashed static bearer API keys
- Upstream authentication in v1: none, bearer, API key, Basic, and controlled static headers
- OpenAPI input: Swagger 2.0 and OpenAPI 3.0, 3.1, and 3.2 in JSON or YAML
- AI repository analysis: generate OpenAPI plus a policy overlay, then use the same deterministic compiler
- Compatibility: clean break; no legacy compatibility layer
- Primary development environment: WSL 2 using the native Linux filesystem and Linux-native Git, Node.js, and pnpm
- Required compatibility targets: Linux and macOS; Windows support is secondary and must not constrain Unix-native behavior

### Development and verification environment

- The primary working copy must live inside the WSL filesystem, for example `~/projects/mcp-portico`, rather than under `/mnt/c`.
- Development, dependency installation, builds, tests, CLI smoke tests, and local server runs use WSL/Linux tooling.
- Do not alternate Windows and WSL tooling against the same checkout or share `node_modules` between operating systems.
- Linux CI and macOS CI are required release gates. WSL is the local Linux baseline, but it does not replace macOS CI because filesystem behavior and platform APIs differ.
- Shell commands and npm scripts must be POSIX-compatible where practical. Cross-platform Node.js scripts are preferred over shell-specific automation.
- Windows CI may remain as a secondary compatibility signal, but Phase 1 and release completion are based on passing Linux and macOS verification.

## 2. Scope

### Goals

- Expose any supported HTTP backend through a small, stable MCP toolset.
- Compile OpenAPI or AI-discovered metadata into one validated catalog format.
- Gate execution by stable operation ID rather than arbitrary method/path input.
- Host multiple backend definitions and connections in one deployment.
- Isolate tenants, connections, credentials, sessions, limits, and audit records.
- Support JSON, forms, multipart files, binary bodies, and text bodies.
- Keep an operator CLI for generation, validation, testing, serving, and usage analysis.
- Preserve useful infrastructure from the current project where it is generic.

### Non-goals for v1

- Database-backed configuration or a writable administration UI
- Multi-replica/HA deployment
- OAuth authorization-code or delegated-user flows
- OAuth client credentials, refresh-token management, mTLS, cloud identity, or request signing
- GraphQL-, gRPC-, SOAP-, or database-native catalog importers
- Full support for OpenAPI callbacks, links, and webhooks
- Generating one MCP tool per HTTP endpoint
- Backward compatibility with legacy configuration, tools, presets, or CLI commands

## 3. Core terminology

| Term           | Definition                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| Backend        | An API definition and its compiled catalog. It contains no deployment credentials.                       |
| Connection     | A tenant-authorized deployment of a backend: base URL, environment, authentication, headers, and policy. |
| Tenant         | The isolation boundary that owns principals and connections.                                             |
| Principal      | An authenticated MCP client identity within a tenant.                                                    |
| Session        | Temporary MCP state, including the selected connection. A session is not an authentication boundary.     |
| Catalog        | The compiled, validated, runtime allowlist of operations and schemas.                                    |
| Policy overlay | Human-reviewed rules that enrich or restrict imported API metadata.                                      |

## 4. Target architecture

```mermaid
flowchart LR
    OA["OpenAPI 2.0 / 3.x"] --> IM["Import adapters"]
    REPO["Backend repository"] --> AI["AI analysis skill"]
    AI --> OA2["Generated OpenAPI + policy overlay"]
    OA2 --> IM
    IM --> IR["Normalized API model"]
    POL["Policy overlay"] --> COMP["Catalog compiler"]
    IR --> COMP
    COMP --> CAT["Validated catalog v2"]
    CAT --> REG["Backend and connection registry"]
    SEC["Secret resolver"] --> REG
    IDP["Portico identity provider"] --> RT["Tenant-aware runtime"]
    REG --> RT
    RT --> MCP["Fixed MCP toolset"]
    MCP --> UP["Authorized upstream APIs"]
```

### Suggested source layout

```text
src/
  auth/                 # Portico identity and upstream auth providers
  catalog/              # v2 schema, loader, validator, compiler, diff
  cli/                  # operator CLI only
  importers/
    openapi/             # OpenAPI 2.0 and 3.x adapters
  registry/             # tenants, principals, backends, connections
  runtime/              # operation execution, transport selection, limits
  mcp/                  # MCP HTTP transport and fixed tool registration
  inspector/            # read-only operational UI
  telemetry/            # audit and usage persistence
  shared/               # errors, logging, redaction, utilities
schemas/                # published JSON Schemas
examples/               # sample specs, overlays, registries, and catalogs
test/fixtures/           # importer and runtime fixtures
```

## 5. Public interfaces

### Operator CLI

```text
mcp-portico serve
mcp-portico catalog import <openapi-file>
mcp-portico catalog validate <catalog-file>
mcp-portico catalog diff <old-catalog> <new-catalog>
mcp-portico registry validate <registry-file>
mcp-portico connection test <connection-id>
mcp-portico key create --tenant <tenant-id> --principal <principal-id>
mcp-portico usage summary
```

The CLI must not expose domain-specific endpoint commands or a generic arbitrary HTTP client.

### Fixed MCP toolset

| Tool                 | Purpose                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `list_connections`   | List connections authorized for the current principal.            |
| `select_connection`  | Select one authorized connection for the MCP session.             |
| `get_session`        | Return redacted principal, tenant, connection, and catalog state. |
| `search_operations`  | Search authorized catalog operations by text, tag, or risk.       |
| `describe_operation` | Return the complete input contract for an operation ID.           |
| `call_operation`     | Execute one catalog operation.                                    |
| `call_operations`    | Execute a bounded batch of independent operations.                |
| `test_connection`    | Perform the configured health/authentication probe.               |

`call_operation` must use `operationId`. It must not accept arbitrary upstream base URLs. Raw method/path execution may exist only in an explicitly enabled local debugging mode and must still be catalog-gated.

## 6. Authentication and secret strategy

### Portico client authentication

For v1, HTTP MCP clients authenticate with a high-entropy bearer API key:

```http
Authorization: Bearer mpp_<key-id>_<secret>
```

The registry stores the public key ID and a keyed HMAC digest, never the plaintext key. `MCP_PORTICO_KEY_PEPPER` supplies the server-side pepper. Authentication uses constant-time comparison. Each principal maps to exactly one tenant and an allowlist of connection IDs or roles.

`MCP_PORTICO_AUTH_MODE=none` is permitted only when the server binds to a loopback interface. Remote binding with authentication disabled must fail startup validation.

Define an `IdentityProvider` interface in phase 1 so OAuth 2.1 can replace static keys later without changing MCP tool handlers.

### Upstream backend authentication

Every connection selects an `UpstreamAuthProvider`. Built-in v1 providers:

- `none`
- `bearer`
- `apiKey` in a header or query parameter
- `basic`
- `staticHeaders` with an explicit header allowlist

Example:

```yaml
connections:
  billing-prod:
    tenantId: acme
    backendId: billing
    baseUrl: https://billing.example.com
    auth:
      type: bearer
      tokenRef: env:BILLING_PROD_TOKEN
```

Rules:

- Catalogs and registries contain secret references, not secrets.
- V1 resolves only `env:VARIABLE_NAME` references.
- Secrets never appear in MCP responses, inspector payloads, telemetry, errors, or logs.
- The compiler records OpenAPI security requirements for each operation.
- An operation remains disabled when its required security scheme cannot be satisfied by the connection.
- Portico client credentials are never forwarded upstream.
- Connection-level static headers cannot override hop-by-hop, host, content-length, or Portico security headers.

## 7. Catalog v2

The v2 catalog is a compiled artifact with a stable operation index. A simplified shape:

```json
{
  "catalogVersion": "2.0",
  "api": {
    "id": "billing",
    "title": "Billing API",
    "version": "1.4.0"
  },
  "provenance": {
    "sourceType": "openapi",
    "sourceChecksum": "sha256:...",
    "generatedAt": "2026-08-02T00:00:00Z"
  },
  "operations": {
    "invoice.get": {
      "method": "GET",
      "path": "/invoices/{invoiceId}",
      "tags": ["invoices"],
      "risk": "read",
      "request": {},
      "responses": {}
    }
  }
}
```

Required catalog capabilities:

- Stable operation IDs, with deterministic generated IDs when OpenAPI omits them
- Path, query, header, cookie, and body parameter schemas
- Request and response content types and JSON Schemas
- Security-scheme requirements
- Risk classification: `read`, `write`, or `destructive`
- Confirmation policy
- Per-operation timeout, request-size, response-size, and concurrency limits
- Sensitive-field redaction rules
- Cache eligibility and TTL
- Tags, summaries, descriptions, examples, and deprecation metadata
- Provenance, source checksum, compiler version, warnings, and confidence
- Semantic checks beyond JSON Schema validation
- Deterministic serialization so identical inputs produce identical catalogs

Policy overlays may disable operations, replace generated descriptions, assign risk, add context-derived headers, add limits, or mark fields sensitive. Overlays may restrict imported behavior but must not silently introduce an operation that does not exist in the normalized API model.

## 8. Phased implementation

### Phase 1 — Foundation, rebrand, and safety harness

**Objective:** Establish MCP Portico identity, repository boundaries, and a stable verification baseline before changing runtime behavior.

Work:

- Rename package, executable, config paths, headers, environment variables, server metadata, docs, and skills to MCP Portico.
- Add Apache-2.0 license, public README skeleton, security policy, and contribution notes.
- Create the target module directories while leaving the old runtime functional.
- Introduce shared secret-redaction and structured-error utilities.
- Introduce `IdentityProvider`, `SecretResolver`, and `UpstreamAuthProvider` interfaces.
- Add a deprecation/removal inventory for all legacy modules.
- Repair dependency installation and make build/test execution reliable in WSL/Linux and macOS.
- Add CI jobs for formatting/typecheck, unit tests, integration tests, catalog fixtures, and secret/reference sweeps.

Tests:

- Clean install, build, and test on supported Node versions in WSL/Linux, with equivalent clean-install verification on macOS CI.
- Brand-reference sweep contains no legacy product names.
- Redaction tests cover authorization, API keys, cookies, and configured sensitive fields.
- Loopback-only validation for unauthenticated mode.

Exit criteria:

- `mcp-portico --help`, `mcp-portico serve`, build, and tests run reliably.
- The old runtime is still callable while new module interfaces are available.
- CI prevents reintroduction of product-specific references or committed secrets.

### Phase 2 — Catalog v2 and deterministic compiler

**Objective:** Define the long-lived contract that all importers and runtime execution share.

Work:

- Publish catalog v2 JSON Schema under `schemas/`.
- Implement syntactic and semantic catalog validation.
- Create the normalized API intermediate representation.
- Implement policy-overlay schema and merger.
- Compile normalized models plus overlays into deterministic catalogs.
- Implement operation ID generation and collision reporting.
- Add catalog checksum, provenance, compiler warnings, confidence, and diff support.
- Add `catalog validate` and `catalog diff` CLI commands.
- Convert a small generic sample API manually as the reference fixture.

Tests:

- Golden catalog fixtures and deterministic-output snapshots.
- Invalid schemas, duplicate IDs, unresolved security schemes, unsafe paths, and unsupported content types fail closed.
- Overlay tests verify that policies restrict or annotate but cannot invent operations.
- Catalog diff classifies additions, removals, schema changes, and risk changes.

Exit criteria:

- A catalog can be compiled, validated, diffed, loaded, and indexed without legacy code.
- Identical inputs generate byte-identical canonical output except explicitly excluded timestamps.

### Phase 3 — Tenant registry, connections, and authentication

**Objective:** Build the security and isolation model before exposing the new execution runtime.

Work:

- Define schemas for tenants, principals, backends, and connections.
- Implement YAML/JSON registry loading and startup validation.
- Implement static bearer API-key identity with tenant and connection authorization.
- Add `key create`, `registry validate`, and `connection test` CLI commands.
- Implement environment secret references and all five v1 upstream auth providers.
- Namespace session state by authenticated principal and tenant.
- Add per-tenant and per-connection rate/concurrency limit hooks.
- Add audit records containing principal, tenant, connection, operation, outcome, and duration.
- Prevent arbitrary base URL and credential overrides from MCP tool arguments and client headers.

Security work:

- Restrict protocols to configured HTTP/HTTPS policy.
- Disable redirects by default; allow only explicitly configured same-origin redirects.
- Reject loopback, link-local, metadata-service, and private-network targets unless the connection explicitly permits them.
- Resolve and validate destinations at connection load and request time to reduce DNS rebinding risk.
- Strip hop-by-hop and unapproved client headers.

Tests:

- Cross-tenant connection access is denied.
- A session ID cannot be reused to cross a principal boundary.
- Auth providers inject credentials correctly without logging them.
- Unknown secret references fail startup or connection activation.
- SSRF, redirect, DNS, and header-injection test matrix.

Exit criteria:

- An authenticated principal can see only authorized connections.
- No client-controlled request value can select an unregistered upstream origin.
- Credentials are absent from all observable runtime outputs.

### Phase 4 — OpenAPI and Swagger importers

**Objective:** Convert standard API descriptions into the normalized model and catalog v2.

Work:

- Parse JSON and YAML inputs.
- Support Swagger 2.0 and OpenAPI 3.0, 3.1, and 3.2.
- Resolve local and explicitly permitted remote references with cycle detection and size limits.
- Normalize servers, paths, operation IDs, parameters, request bodies, responses, tags, security schemes, examples, and deprecations.
- Convert Swagger 2.0 host/basePath/schemes, definitions, body/form parameters, and security definitions.
- Emit structured coverage and unsupported-feature reports.
- Add `catalog import` CLI command with overlay support.
- Add representative fixtures for each supported specification version.

Unsupported features must produce warnings or hard failures according to policy. Callbacks, links, and webhooks are not executable in v1.

Tests:

- Golden import fixtures for OpenAPI 2.0, 3.0, 3.1, and 3.2.
- JSON and YAML versions generate equivalent normalized models.
- Reference cycles, external-reference restrictions, duplicate operation IDs, and incompatible schemas are reported.
- Authentication and multipart definitions survive import accurately.

Exit criteria:

- All supported fixture versions compile into valid catalog v2 artifacts.
- The importer never silently drops an executable operation or security requirement.

### Phase 5 — Operation runtime and generic transports

**Objective:** Cut over from raw path-based calls and legacy tools to catalog operation execution.

Work:

- Implement `list_connections`, `select_connection`, `get_session`, `search_operations`, `describe_operation`, `call_operation`, `call_operations`, and `test_connection`.
- Execute only by operation ID against the selected authorized connection.
- Validate path/query/header/cookie/body input using catalog schemas.
- Render paths and query strings without accepting unmodeled parameters by default.
- Implement JSON, URL-encoded form, multipart, binary, and text request transports.
- Generalize the existing attachment streaming infrastructure.
- Remove hardcoded `/api/assets` behavior and the `asset_upload` tool.
- Add response content-type handling, response-size limits, optional schema validation, and redaction.
- Preserve explicit confirmation for `write` and `destructive` operations according to catalog policy.
- Adapt bounded bulk execution to operation IDs and per-connection limits.
- Adapt MCP Apps/API Explorer UI to operation-based execution.

Tests:

- End-to-end calls for every request content type.
- Required and unknown parameter validation.
- Confirmation and risk-policy enforcement.
- Multipart streaming without buffering beyond configured limits.
- Response limits, redaction, schema validation, and malformed upstream responses.
- Bulk isolation, fail-soft/fail-fast behavior, and concurrency limits.

Exit criteria:

- The fixed MCP toolset can discover and execute all supported catalog operations.
- No production MCP tool accepts arbitrary upstream origins.
- Generic upload tests pass without any endpoint-specific code.

### Phase 6 — AI backend-analysis skill

**Objective:** Let an AI agent inspect backend repositories while preserving the same compiler and review controls used for OpenAPI.

Work:

- Create `.opencode/skills/mcp-portico-analyze/SKILL.md` and its Cursor mirror.
- Define framework-neutral discovery guidance and targeted references for initial supported frameworks.
- Require the skill to produce OpenAPI 3.2 plus a policy-overlay draft, not a production catalog.
- Capture discovered routes, schemas, middleware, authentication, permissions, multipart fields, and response shapes.
- Attach provenance and confidence to generated metadata.
- Generate a review report covering uncovered routes, dynamic behavior, unresolved authorization, and inferred schemas.
- Run generated artifacts through the standard importer/compiler/validator.

Tests:

- Fixture repositories with known expected routes and security requirements.
- Missing or uncertain authorization lowers confidence and blocks automatic activation.
- Generated OpenAPI and overlays are deterministic enough for reviewable diffs.
- The compiler rejects invented or malformed operations.

Exit criteria:

- An agent can analyze a fixture backend, generate review artifacts, and compile a valid catalog.
- No AI-generated catalog becomes active without deterministic validation and explicit operator action.

### Phase 7 — Inspector, legacy removal, documentation, and release

**Objective:** Complete the clean cutover and ship the first generic release.

Work:

- Rebuild the inspector around tenants, authorized connections, catalog metadata, warnings, health tests, audit activity, and redacted runtime state.
- Keep the inspector read-only except for safe connection tests in v1.
- Remove legacy domain CLI commands and `commander` registrations that expose them.
- Remove legacy first-class tools, CLI proxy, operation aliases, path rewrites, presets, portal login, and fixed org/workspace/locale context.
- Remove catalog generation logic tied to one NestJS codebase.
- Delete or rewrite all legacy tests, fixtures, docs, and skills.
- Add examples for a public OpenAPI API, two tenants, multiple connections, and each auth provider.
- Publish migration notes that explicitly state there is no compatibility layer.
- Run dependency, license, security, secret, branding, and package-content audits.
- Prepare `0.1.0` release of `mcp-portico` under Apache-2.0.

Tests:

- Full clean-install CI on Linux and macOS; Windows may run as a secondary non-blocking compatibility job.
- End-to-end multi-tenant MCP sessions against multiple fixture backends.
- Package smoke test from the packed npm artifact.
- Final scans find no legacy product names, team data, credentials, or hardcoded backend behavior.
- Documentation commands execute exactly as written.

Exit criteria:

- Only MCP Portico public interfaces remain.
- The old runtime and configuration model are fully removed.
- A new user can import an OpenAPI file, configure two connections, start the server, authenticate, discover operations, and execute a gated call from the published documentation.

## 9. Legacy code disposition

### Preserve and adapt

- Streamable HTTP MCP transport and session cleanup
- MCP Apps integration and API Explorer concept
- Catalog loading, checksumming, and schema-validation ideas
- Request body attachments and multipart MCP parsing
- Bulk execution with bounded concurrency
- Usage telemetry and inspector middleware
- Confirmation semantics for mutating operations
- Origin checks, request limits, and structured error handling

### Replace or remove

- `src/bin.ts` and `src/commands/register.ts` domain commands
- `src/core/operations.ts` and `src/core/shared-operations.ts`
- `src/mcp/cli-proxy.ts`
- `src/mcp/intent-aliases.ts`
- First-class/domain tools in `src/mcp/tools.ts`
- Hardcoded path rewrites and body exceptions in `src/mcp/policy.ts`
- Fixed org/workspace/env/locale context and headers
- `asset_upload` and `/api/assets` special handling
- `src/lib/auth-login.ts` and portal/cookie authentication
- Preset files, preset UI, and preset activation tools
- Legacy config home, environment variables, headers, names, docs, and skills
- NestJS/backend-specific catalog source analyzer after the generic AI skill is available
- CLI/MCP parity runner and reports

## 10. Verification strategy

The project must use layered verification:

The primary local verification environment is WSL 2 with the repository stored on its native Linux filesystem. Required CI verification runs on Linux and macOS so Unix compatibility is tested directly; WSL alone is not treated as proof of macOS compatibility.

1. **Schema tests:** catalog, overlay, registry, connection, and auth configuration.
2. **Compiler tests:** deterministic output and semantic validation.
3. **Importer tests:** golden fixtures for every supported OpenAPI version.
4. **Authorization tests:** principal, tenant, connection, and operation isolation.
5. **Security tests:** SSRF, redirects, DNS rebinding, unsafe headers, secret leakage, and response limits.
6. **Transport tests:** JSON, form, multipart, binary, text, and bulk.
7. **MCP integration tests:** discovery, session selection, operation execution, refresh notifications, and Apps UI metadata.
8. **Package tests:** clean installation, CLI smoke tests, server startup, and npm package contents.

No phase is complete merely because its code is merged. Its exit criteria and relevant security tests must pass first.

## 11. Major risks and mitigations

| Risk                                             | Mitigation                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Shared deployment becomes an SSRF proxy          | Server-owned connection URLs, network policy, DNS checks, redirect restrictions, and no arbitrary base URL tools. |
| Credential leakage                               | Secret references, centralized redaction, structured errors, audit tests, and no secret-bearing tool inputs.      |
| AI analyzer invents API behavior                 | Generate review artifacts, attach confidence, compile deterministically, and require explicit activation.         |
| OpenAPI feature complexity expands scope         | Support a documented HTTP subset and emit explicit coverage/unsupported reports.                                  |
| Catalog drift from backend                       | Source checksums, repeatable imports, catalog diff, and CI freshness checks.                                      |
| Tenant crossing through sessions or caches       | Principal/tenant namespace on all state, caches, limits, and telemetry; isolation tests.                          |
| One-process v1 limits availability               | Pluggable registry/session/telemetry interfaces prepare for Redis/database implementations later.                 |
| Rebrand and rewrite destabilize current behavior | Additive phases 1–4, controlled runtime cutover in phase 5, legacy deletion only in phase 7.                      |

## 12. Post-v1 roadmap

- MCP OAuth 2.1 authorization-server integration
- OAuth client-credentials and delegated upstream authentication
- Database-backed registry and writable administration UI
- Redis-backed sessions, rate limits, and multi-replica deployment
- Vault, AWS Secrets Manager, Azure Key Vault, and GCP Secret Manager providers
- mTLS, AWS SigV4, HMAC, and custom auth plugins
- Catalog signing and deployment promotion workflows
- OpenAPI callbacks/webhooks and additional API-description formats
- GraphQL and gRPC importers
- Role-based operation policies and approval workflows

## 13. Definition of v1 done

MCP Portico v1 is complete when a fresh installation can:

1. Import Swagger 2.0 or OpenAPI 3.0–3.2 from JSON or YAML.
2. Apply a policy overlay and compile a deterministic validated catalog.
3. Configure multiple tenants and backend connections without storing plaintext secrets.
4. Authenticate an MCP client with a tenant-scoped Portico API key.
5. Discover only authorized connections and operations.
6. Execute catalog-gated JSON, form, multipart, binary, and text operations by operation ID.
7. Enforce authentication, confirmation, limits, redaction, and tenant isolation.
8. Inspect redacted connection, catalog, health, and audit state.
9. Generate reviewable OpenAPI and overlay artifacts from a backend repository using the AI skill.
10. Pass the complete verification matrix and contain no legacy product-specific behavior or references.
