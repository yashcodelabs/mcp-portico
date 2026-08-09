# MCP Portico roadmap

**Purpose:** Evolve MCP Portico from a generic HTTP API gateway into a
client-neutral access layer for any MCP-compatible AI application.

**Current status:** v1 phases 1-7 are complete. The v1 runtime already keeps
backend access behind catalogs, tenant-scoped connections, policy checks, and
the fixed MCP toolset. This roadmap focuses on making that capability easier to
understand, integrate, and operate across AI application types.

## Product direction

MCP Portico is not tied to coding assistants. Its target clients include:

- coding assistants and developer tools;
- customer-support and service-desk agents;
- finance, operations, and business-intelligence agents;
- workflow, voice, and internal enterprise copilots;
- custom AI applications built on any MCP-compatible host.

The product promise is:

> MCP Portico securely connects any MCP-compatible AI application to approved
> internal APIs and backend systems while preserving tenant, user, policy, and
> credential boundaries.

The client selects from capabilities exposed by Portico. It never selects an
arbitrary upstream origin, supplies a tenant identity, or receives backend
credentials.

## Prioritized roadmap

Effort is relative engineering effort: low means documentation or contained
changes, medium means cross-cutting implementation and tests, and high means
new security-sensitive infrastructure or protocols.

| Priority | Workstream                                                             | Effort      | Impact      | Timing   |
| -------- | ---------------------------------------------------------------------- | ----------- | ----------- | -------- |
| P1       | Generic product language and repository positioning                    | Low         | High        | Next     |
| P1       | Client-neutral architecture diagram and README examples                | Low         | High        | Next     |
| P1       | Domain examples beyond coding assistants                               | Low         | Medium      | Next     |
| P2       | Formal MCP client compatibility contract                               | Medium      | High        | After P1 |
| P2       | MCP interoperability test matrix                                       | Medium      | High        | After P1 |
| P2       | Explicit user, tenant, client, and backend identity boundaries         | Medium      | High        | After P1 |
| P3       | Policy, audit, quotas, and operational observability improvements      | Medium–High | High        | Later    |
| P4       | GraphQL, gRPC, and additional backend adapters                         | High        | Medium–High | Later    |
| P4       | OAuth token exchange, delegated authorization, refresh, and revocation | High        | Very high   | Later    |

P1 and P2 are the implementation focus of this roadmap revision. OAuth is
intentionally not part of that work; it remains a later security-sensitive
roadmap item as agreed for v1.

## Priority 1 — Generic positioning and examples

**Outcome:** A new user should immediately understand that MCP Portico is an
MCP gateway for any AI application, not a coding-agent adapter.

### P1.1 Product language

- [x] Use “MCP clients,” “AI applications,” or “AI agents” as the primary
      terms; use coding products only as examples.
- [x] Update the README tagline, status text, feature descriptions, and
      authentication explanation to use client-neutral language.
- [x] State explicitly that MCP Portico does not depend on a particular model,
      vendor, agent framework, or user-interface type.
- [x] Keep “coding assistant” examples where useful, but label them as one
      client category among many.
- [x] Review CLI help, error text, documentation, examples, and repository
      metadata for accidental coding-agent assumptions.

### P1.2 Architecture and landing-page presentation

- [x] Change the primary diagram to show a generic “MCP-compatible AI
      applications” block connected to MCP Portico.
- [x] Keep a small examples caption or legend for coding, support, workflow,
      BI, voice, and custom clients rather than making vendor logos the contract.
- [x] Preserve the three-block message: AI applications → MCP Portico →
      authorized backend systems.
- [x] Keep the diagram self-contained and renderable by GitHub without remote
      nested images.
- [x] Add one short paragraph explaining that Portico is the security and
      policy boundary between AI clients and internal systems.

### P1.3 Domain examples

- [x] Add a support-agent example that searches a ticketing API and reads a
      customer profile through catalog-gated operations.
- [x] Add an operations or finance example that reads approved internal data
      without exposing arbitrary database or service URLs.
- [x] Add a workflow-agent example that demonstrates confirmation for a
      mutating operation.
- [x] Keep examples credential-free and runnable with fixture backends.
- [x] Document which parts are generic MCP behavior and which parts are
      backend-specific catalog configuration.

### Priority 1 acceptance criteria

- The README describes MCP Portico without requiring a coding-agent context.
- The architecture diagram is understandable without recognizing any vendor
  logo.
- At least three non-coding use cases are documented.
- Documentation and examples do not imply that MCP Portico owns or provisions
  the model, agent, or upstream identity provider.
- Brand and secret sweeps remain clean.

## Priority 2 — Client-neutral MCP contract and boundaries

**Outcome:** Different MCP hosts can integrate with the same Portico deployment
using a documented, predictable contract, while identity and authorization
remain server-owned.

### P2.1 Define the compatibility contract

- [x] Document the supported MCP lifecycle: initialize, capability
      negotiation, session handling, discovery, operation description, execution,
      errors, and shutdown.
- [x] Document the fixed Portico tool contract and its stable input/output
      shapes. Backend operations remain catalog data, not dynamically registered
      arbitrary tools.
- [x] Define the supported transport profiles separately, including local and
      remote deployment expectations. A client must not need backend-specific
      knowledge to choose a connection.
- [x] Specify limits and behavior for pagination, bulk calls, attachments,
      binary responses, confirmations, timeouts, and upstream failures.
- [x] Provide a short “MCP client integration” guide with examples for a
      generic host, a remote host, and a custom application.

### P2.2 Build the interoperability test matrix

- [x] Add protocol fixtures for initialization, capability negotiation, tool
      discovery, descriptions, calls, errors, cancellation, and session cleanup.
- [x] Run the same contract tests against each supported transport profile.
- [x] Test clients with different request ordering, pagination sizes, and
      unknown optional fields to ensure the server remains forward-compatible.
- [x] Verify that unauthorized tools, connections, operations, and tenants
      fail with non-enumerating responses.
- [x] Keep the test harness independent of a specific model provider or agent
      UI; use deterministic MCP messages and fixture backends.
- [x] Add Linux and macOS CI coverage for the interoperability suite. Windows
      remains a secondary compatibility signal.

### P2.3 Make identity boundaries explicit

- [x] Treat the MCP client credential as the identity of the calling client
      principal, not as proof of a user-selected tenant or backend.
- [x] Derive tenant and principal exclusively from the authenticated Portico
      credential. Reject tenant, principal, connection, and origin overrides in
      MCP arguments or imported content.
- [x] Keep client authentication, upstream backend authentication, and future
      delegated user authentication as separate contracts.
- [x] Include client, tenant, principal, connection, backend, catalog checksum,
      operation, and outcome in redacted audit events.
- [x] Confirm that sessions, caches, limits, telemetry, and inspector queries
      preserve the same isolation dimensions.
- [x] Document the current v1 static bearer-key model and mark OAuth/token
      exchange as a later extension point rather than implying it is implemented.

### Priority 2 acceptance criteria

- A custom MCP application can integrate using the public contract without
  reading Portico implementation details.
- Contract tests pass for every supported transport on Linux and macOS.
- No MCP request can select an arbitrary upstream URL or override tenant and
  principal identity.
- Client credentials cannot be reused as upstream credentials by accident.
- Audit, session, cache, rate-limit, and inspector tests prove tenant and
  principal isolation.
- Adding a new MCP host does not require adding backend-specific code.

## Later roadmap

These items remain intentionally sequenced after P1 and P2:

1. Strengthen policy administration, audit search, quotas, rate limits, and
   operational observability.
2. Add secret providers such as Vault, AWS Secrets Manager, Azure Key Vault,
   and GCP Secret Manager.
3. Add mTLS, SigV4, HMAC, and pluggable upstream authentication.
4. Add GraphQL, gRPC, and other catalog/import adapters.
5. Add OAuth 2.1 authorization-server integration, delegated user consent,
   token exchange, refresh, revocation, and per-user upstream authorization.
6. Add catalog signing, promotion workflows, database-backed registry, and
   multi-replica runtime support.

## Delivery and maintenance

- Keep this file as the source of truth for roadmap priority and sequencing.
- Convert each unchecked work item into a GitHub issue or pull request when
  implementation begins; link it from the relevant checkbox.
- Mark an item complete only after its acceptance criteria and relevant CI
  checks pass.
- Update effort and impact when implementation reveals new security or
  interoperability constraints.
- Keep roadmap changes separate from runtime changes when possible so product
  direction remains easy to review.
