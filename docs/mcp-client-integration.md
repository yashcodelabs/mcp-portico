# MCP client integration guide

**Status:** Public guide for MCP client integrators
**Applies to:** MCP Portico 0.1.0, protocol `2025-06-18`
**Updated:** 2026-08-09

This guide shows how to connect three kinds of clients to the same Portico
deployment:

1. a generic MCP host (including Cursor, Claude Code, and Codex);
2. a remote host talking to a TLS-terminated deployment;
3. a custom application speaking JSON-RPC directly.

All three use the exact same contract - see
[mcp-compatibility-contract.md](mcp-compatibility-contract.md) - and need
only two things from the operator: the MCP endpoint URL and a Portico API key
(`mpp_<keyId>_<secret>`) for the tenant principal.

## 1. Generic MCP host

Any MCP-compatible host (coding assistant, support agent, workflow copilot,
BI assistant, voice agent, or custom framework) can register Portico as a
remote MCP server. Host configuration is framework-specific but the values
are not:

```json
{
  "name": "mcp-portico",
  "transport": "http",
  "url": "http://127.0.0.1:3000/mcp",
  "headers": { "Authorization": "Bearer mpp_<keyId>_<secret>" }
}
```

The host normally performs `initialize` and
`notifications/initialized` itself. Client responsibilities:

- send the bearer header on every `tools/*` and `resources/*` request (some
  hosts need the header configured as "always send");
- treat `isError: true` tool results as handled tool errors, not transport
  failures;
- follow the session flow: `list_connections` -> `select_connection` ->
  `get_session` before calling catalog operations;
- when a write call returns `requiresConfirmation: true`, present the
  `message` to the user and re-call with `confirmationToken`;
- when a session-scoped call returns
  `No active session; select a connection first.`, re-run
  `select_connection` (registry reloads or revocations invalidate sessions);
- expect complete result sets: v1 does not paginate, so do not loop on
  cursors.

### Cursor

Create `.cursor/mcp.json` in the project that should use the tools:

```json
{
  "mcpServers": {
    "mcp-portico": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer mpp_<keyId>_<secret>"
      }
    }
  }
}
```

Cursor supports remote Streamable HTTP MCP servers and project-scoped
`.cursor/mcp.json` configuration. The demo prints this exact block with its
temporary endpoint and key.

### Claude Code

The shortest setup is:

```bash
claude mcp add --transport http \
  --header "Authorization: Bearer mpp_<keyId>_<secret>" \
  mcp-portico https://mcp.example.com/mcp
```

For a checked-in project configuration, use `.mcp.json`:

```json
{
  "mcpServers": {
    "mcp-portico": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer mpp_<keyId>_<secret>"
      }
    }
  }
}
```

The demo prints both the `claude mcp add` command and the JSON form. Start it
with `mcp-portico demo --connect claude`, copy the printed command in another
terminal, and leave the demo process running while Claude Code connects.

### Codex

Codex supports Streamable HTTP MCP servers with bearer authentication. Add the
printed table to `~/.codex/config.toml`, or to a trusted project-scoped
`.codex/config.toml`:

```toml
[mcp_servers.mcp_portico_demo]
url = "https://mcp.example.com/mcp"
http_headers = { Authorization = "Bearer mpp_<keyId>_<secret>" }
```

The demo prints this block with its temporary values:

```bash
mcp-portico demo --connect codex
```

After adding it, restart Codex or use `/mcp` to verify the connected tools.

## Sample host interaction

Once Cursor, Claude Code, or Codex is connected, ask:

```text
You: Which open orders are at risk from tomorrow's weather?

Host: I found 2 elevated-risk orders:
      ORD-1001 in New York — 80% rain probability.
      ORD-1003 in Chicago — 70% rain probability and 48 km/h wind.
      Both have substitute inventory in another warehouse.

You: What is the total order value exposed?

Host: $4,080 across 2 open orders.
```

The host chooses and sequences MCP tools; Portico authenticates the host,
selects the allowed tenant connection, and makes the upstream HTTP calls.

Typical tool flow:

```text
tools/call list_connections
  -> { connections: [{ id: "acme-billing", ... }] }
tools/call select_connection { connectionId: "acme-billing" }
  -> { session: { id, tenantId, connectionId, catalogChecksum } }
tools/call search_operations { query: "invoice" }
  -> { operations: [...] }
tools/call describe_operation { operationId: "invoice.get" }
  -> { operation: { operationId, method, path, ... } }
tools/call call_operation { operationId: "invoice.get", arguments: { invoiceId: "INV-001" } }
  -> text blocks: response body + "status: 200; bytes: ...; durationMs: ..."
```

## 2. Remote host (TLS-terminated deployment)

A remote deployment is the same server behind a reverse proxy that owns TLS.
The host configuration differs only in the URL and, optionally, in requiring
the operator's CA if the certificate is private:

```json
{
  "name": "mcp-portico",
  "transport": "http",
  "url": "https://mcp.example.com/mcp",
  "headers": { "Authorization": "Bearer mpp_<keyId>_<secret>" }
}
```

Operator expectations for the proxy:

- forward `POST /mcp` unchanged, preserving the request body, `Authorization`
  header, and path;
- terminate TLS and optionally add standard security headers;
- keep the proxy's timeout above the largest connection/operation upstream
  timeout (default 30 s, maximum 600 s in policy) so Portico - not the proxy -
  is the one that reports `Upstream request timed out.`;
- do not strip `Accept: application/json, text/event-stream`.

The MCP contract is byte-for-byte identical to the loopback profile; only the
base URL and TLS termination differ. A remote host must not be given backend
URLs or credentials - `list_connections` and the catalog are the only
discovery surface it needs.

## 3. Custom application (direct JSON-RPC)

A custom application can speak the contract directly with any HTTP client.
The full flow is deterministic JSON-RPC over `POST /mcp`:

```ts
const baseUrl = 'https://mcp.example.com/mcp';
const token = process.env.PORTICO_KEY!;

async function mcp(method: string, params: unknown, id: number, authenticated = true) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    }),
  });
  if (response.status === 202) return undefined; // notification ack
  return (await response.json()) as any;
}

// 1. Negotiate (unauthenticated) and signal readiness.
await mcp(
  'initialize',
  {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'acme-agent', version: '1.0.0' },
  },
  1,
  false,
);
await mcp('notifications/initialized', undefined, 2, false); // -> 202

// 2. Select a connection (authenticated).
const listed = await mcp(
  'tools/call',
  {
    name: 'list_connections',
    arguments: {},
  },
  3,
);
const connection = (
  JSON.parse(listed.result.content[0].text) as {
    connections: { id: string }[];
  }
).connections[0];

await mcp(
  'tools/call',
  { name: 'select_connection', arguments: { connectionId: connection.id } },
  4,
);

// 3. Execute a read operation.
const read = await mcp(
  'tools/call',
  {
    name: 'call_operation',
    arguments: { operationId: 'invoice.get', arguments: { invoiceId: 'INV-001' } },
  },
  5,
);
const text = read.result.content
  .map((block: { text: string }) => block.text)
  .join('\n');
console.log(text); // response body + "status: 200; ..."

// 4. Confirm and execute a write operation.
const first = await mcp(
  'tools/call',
  {
    name: 'call_operation',
    arguments: {
      operationId: 'invoice.create',
      arguments: { body: { amount: 12.5, currency: 'USD' } },
    },
  },
  6,
);
const confirmation = JSON.parse(first.result.content[0].text);
const second = await mcp(
  'tools/call',
  {
    name: 'call_operation',
    arguments: {
      operationId: 'invoice.create',
      arguments: { body: { amount: 12.5, currency: 'USD' } },
      confirmationToken: confirmation.token,
    },
  },
  7,
);
```

Notes for custom applications:

- `initialize` and notifications are unauthenticated; everything else
  requires the bearer header.
- Notifications (requests without an `id`, including
  `notifications/cancelled`) always come back as `202` with an empty body.
- JSON-RPC errors (codes `-32700` through `-32603`, `-32001`, `-32003`)
  indicate protocol, transport, or authentication failures; `isError: true`
  results indicate tool-level failures.
- Close HTTP connections when done; there is no MCP shutdown method, and
  sessions are ephemeral in-memory state that ends with the process or a
  registry reload.

## 4. Integration checklist

- [ ] Endpoint: `POST /mcp` with `content-type: application/json`.
- [ ] Auth: `Authorization: Bearer mpp_...` on `tools/*` and `resources/*`.
- [ ] Lifecycle: `initialize` -> `notifications/initialized` ->
      `list_connections` -> `select_connection` -> calls.
- [ ] Confirmations: re-call write operations with the returned token.
- [ ] Errors: distinguish JSON-RPC errors from `isError: true` results.
- [ ] Sessions: reselect a connection after "No active session".
- [ ] No pagination: treat discovery and search results as complete.
- [ ] No push: poll resource payloads via `registryRevision` when needed.
