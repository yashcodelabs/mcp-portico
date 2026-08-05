# MCP Portico registry guide

The registry is the version-controlled security model for a deployment:
tenants, principals, backends, and connections. It is written as YAML or JSON,
validated with `mcp-portico registry validate`, and loaded by `serve` at
startup. Catalogs are referenced by file and pinned by checksum; secrets are
referenced as `env:VARIABLE_NAME`, never stored.

## File layout

```yaml
version: 1
tenants:
  - id: acme
    name: Acme
principals:
  - id: acme-automation
    tenantId: acme
    allowedConnectionIds: [acme-billing-prod]
backends:
  - id: billing
    title: Billing API
    scope: global # or "tenant" with ownerTenantId
    catalogRef: ./catalogs/billing.json
    catalogChecksum: sha256:6d58295e29802224dad1624bb8b4c1e22c45433d32f91c69216c76ff5d87ed0d
connections:
  - id: acme-billing-prod
    tenantId: acme
    backendId: billing
    baseUrl: https://billing.example.com
    network:
      allowedProtocols: [https]
    auth:
      type: bearer
      tokenRef: env:BILLING_PROD_TOKEN
    policy:
      disabledOperations: [invoice.delete]
      maxConcurrency: 2
```

The published JSON Schema is
[`schemas/registry.v1.schema.json`](../schemas/registry.v1.schema.json).

## Tenants and principals

- A **tenant** is the isolation boundary. Principals, connections,
  tenant-scoped backends, sessions, limits, caches, health state, and audit
  records all belong to exactly one tenant.
- A **principal** belongs to exactly one tenant and holds an explicit
  allowlist of that tenant's connections. Principals do not store keys in the
  file; `key create` writes a public key id and an HMAC digest.

### API keys

Keys are `mpp_<keyId>_<secret>` tokens. The registry stores only the key id and
an HMAC-SHA256 digest keyed by `MCP_PORTICO_KEY_PEPPER`; the plaintext secret
is printed once when created.

```bash
export MCP_PORTICO_KEY_PEPPER='choose-a-long-random-value'
mcp-portico key create --registry registry.yaml --tenant acme --principal acme-automation
```

`key create` refuses to write if the updated registry fails validation and
restores the previous file contents. Bearer auth mode (`--auth-mode bearer`)
requires the pepper and a keyed principal for every principal in the registry.

## Backends

- `scope: global` backends have no owner and may be referenced by connections
  from any tenant. They must not set `ownerTenantId`.
- `scope: tenant` backends require an existing `ownerTenantId` and may only be
  referenced by that tenant's connections.
- Every backend pins `catalogRef` and `catalogChecksum`; validation loads the
  catalog read-only and rejects a checksum mismatch. Identical checksums are
  deduplicated in memory.

A backend record alone grants nothing: access exists only through an enabled
connection, and catalog import never mutates the registry.

## Connections

Each connection belongs to exactly one tenant, references one backend, and
supplies the authoritative `baseUrl`. Registry validation rejects cross-tenant
principal allowlists, cross-tenant references to tenant-scoped backends,
missing or mismatched catalogs, duplicate ids, and auth that cannot satisfy the
catalog's security requirements.

### Auth types

All five upstream auth providers are built in; secret-bearing fields are
`env:` references.

- `none` - no upstream credentials.
- `bearer` - `tokenRef` (an `env:` reference to the bearer token).
- `apiKey` - `in: header|query`, `name`, `valueRef`.
- `basic` - `usernameRef`, `passwordRef`.
- `staticHeaders` - a `headers` map; values may be literals or `env:`
  references.

Connection-level `staticHeaders` cannot set hop-by-hop, host, framing, Portico
client, or authorization headers.

### Policy (monotonic)

Connection policy can only further restrict the catalog. Validation fails on:
disabling an operation that does not exist, weakening confirmation, raising
timeout/byte/concurrency limits above the catalog's strictest values, or
allowing content types the catalog never defines.

### Network policy

- `allowedProtocols` - `http` and/or `https`; defaults to `https` only.
- `allowLoopback`, `allowLinkLocal`, `allowPrivateNetwork` - default `false`.
- `redirects` - `none` (default) or `same-origin`.

Destinations are checked at load, at server startup (with DNS resolution), and
before every request. Loopback, link-local, private-network, and reserved
hostname targets are denied unless explicitly permitted. Cloud metadata
endpoints (`169.254.169.254`, `metadata.google.internal`, `fd00:ec2::254`) are
always denied, even with link-local enabled.

## Validation and probing

```bash
mcp-portico registry validate registry.yaml
mcp-portico connection test acme-billing-prod --registry registry.yaml --path /healthz
mcp-portico serve --registry registry.yaml --auth-mode bearer
```

`connection test` runs under the connection's full network and auth policy:
secret references must resolve, destinations are DNS-checked, redirects follow
the configured policy, and responses are size-limited and redacted.

`serve --registry` validates the complete registry, resolves every connection
secret, and checks destinations before listening. It watches the registry file
and publishes changes atomically: an invalid candidate leaves the previous
snapshot active, and valid changes invalidate affected sessions and caches.

## Runtime isolation

The tenant-aware runtime derives tenant and principal exclusively from the
authenticated Portico key. Sessions, rate and concurrency limits, response
caches, circuit breakers, health state, and audit records are namespaced by
tenant and connection (and principal where results vary). No client-supplied
value can select a tenant, connection, backend, or upstream origin.
