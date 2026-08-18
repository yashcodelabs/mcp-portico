import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

import { startServer, type RunningServer } from '../cli/serve';
import { generatePorticoKey } from '../identity/keys';
import { loadRegistryFile } from '../registry/load';
import type { RegistryDocument } from '../registry/types';
import { envName } from '../shared/brand';

const USE_CASE_DIRECTORY = path.resolve(
  __dirname,
  '..',
  '..',
  'examples',
  'use-cases',
  'weather-orders-inventory',
);
const REFERENCE_REGISTRY = path.join(USE_CASE_DIRECTORY, 'registry.yaml');
const DEMO_PRINCIPAL = 'fulfillment-agent';
const DEMO_PEPPER = 'mcp-portico-five-minute-demo-pepper';
const DEMO_ORDERS_KEY = 'orders-demo-key';
const DEMO_INVENTORY_TOKEN = 'inventory-demo-token';

const orders = [
  {
    id: 'ORD-1001',
    sku: 'RAIN-JACKET',
    quantity: 12,
    destination: 'New York, NY',
    latitude: 40.7128,
    longitude: -74.006,
    promisedDate: 'next-business-day',
    orderValueUsd: 1680,
    status: 'open',
    weatherSensitivity: 'high',
  },
  {
    id: 'ORD-1002',
    sku: 'OFFICE-KIT',
    quantity: 8,
    destination: 'Boston, MA',
    latitude: 42.3601,
    longitude: -71.0589,
    promisedDate: 'next-business-day',
    orderValueUsd: 920,
    status: 'open',
    weatherSensitivity: 'medium',
  },
  {
    id: 'ORD-1003',
    sku: 'COLD-CHAIN-BOX',
    quantity: 4,
    destination: 'Chicago, IL',
    latitude: 41.8781,
    longitude: -87.6298,
    promisedDate: 'next-business-day',
    orderValueUsd: 2400,
    status: 'open',
    weatherSensitivity: 'high',
  },
  {
    id: 'ORD-1004',
    sku: 'OFFICE-KIT',
    quantity: 3,
    destination: 'Seattle, WA',
    latitude: 47.6062,
    longitude: -122.3321,
    promisedDate: 'next-business-day',
    orderValueUsd: 345,
    status: 'closed',
    weatherSensitivity: 'low',
  },
] as const;

const inventory = [
  {
    sku: 'RAIN-JACKET',
    warehouseId: 'WH-NJ',
    warehouseCity: 'Newark, NJ',
    available: 24,
  },
  {
    sku: 'RAIN-JACKET',
    warehouseId: 'WH-PA',
    warehouseCity: 'Philadelphia, PA',
    available: 9,
  },
  {
    sku: 'OFFICE-KIT',
    warehouseId: 'WH-MA',
    warehouseCity: 'Boston, MA',
    available: 30,
  },
  {
    sku: 'COLD-CHAIN-BOX',
    warehouseId: 'WH-IL',
    warehouseCity: 'Chicago, IL',
    available: 2,
  },
  {
    sku: 'COLD-CHAIN-BOX',
    warehouseId: 'WH-IN',
    warehouseCity: 'Indianapolis, IN',
    available: 10,
  },
] as const;

export interface DemoSummary {
  openOrders: number;
  weatherExposedOrders: number;
  exposedOrderValueUsd: number;
  exposedOrdersWithSubstituteInventory: number;
}

export interface DemoAssessment {
  order: (typeof orders)[number];
  weather: {
    observedAt?: string;
    temperature?: number;
    rain?: number;
    windSpeed?: number;
    nextDayRainProbability: number;
    nextDayMaxWind: number;
  };
  weatherRisk: 'elevated' | 'normal';
  reasons: string[];
  substituteInventory: (typeof inventory)[number][];
}

export interface DemoResult {
  summary: DemoSummary;
  assessments: DemoAssessment[];
  joinedInsight: string;
}

export interface DemoOptions {
  maxOrders?: number;
  output?: (line: string) => void;
  interactive?: boolean;
  ask?: (prompt: string) => Promise<string>;
}

interface RunningHttpServer {
  port: number;
  close(): Promise<void>;
}

interface RunningBackends {
  weather: RunningHttpServer;
  orders: RunningHttpServer;
  inventory: RunningHttpServer;
  close(): Promise<void>;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

function sendJson(response: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function listen(server: http.Server): Promise<RunningHttpServer> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Demo backend did not expose a TCP address.'));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error !== undefined) rejectClose(error);
              else resolveClose();
            });
            server.closeAllConnections();
          }),
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

function createWeatherServer(): http.Server {
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method !== 'GET' || url.pathname !== '/v1/forecast') {
      sendJson(response, 404, { error: 'not found' });
      return;
    }

    const latitude = Number(url.searchParams.get('latitude'));
    const longitude = Number(url.searchParams.get('longitude'));
    const isChicago = latitude > 41.5 && latitude < 42.2 && longitude < -86;
    const isNewYork = latitude > 40 && latitude < 41.5 && longitude > -75;
    const isBoston = latitude > 42 && latitude < 43 && longitude > -72;
    const conditions = isChicago
      ? { temperature: 6, precipitation: 2, rain: 2, wind: 48, rainProbability: 70 }
      : isNewYork
        ? { temperature: 12, precipitation: 1, rain: 1, wind: 25, rainProbability: 80 }
        : isBoston
          ? {
              temperature: 16,
              precipitation: 0,
              rain: 0,
              wind: 18,
              rainProbability: 20,
            }
          : {
              temperature: 18,
              precipitation: 0,
              rain: 0,
              wind: 12,
              rainProbability: 10,
            };

    sendJson(response, 200, {
      latitude,
      longitude,
      timezone: 'UTC',
      current: {
        time: '2026-08-19T12:00',
        temperature_2m: conditions.temperature,
        precipitation: conditions.precipitation,
        rain: conditions.rain,
        wind_speed_10m: conditions.wind,
      },
      daily: {
        time: ['2026-08-19', '2026-08-20'],
        precipitation_probability_max: [conditions.rainProbability, 10],
        wind_speed_10m_max: [conditions.wind, 15],
      },
    });
  });
}

function createOrdersServer(): http.Server {
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.headers['x-api-key'] !== DEMO_ORDERS_KEY) {
      sendJson(response, 401, { error: 'invalid or missing X-API-Key' });
      return;
    }
    if (request.method !== 'GET' || url.pathname !== '/orders') {
      sendJson(response, 404, { error: 'not found' });
      return;
    }
    const status = url.searchParams.get('status');
    const limit = Number(url.searchParams.get('limit') ?? 20);
    const result = status ? orders.filter((order) => order.status === status) : orders;
    sendJson(response, 200, result.slice(0, limit));
  });
}

function createInventoryServer(): http.Server {
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.headers.authorization !== `Bearer ${DEMO_INVENTORY_TOKEN}`) {
      sendJson(response, 401, { error: 'invalid or missing bearer token' });
      return;
    }
    if (request.method !== 'GET' || url.pathname !== '/inventory') {
      sendJson(response, 404, { error: 'not found' });
      return;
    }
    const sku = url.searchParams.get('sku');
    const availableOnly = url.searchParams.get('availableOnly') !== 'false';
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const result = inventory.filter(
      (record) =>
        (sku === null || record.sku === sku) &&
        (!availableOnly || record.available > 0),
    );
    sendJson(response, 200, result.slice(0, limit));
  });
}

async function startBackends(): Promise<RunningBackends> {
  const weather = await listen(createWeatherServer());
  try {
    const ordersServer = await listen(createOrdersServer());
    try {
      const inventoryServer = await listen(createInventoryServer());
      return {
        weather,
        orders: ordersServer,
        inventory: inventoryServer,
        close: async () => {
          await Promise.all([
            weather.close(),
            ordersServer.close(),
            inventoryServer.close(),
          ]);
        },
      };
    } catch (error) {
      await ordersServer.close();
      throw error;
    }
  } catch (error) {
    await weather.close();
    throw error;
  }
}

function createDemoRegistry(
  directory: string,
  backends: RunningBackends,
): { filePath: string; token: string } {
  const loaded = loadRegistryFile(REFERENCE_REGISTRY);
  const document = structuredClone(loaded.document) as RegistryDocument;
  const catalogDirectory = USE_CASE_DIRECTORY;
  for (const backend of document.backends) {
    backend.catalogRef = path.resolve(catalogDirectory, backend.catalogRef);
  }

  const key = generatePorticoKey(DEMO_PEPPER);
  const principal = document.principals.find(({ id }) => id === DEMO_PRINCIPAL);
  if (principal === undefined) {
    throw new Error(`Demo principal "${DEMO_PRINCIPAL}" is missing.`);
  }
  principal.keyId = key.keyId;
  principal.keyDigest = key.digest;

  const ports = {
    weather: backends.weather.port,
    orders: backends.orders.port,
    inventory: backends.inventory.port,
  };
  for (const connection of document.connections) {
    const port = ports[connection.id as keyof typeof ports];
    if (port === undefined) continue;
    connection.baseUrl = `http://127.0.0.1:${port}`;
    connection.network = {
      ...connection.network,
      allowedProtocols: ['http'],
      allowLoopback: true,
    };
  }

  const filePath = path.join(directory, 'registry.json');
  fs.writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return { filePath, token: key.token };
}

function recordFromJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Demo MCP response was not an object.');
  }
  return value as Record<string, unknown>;
}

async function mcpRequest(
  endpoint: string,
  token: string,
  method: string,
  params: Record<string, unknown>,
  requestId: number | undefined,
): Promise<JsonRpcResponse | undefined> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== '') headers.authorization = `Bearer ${token}`;
  const payload: Record<string, unknown> = {
    jsonrpc: '2.0',
    method,
    params,
  };
  if (requestId !== undefined) payload.id = requestId;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const body = text === '' ? undefined : (JSON.parse(text) as JsonRpcResponse);
  if (!response.ok && response.status !== 202) {
    throw new Error(`MCP HTTP ${response.status}: ${text}`);
  }
  if (body?.error !== undefined) {
    throw new Error(`MCP ${body.error.code}: ${body.error.message}`);
  }
  return body;
}

async function callTool(
  endpoint: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
  requestId: { value: number },
): Promise<unknown> {
  const response = await mcpRequest(
    endpoint,
    token,
    'tools/call',
    { name, arguments: args },
    ++requestId.value,
  );
  const result = recordFromJson(response?.result);
  if (result.isError === true) {
    const content = Array.isArray(result.content) ? result.content : [];
    const message = content
      .filter(
        (block): block is { type: string; text: string } =>
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string',
      )
      .map((block) => block.text)
      .join('\n');
    throw new Error(`${name}: ${message || 'tool error'}`);
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.find(
    (block): block is { type: string; text: string } =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string',
  )?.text;
  if (text === undefined) throw new Error(`${name}: no text result returned`);
  return JSON.parse(text) as unknown;
}

async function runBrief(
  endpoint: string,
  token: string,
  maxOrders: number,
): Promise<DemoResult> {
  const requestId = { value: 0 };
  await mcpRequest(
    endpoint,
    token,
    'initialize',
    {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'weather-fulfillment-five-minute-demo', version: '0.1.0' },
    },
    ++requestId.value,
  );
  await mcpRequest(endpoint, token, 'notifications/initialized', {}, undefined);

  const select = async (connectionId: string): Promise<void> => {
    await callTool(endpoint, token, 'select_connection', { connectionId }, requestId);
  };
  const callOperation = async (
    operationId: string,
    args: Record<string, unknown>,
  ): Promise<unknown> =>
    callTool(
      endpoint,
      token,
      'call_operation',
      {
        operationId,
        arguments: args,
      },
      requestId,
    );

  await select('orders');
  const orderResult = await callOperation('orders.list', {
    status: 'open',
    limit: maxOrders,
  });
  if (!Array.isArray(orderResult))
    throw new Error('orders.list did not return an array.');
  const openOrders = orderResult as (typeof orders)[number][];

  await select('inventory');
  const inventoryResult = await callOperation('inventory.list', {
    availableOnly: true,
    limit: 100,
  });
  if (!Array.isArray(inventoryResult)) {
    throw new Error('inventory.list did not return an array.');
  }
  const availableInventory = inventoryResult as (typeof inventory)[number][];

  await select('weather');
  const weatherByOrder = new Map<string, Record<string, unknown>>();
  for (const order of openOrders) {
    const weatherResult = await callOperation('weather.forecast', {
      latitude: order.latitude,
      longitude: order.longitude,
      current: 'temperature_2m,precipitation,rain,wind_speed_10m',
      daily: 'precipitation_probability_max,wind_speed_10m_max',
      forecast_days: 2,
      timezone: 'auto',
    });
    weatherByOrder.set(order.id, recordFromJson(weatherResult));
  }

  const assessments = openOrders.map((order) => {
    const weather = weatherByOrder.get(order.id) ?? {};
    const daily = recordFromJson(weather.daily ?? {});
    const current = recordFromJson(weather.current ?? {});
    const rainProbability = Number(
      Array.isArray(daily.precipitation_probability_max)
        ? (daily.precipitation_probability_max[0] ?? 0)
        : 0,
    );
    const maxWind = Number(
      Array.isArray(daily.wind_speed_10m_max) ? (daily.wind_speed_10m_max[0] ?? 0) : 0,
    );
    const elevatedWeather = rainProbability >= 60 || maxWind >= 40;
    const reasons: string[] = [];
    if (rainProbability >= 60) reasons.push(`rain probability ${rainProbability}%`);
    if (maxWind >= 40) reasons.push(`maximum wind ${maxWind} km/h`);
    const substitutes = availableInventory.filter(
      (record) => record.sku === order.sku && record.available >= order.quantity,
    );
    return {
      order,
      weather: {
        observedAt: typeof current.time === 'string' ? current.time : undefined,
        temperature:
          typeof current.temperature_2m === 'number'
            ? current.temperature_2m
            : undefined,
        rain: typeof current.rain === 'number' ? current.rain : undefined,
        windSpeed:
          typeof current.wind_speed_10m === 'number'
            ? current.wind_speed_10m
            : undefined,
        nextDayRainProbability: rainProbability,
        nextDayMaxWind: maxWind,
      },
      weatherRisk: elevatedWeather ? 'elevated' : 'normal',
      reasons,
      substituteInventory: substitutes,
    } satisfies DemoAssessment;
  });

  const atRisk = assessments.filter((item) => item.weatherRisk === 'elevated');
  const covered = atRisk.filter((item) => item.substituteInventory.length > 0);
  const exposedValue = atRisk.reduce(
    (total, item) => total + Number(item.order.orderValueUsd ?? 0),
    0,
  );
  const summary = {
    openOrders: openOrders.length,
    weatherExposedOrders: atRisk.length,
    exposedOrderValueUsd: exposedValue,
    exposedOrdersWithSubstituteInventory: covered.length,
  };
  return {
    summary,
    assessments,
    joinedInsight:
      `Found ${atRisk.length} weather-exposed open order(s) worth $${exposedValue.toLocaleString('en-US')}. ` +
      `${covered.length} have enough substitute inventory in another warehouse. ` +
      'This result joins private fulfillment data with public-style weather data; it is not available from the weather API alone.',
  };
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

function printResult(result: DemoResult, output: (line: string) => void): void {
  output('');
  output('Fulfillment risk summary');
  output(`  Open orders:                         ${result.summary.openOrders}`);
  output(
    `  Weather-exposed orders:              ${result.summary.weatherExposedOrders}`,
  );
  output(
    `  Exposed order value:                 ${formatMoney(result.summary.exposedOrderValueUsd)}`,
  );
  output(
    `  Exposed orders with substitute stock: ${result.summary.exposedOrdersWithSubstituteInventory}`,
  );
  output('');
  output('Order assessments');
  for (const item of result.assessments) {
    const risk = item.weatherRisk === 'elevated' ? 'ELEVATED' : 'normal';
    const substitutes =
      item.substituteInventory.length > 0
        ? item.substituteInventory
            .map((record) => `${record.warehouseCity} (${record.available})`)
            .join(', ')
        : 'none';
    output(
      `  ${item.order.id} · ${item.order.destination} · ${risk} · ` +
        `tomorrow rain ${item.weather.nextDayRainProbability}% · substitutes: ${substitutes}`,
    );
  }
  output('');
  output(`Joined insight: ${result.joinedInsight}`);
}

const DEMO_QUESTIONS = [
  "Which open orders are at risk from tomorrow's weather?",
  'Which weather-exposed orders have enough substitute inventory elsewhere?',
  'What is the total order value exposed to weather disruption?',
  'Compare the weather risk and fulfillment alternatives for New York, Boston, and Chicago.',
  'Show the raw observations used for the risk assessment.',
] as const;

function answerQuestion(
  result: DemoResult,
  questionNumber: number,
  output: (line: string) => void,
): void {
  const atRisk = result.assessments.filter((item) => item.weatherRisk === 'elevated');
  output('');
  output('Answer:');
  if (questionNumber === 1) {
    for (const item of atRisk) {
      output(
        `  ${item.order.id} (${item.order.destination}) — ${item.reasons.join(' and ')}.`,
      );
    }
  } else if (questionNumber === 2) {
    for (const item of atRisk) {
      const substitutes = item.substituteInventory
        .map((record) => `${record.warehouseCity}: ${record.available} available`)
        .join('; ');
      output(`  ${item.order.id} (${item.order.sku}) — ${substitutes || 'none'}.`);
    }
  } else if (questionNumber === 3) {
    output(`  ${formatMoney(result.summary.exposedOrderValueUsd)} is exposed.`);
  } else if (questionNumber === 4) {
    for (const item of result.assessments) {
      output(
        `  ${item.order.destination}: ${item.weatherRisk} risk; ` +
          `${item.weather.nextDayRainProbability}% rain probability; ` +
          `substitutes ${item.substituteInventory.length > 0 ? 'available' : 'not available'}.`,
      );
    }
  } else if (questionNumber === 5) {
    for (const item of result.assessments) {
      output(
        `  ${item.order.id}: temperature ${item.weather.temperature ?? 'unknown'}°C, ` +
          `rain ${item.weather.rain ?? 'unknown'} mm, ` +
          `wind ${item.weather.windSpeed ?? 'unknown'} km/h, ` +
          `next-day rain ${item.weather.nextDayRainProbability}%.`,
      );
    }
  }
}

async function runInteractiveQuestions(
  result: DemoResult,
  output: (line: string) => void,
  ask: (prompt: string) => Promise<string>,
): Promise<void> {
  output('');
  output('Ask a demo question (enter the number, or q to finish):');
  DEMO_QUESTIONS.forEach((question, index) => output(`  ${index + 1}. ${question}`));
  while (true) {
    const answer = (await ask('Your choice: ')).trim().toLowerCase();
    if (answer === 'q' || answer === 'quit' || answer === 'exit' || answer === '')
      return;
    const questionNumber = Number(answer);
    if (
      !Number.isInteger(questionNumber) ||
      questionNumber < 1 ||
      questionNumber > DEMO_QUESTIONS.length
    ) {
      output(
        `Please enter a number from 1 to ${DEMO_QUESTIONS.length}, or q to finish.`,
      );
      continue;
    }
    answerQuestion(result, questionNumber, output);
    output('');
    output('Choose another question, or q to finish.');
  }
}

function setDemoEnvironment(): Map<string, string | undefined> {
  const values = new Map<string, string | undefined>();
  const updates: Record<string, string> = {
    [envName('KEY_PEPPER')]: DEMO_PEPPER,
    ORDERS_MOCK_API_KEY: DEMO_ORDERS_KEY,
    INVENTORY_MOCK_TOKEN: DEMO_INVENTORY_TOKEN,
  };
  for (const [name, value] of Object.entries(updates)) {
    values.set(name, process.env[name]);
    process.env[name] = value;
  }
  return values;
}

function restoreEnvironment(values: Map<string, string | undefined>): void {
  for (const [name, value] of values) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/**
 * Run the weather-aware fulfillment example without external services.
 *
 * The temporary registry, Portico API key, three local backends, and Portico
 * server all live for the duration of this function and are cleaned up in the
 * finally block. This makes the command suitable for a quick evaluation and
 * for automated tests.
 */
export async function runWeatherFulfillmentDemo(
  options: DemoOptions = {},
): Promise<DemoResult> {
  const output = options.output ?? console.log;
  const maxOrders = options.maxOrders ?? 20;
  const interactive = options.interactive ?? false;

  let backends: RunningBackends | undefined;
  let portico: RunningServer | undefined;
  let temporaryDirectory: string | undefined;
  const environment = setDemoEnvironment();
  try {
    if (!Number.isInteger(maxOrders) || maxOrders <= 0) {
      throw new Error('Demo maxOrders must be a positive integer.');
    }
    output('MCP Portico — five-minute weather-aware fulfillment demo');
    output('');
    output('1. Starting deterministic local weather, orders, and inventory APIs...');
    backends = await startBackends();
    output('   Local APIs ready.');

    output('2. Creating a temporary tenant registry and Portico API key...');
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-portico-demo-'));
    const registry = createDemoRegistry(temporaryDirectory, backends);
    portico = await startServer({
      host: '127.0.0.1',
      port: 0,
      authMode: 'bearer',
      registryPath: registry.filePath,
    });
    const endpoint = `http://127.0.0.1:${portico.port}/mcp`;
    output('   Temporary Portico MCP server ready.');

    output('3. Running the joined MCP brief...');
    const result = await runBrief(endpoint, registry.token, maxOrders);
    printResult(result, output);
    if (interactive) {
      const terminal = options.ask
        ? undefined
        : createInterface({
            input: process.stdin,
            output: process.stdout,
          });
      const ask =
        options.ask ??
        ((prompt: string): Promise<string> => terminal!.question(prompt));
      try {
        await runInteractiveQuestions(result, output, ask);
      } finally {
        terminal?.close();
      }
    }
    return result;
  } finally {
    if (portico !== undefined) await portico.close();
    if (backends !== undefined) await backends.close();
    if (temporaryDirectory !== undefined) {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    restoreEnvironment(environment);
    output('');
    output('Cleanup complete. Temporary setup and local services removed.');
  }
}
