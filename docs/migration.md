# Migration notes

MCP Portico is a fresh implementation of a generic, multi-tenant MCP
frontend for HTTP APIs. It is not an upgrade of the predecessor project
referenced in [deprecation-inventory.md](deprecation-inventory.md), and there
is **no compatibility layer**.

## What does not carry over

- No legacy CLI commands, environment variables, headers, config home, or
  server names work with MCP Portico. The `mcp-portico` executable, the
  `MCP_PORTICO_*` environment variables, the `x-mcp-portico-*` headers, and
  `~/.config/mcp-portico` are the only supported surfaces.
- No first-class/domain MCP tools, operation aliases, path rewrites,
  presets, portal login, or fixed org/workspace/locale context exist.
  The fixed MCP toolset (`list_connections`, `select_connection`,
  `get_session`, `search_operations`, `describe_operation`,
  `call_operation`, `call_operations`, `test_connection`) is the only MCP
  surface.
- The old runtime and configuration model were removed during the phased
  migration (Phases 1-7). Catalogs are compiled v2 artifacts; execution is
  keyed by stable `operationId`, never by raw method/path input.

## How to move a backend to MCP Portico

1. Describe the backend API with OpenAPI (2.0, 3.0, 3.1, or 3.2) or run the
   AI analysis skill (`.opencode/skills/mcp-portico-analyze`) against the
   backend repository to generate reviewable artifacts.
2. Compile and validate a catalog:

   ```text
   mcp-portico catalog import openapi.yaml --api-id <id> \
     --output catalog.json --report report.json
   mcp-portico catalog validate catalog.json
   ```

3. Declare tenants, principals, backends, and connections in a registry
   file (see [examples](../examples/README.md)) and validate it:

   ```text
   mcp-portico registry validate registry.yaml
   ```

4. Start the server and authenticate:

   ```text
   mcp-portico serve --registry registry.yaml
   mcp-portico key create --registry registry.yaml \
     --tenant <tenant-id> --principal <principal-id>
   ```

5. Discover and execute operations through the fixed MCP toolset. Secrets
   always stay in environment references (`env:...`); the catalog and
   registry never contain credentials.

There is no import tool for predecessor configuration, keys, or catalogs.
Treat this migration as a rebuild from the API description, which is also
the safer path: every connection, policy, and operation is reviewed before
it becomes executable.
