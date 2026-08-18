# Use case: weather-aware fulfillment risk

This example combines one public API with two private loopback APIs:

| Connection  | Backend                     | Data                                        |
| ----------- | --------------------------- | ------------------------------------------- |
| `weather`   | Open-Meteo                  | Current conditions and forecast by location |
| `orders`    | Local private Orders API    | Open fulfillment orders and delivery SLAs   |
| `inventory` | Local private Inventory API | Warehouse stock and substitute quantities   |

The important insight is not available from the public weather API alone:

> Which private orders are at risk from tomorrow's weather, and which other
> warehouses have enough inventory to fulfill them?

The local orders and inventory services are deterministic demo backends. They
represent data that a public AI agent cannot access. Portico keeps their URLs,
credentials, tenant, and principal policy behind the MCP boundary.

## Five-minute evaluation

From the repository root, install dependencies once and run the complete
deterministic demo:

```powershell
pnpm install
pnpm demo
```

This starts local weather, orders, and inventory APIs on temporary loopback
ports, creates a temporary registry and bearer key, starts Portico, runs the
joined MCP brief, and cleans up the registry, credentials, and servers before
returning. It does not call Open-Meteo or any other external service. The
output includes the exposed order count, affected order value, substitute
inventory, and the joined insight that requires both public-style weather and
private fulfillment data.

In an interactive terminal, choose follow-up questions such as:

- Which open orders are at risk from tomorrow's weather?
- Which weather-exposed orders have enough substitute inventory elsewhere?
- What is the total order value exposed to weather disruption?
- Compare the weather risk and fulfillment alternatives for New York, Boston,
  and Chicago.
- Show the raw observations used for the risk assessment.

Use `mcp-portico demo --non-interactive` when you want the summary without the
question menu. To connect an existing AI coding host, use one of these in a
separate terminal:

```powershell
mcp-portico demo --connect cursor
mcp-portico demo --connect claude
```

The command prints the endpoint, bearer key, and a ready-to-paste Cursor
`.cursor/mcp.json` entry or Claude Code `claude mcp add` command. Keep it
running while the host connects. Ask the host questions such as “Which open
orders are at risk from tomorrow's weather?” or “Which exposed orders have
substitute inventory elsewhere?”

The remaining sections are an expanded walkthrough for inspecting each piece
of the example manually.

## 1. Build and validate the catalogs

From the repository root:

```powershell
pnpm install
pnpm build

pnpm cli catalog import `
  examples/use-cases/weather-orders-inventory/apis/open-meteo.openapi.yaml `
  --api-id weather `
  --output examples/use-cases/weather-orders-inventory/apis/open-meteo.catalog.json `
  --report examples/use-cases/weather-orders-inventory/apis/open-meteo.import-report.json

pnpm cli catalog import `
  examples/use-cases/weather-orders-inventory/apis/orders.openapi.yaml `
  --api-id orders `
  --output examples/use-cases/weather-orders-inventory/apis/orders.catalog.json `
  --report examples/use-cases/weather-orders-inventory/apis/orders.import-report.json

pnpm cli catalog import `
  examples/use-cases/weather-orders-inventory/apis/inventory.openapi.yaml `
  --api-id inventory `
  --output examples/use-cases/weather-orders-inventory/apis/inventory.catalog.json `
  --report examples/use-cases/weather-orders-inventory/apis/inventory.import-report.json
```

The checked-in registry contains the generated checksums. Validate it after
importing:

```powershell
pnpm cli registry validate `
  examples/use-cases/weather-orders-inventory/registry.yaml
```

## 2. Start the private backends

Open a terminal and run:

```powershell
$env:ORDERS_MOCK_API_KEY = 'orders-demo-key'
$env:INVENTORY_MOCK_TOKEN = 'inventory-demo-token'

node examples/use-cases/weather-orders-inventory/mock-backends/server.mjs
```

This starts:

- Orders API: `http://127.0.0.1:4030`
- Inventory API: `http://127.0.0.1:4040`

The default credentials match the registry. Keep this terminal running.

## 3. Create a Portico key and start Portico

In a second terminal:

```powershell
Copy-Item `
  examples/use-cases/weather-orders-inventory/registry.yaml `
  examples/use-cases/weather-orders-inventory/registry.local.yaml

$env:MCP_PORTICO_KEY_PEPPER = 'replace-with-a-long-local-pepper'
$env:ORDERS_MOCK_API_KEY = 'orders-demo-key'
$env:INVENTORY_MOCK_TOKEN = 'inventory-demo-token'

pnpm cli key create `
  --registry examples/use-cases/weather-orders-inventory/registry.local.yaml `
  --tenant fulfillment-research `
  --principal fulfillment-agent
```

Copy the one-time token printed by the command. Then start Portico in the same
terminal:

```powershell
pnpm cli serve `
  --registry examples/use-cases/weather-orders-inventory/registry.local.yaml `
  --auth-mode bearer
```

The MCP endpoint is:

```text
http://127.0.0.1:3000/mcp
```

## 4. Run the joined MCP brief

In a third terminal:

```powershell
node examples/use-cases/weather-orders-inventory/run-brief.mjs `
  --url http://127.0.0.1:3000/mcp `
  --token 'PASTE_THE_PORTICO_TOKEN_HERE'
```

The client selects each connection, fetches private orders and inventory,
fetches weather for each open order's coordinates, and prints:

- raw order and weather observations;
- weather-risk assessments;
- affected order value;
- substitute inventory from other warehouses;
- a joined insight explaining why the answer required private data.

## Useful MCP queries

After connecting an MCP host to `http://127.0.0.1:3000/mcp` with the Portico
bearer token, useful prompts include:

- `Which open orders are at risk from tomorrow's weather?`
- `Which weather-exposed orders have enough substitute inventory elsewhere?`
- `What is the total order value exposed to weather disruption?`
- `Compare the weather risk and fulfillment alternatives for New York, Boston, and Chicago.`
- `List the private connections available to my principal, then describe their operations.`
- `Run a connection health check for weather, orders, and inventory.`
- `Try to access an unauthorized connection and confirm that backend details are not exposed.`

The MCP host should reselect the connection before switching between weather,
orders, and inventory. The result is operational decision support, not a
guarantee that weather caused a delay.
