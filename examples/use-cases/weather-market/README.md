# Use case: weather-aware market brief

This example connects three independent public APIs through one MCP Portico
deployment:

| Connection      | Backend                                       | Real data                                      |
| --------------- | --------------------------------------------- | ---------------------------------------------- |
| `weather`       | [Open-Meteo](https://open-meteo.com/)         | Current conditions and forecast for a location |
| `crypto-market` | [CoinGecko](https://www.coingecko.com/en/api) | Current BTC/ETH prices and 24-hour movement    |
| `fx`            | [Frankfurter](https://www.frankfurter.dev/)   | ECB reference exchange rates                   |

No upstream API key is required for this demonstration. Public endpoints are
rate-limited and governed by their own terms; use modest request volumes.

## What the MCP client adds

Each backend independently returns facts. The MCP client creates a useful
combined brief by:

1. Reading a location's weather risk and near-term trend.
2. Reading current crypto prices and 24-hour movement.
3. Reading an FX rate to normalize the market context.
4. Joining the responses into one dated research brief with explicit source
   timestamps and uncertainty.

For example, the client can answer:

> “For New York today, summarize rain and wind risk, BTC/ETH 24-hour movement,
> and the EUR/USD rate. Explain what changed together and what is merely
> coincident. Do not make a trading recommendation.”

That joined interpretation is not returned by any one API. Portico supplies
the secure, tenant-scoped MCP connections; the MCP host or application performs
the synthesis. The result is an informational market-context brief, not a
causal weather model or investment advice.

## 1. Build the catalogs

From the repository root:

```bash
pnpm install
pnpm build

pnpm cli catalog import \
  examples/use-cases/weather-market/apis/open-meteo.openapi.yaml \
  --api-id weather \
  --output examples/use-cases/weather-market/apis/open-meteo.catalog.json \
  --report examples/use-cases/weather-market/apis/open-meteo.import-report.json

pnpm cli catalog import \
  examples/use-cases/weather-market/apis/coingecko.openapi.yaml \
  --api-id crypto-market \
  --output examples/use-cases/weather-market/apis/coingecko.catalog.json \
  --report examples/use-cases/weather-market/apis/coingecko.import-report.json

pnpm cli catalog import \
  examples/use-cases/weather-market/apis/frankfurter.openapi.yaml \
  --api-id fx \
  --output examples/use-cases/weather-market/apis/frankfurter.catalog.json \
  --report examples/use-cases/weather-market/apis/frankfurter.import-report.json
```

The import reports contain the catalog checksums. Replace the three checksum
placeholders in `registry.yaml`, then validate it:

```bash
pnpm cli registry validate \
  examples/use-cases/weather-market/registry.yaml
```

## 2. Create a local Portico key and serve

Copy the registry so the local key digest does not modify the checked-in
template:

```bash
cp examples/use-cases/weather-market/registry.yaml \
  examples/use-cases/weather-market/registry.local.yaml
export MCP_PORTICO_KEY_PEPPER='replace-with-a-long-random-pepper'
pnpm cli key create \
  --registry examples/use-cases/weather-market/registry.local.yaml \
  --tenant local-research \
  --principal local-research-agent
export MCP_PORTICO_AUTH_MODE=bearer
export MCP_KEY='<paste-the-token-printed-once-by-key-create>'
pnpm cli serve \
  --registry examples/use-cases/weather-market/registry.local.yaml
```

On PowerShell, replace `cp` and `export` with `Copy-Item` and `$env:NAME =
'value'`.

## 3. Drive the MCP workflow

Use the normal MCP lifecycle, then call the fixed tools in this order:

1. Select `weather`; call `weather.forecast` with New York coordinates:
   `latitude=40.7128`, `longitude=-74.0060`, `forecast_days=2`, and
   `timezone=America/New_York`.
2. Select `crypto-market`; call `market.simple_price` with
   `ids=bitcoin,ethereum`, `vs_currencies=usd`, and
   `include_24hr_change=true`.
3. Select `fx`; call `fx.latest` with `base=EUR` and `symbols=USD`.
4. Ask the MCP host to synthesize the three returned JSON payloads, preserving
   each provider's date/time and clearly separating observations from
   interpretation.

For a repeatable local run, use the included dependency-free client after the
server is listening:

```bash
node examples/use-cases/weather-market/run-brief.mjs --token "$MCP_KEY"
```

It selects each connection in turn, calls one operation, and prints the raw
observations plus the joined insight as JSON. On PowerShell, use
`--token $env:MCP_KEY` instead.

The active session has one selected connection at a time, so the client must
reselect the next connection before calling its operation. That is deliberate:
Portico re-authorizes every selection and operation against the authenticated
principal's allowlist.

## 4. Useful checks

- Call `test_connection` for all three connections before the brief.
- Use `describe_operation` before execution to inspect the exact input schema.
- Send an invalid latitude or currency code to exercise argument validation.
- Try selecting a connection outside the principal allowlist and confirm it
  fails without revealing unauthorized backend details.
- Compare the result with the raw provider responses; Portico does not invent
  or merge data inside the gateway.
