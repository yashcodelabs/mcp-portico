#!/usr/bin/env node
/**
 * Join public weather data with private orders and inventory through MCP.
 *
 * The orders and inventory payloads are intentionally private. This client
 * demonstrates the insight that a public AI agent cannot produce without
 * authorized access to internal fulfillment systems.
 */

const args = process.argv.slice(2);

function flag(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const endpoint = flag('--url', process.env.MCP_URL ?? 'http://127.0.0.1:3000/mcp');
const token = flag('--token', process.env.MCP_KEY);
const maxOrders = Number(flag('--max-orders', '20'));

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

async function callOperation(operationId, argumentsValue) {
  return callTool('call_operation', {
    operationId,
    arguments: argumentsValue,
  });
}

await mcpRequest(
  'initialize',
  {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'weather-orders-inventory-brief', version: '0.1.0' },
  },
  false,
);
await mcpRequest('notifications/initialized', {}, false, true);

await select('orders');
const orders = await callOperation('orders.list', {
  status: 'open',
  limit: maxOrders,
});

await select('inventory');
const inventory = await callOperation('inventory.list', {
  availableOnly: true,
  limit: 100,
});

await select('weather');
const weatherByOrder = {};
for (const order of orders) {
  weatherByOrder[order.id] = await callOperation('weather.forecast', {
    latitude: order.latitude,
    longitude: order.longitude,
    current: 'temperature_2m,precipitation,rain,wind_speed_10m',
    daily: 'precipitation_probability_max,wind_speed_10m_max',
    forecast_days: 2,
    timezone: 'auto',
  });
}

const assessments = orders.map((order) => {
  const weather = weatherByOrder[order.id] ?? {};
  const daily = weather.daily ?? {};
  const rainProbability = Number(daily.precipitation_probability_max?.[0] ?? 0);
  const maxWind = Number(daily.wind_speed_10m_max?.[0] ?? 0);
  const elevatedWeather = rainProbability >= 60 || maxWind >= 40;
  const reasons = [];
  if (rainProbability >= 60) reasons.push(`rain probability ${rainProbability}%`);
  if (maxWind >= 40) reasons.push(`maximum wind ${maxWind}`);
  const substitutes = inventory.filter(
    (record) => record.sku === order.sku && record.available >= order.quantity,
  );
  return {
    order,
    weather: {
      observedAt: weather.current?.time,
      temperature: weather.current?.temperature_2m,
      rain: weather.current?.rain,
      windSpeed: weather.current?.wind_speed_10m,
      nextDayRainProbability: rainProbability,
      nextDayMaxWind: maxWind,
    },
    weatherRisk: elevatedWeather ? 'elevated' : 'normal',
    reasons,
    substituteInventory: substitutes,
  };
});

const atRisk = assessments.filter((item) => item.weatherRisk === 'elevated');
const covered = atRisk.filter((item) => item.substituteInventory.length > 0);
const exposedValue = atRisk.reduce(
  (total, item) => total + Number(item.order.orderValueUsd ?? 0),
  0,
);

console.log(
  JSON.stringify(
    {
      sources: {
        public: 'Open-Meteo weather forecast',
        private: ['orders', 'inventory'],
      },
      summary: {
        openOrders: orders.length,
        weatherExposedOrders: atRisk.length,
        exposedOrderValueUsd: exposedValue,
        exposedOrdersWithSubstituteInventory: covered.length,
      },
      assessments,
      joinedInsight:
        `Found ${atRisk.length} weather-exposed open order(s) worth $${exposedValue}. ` +
        `${covered.length} have enough substitute inventory in another warehouse. ` +
        'This result joins private fulfillment data with public weather data; it is not available from the public weather API alone.',
    },
    null,
    2,
  ),
);
