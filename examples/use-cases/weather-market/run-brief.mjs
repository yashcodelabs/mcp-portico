#!/usr/bin/env node
/**
 * Drive the weather-market use case through the fixed MCP toolset.
 *
 * This script intentionally performs the synthesis locally after receiving
 * three independently fetched API responses. Portico remains the connection,
 * credential, policy, and tenant boundary.
 */

const args = process.argv.slice(2);

function flag(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const endpoint = flag('--url', process.env.MCP_URL ?? 'http://127.0.0.1:3000/mcp');
const token = flag('--token', process.env.MCP_KEY);
const latitude = Number(flag('--latitude', '40.7128'));
const longitude = Number(flag('--longitude', '-74.0060'));
const timezone = flag('--timezone', 'America/New_York');
const assetIds = flag('--ids', 'bitcoin,ethereum');
const baseCurrency = flag('--base', 'EUR');
const quoteCurrencies = flag('--symbols', 'USD');

if (token === undefined || token === '') {
  throw new Error('Provide the Portico key with --token or MCP_KEY.');
}

let requestId = 0;

async function mcpRequest(method, params, authenticated = true, notification = false) {
  const headers = { 'content-type': 'application/json' };
  if (authenticated) headers.authorization = `Bearer ${token}`;
  const payload = { jsonrpc: '2.0', method, params };
  if (!notification) payload.id = ++requestId;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const body = text === '' ? undefined : JSON.parse(text);
  if (!response.ok && response.status !== 202) {
    throw new Error(`MCP HTTP ${response.status}: ${text}`);
  }
  if (body?.error !== undefined) {
    throw new Error(`MCP ${body.error.code}: ${body.error.message}`);
  }
  return body?.result;
}

async function callTool(name, argumentsValue = {}) {
  const result = await mcpRequest('tools/call', {
    name,
    arguments: argumentsValue,
  });
  if (result?.isError === true) {
    const message =
      result.content?.map((block) => block.text).join('\n') ?? 'tool error';
    throw new Error(`${name}: ${message}`);
  }
  const text = result?.content?.find((block) => block.type === 'text')?.text;
  if (text === undefined) throw new Error(`${name}: no text result returned`);
  return JSON.parse(text);
}

async function select(connectionId) {
  await callTool('select_connection', { connectionId });
}

await mcpRequest(
  'initialize',
  {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'weather-market-brief', version: '0.1.0' },
  },
  false,
);
await mcpRequest('notifications/initialized', {}, false, true);

await select('weather');
const weather = await callTool('call_operation', {
  operationId: 'weather.forecast',
  arguments: {
    latitude,
    longitude,
    current: 'temperature_2m,precipitation,rain,wind_speed_10m',
    daily:
      'temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max',
    forecast_days: 2,
    timezone,
  },
});

await select('crypto-market');
const market = await callTool('call_operation', {
  operationId: 'market.simple_price',
  arguments: {
    ids: assetIds,
    vs_currencies: 'usd',
    include_24hr_change: true,
    include_market_cap: true,
  },
});

await select('fx');
const fx = await callTool('call_operation', {
  operationId: 'fx.latest',
  arguments: { base: baseCurrency, symbols: quoteCurrencies },
});

const current = weather.current ?? {};
const daily = weather.daily ?? {};
const firstDayRainProbability = Number(daily.precipitation_probability_max?.[0] ?? 0);
const firstDayMaxWind = Number(daily.wind_speed_10m_max?.[0] ?? 0);
const weatherSignal =
  firstDayRainProbability >= 60 || firstDayMaxWind >= 40
    ? 'elevated weather disruption risk'
    : 'no elevated weather disruption signal';
const moves = Object.entries(market).map(([asset, quote]) => [
  asset,
  Number(quote.usd_24h_change ?? 0),
]);
const marketSignal =
  moves.length > 0 && moves.every(([, change]) => change > 0)
    ? 'the selected assets are collectively up over 24 hours'
    : moves.length > 0 && moves.every(([, change]) => change < 0)
      ? 'the selected assets are collectively down over 24 hours'
      : 'the selected assets have mixed 24-hour movement';

console.log(
  JSON.stringify(
    {
      sources: {
        weather: weather.timezone ?? timezone,
        market: assetIds,
        fx: `${baseCurrency}/${quoteCurrencies}`,
      },
      observations: {
        weather: {
          observedAt: current.time,
          temperature: current.temperature_2m,
          precipitation: current.precipitation,
          rain: current.rain,
          windSpeed: current.wind_speed_10m,
          nextDayRainProbability: firstDayRainProbability,
          nextDayMaxWind: firstDayMaxWind,
        },
        market,
        fx,
      },
      joinedInsight: `For ${weather.timezone ?? timezone}, there is ${weatherSignal}; at the same time, ${marketSignal}. These are coincident cross-source observations, not evidence that weather caused the market move and not a trading recommendation.`,
    },
    null,
    2,
  ),
);
