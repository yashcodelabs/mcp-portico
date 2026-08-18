#!/usr/bin/env node
/**
 * Local private backends for the weather-aware fulfillment demo.
 *
 * The orders and inventory services intentionally run as separate loopback
 * APIs. They model private company data that a public AI agent cannot access.
 * Portico injects the upstream credentials and exposes only catalog-approved
 * operations to the MCP client.
 */

import http from 'node:http';

const ORDERS_PORT = Number(process.env.ORDERS_MOCK_PORT ?? 4030);
const INVENTORY_PORT = Number(process.env.INVENTORY_MOCK_PORT ?? 4040);
const ORDERS_API_KEY = process.env.ORDERS_MOCK_API_KEY ?? 'orders-demo-key';
const INVENTORY_TOKEN = process.env.INVENTORY_MOCK_TOKEN ?? 'inventory-demo-token';

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
];

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
];

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function createOrdersServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.headers['x-api-key'] !== ORDERS_API_KEY) {
      sendJson(res, 401, { error: 'invalid or missing X-API-Key' });
      return;
    }
    if (req.method !== 'GET' || url.pathname !== '/orders') {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const status = url.searchParams.get('status');
    const limit = Number(url.searchParams.get('limit') ?? 20);
    const result = status ? orders.filter((order) => order.status === status) : orders;
    sendJson(res, 200, result.slice(0, limit));
  });
}

function createInventoryServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.headers.authorization !== `Bearer ${INVENTORY_TOKEN}`) {
      sendJson(res, 401, { error: 'invalid or missing bearer token' });
      return;
    }
    if (req.method !== 'GET' || url.pathname !== '/inventory') {
      sendJson(res, 404, { error: 'not found' });
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
    sendJson(res, 200, result.slice(0, limit));
  });
}

const ordersServer = createOrdersServer();
const inventoryServer = createInventoryServer();

ordersServer.listen(ORDERS_PORT, '127.0.0.1', () => {
  console.log(`orders mock listening on http://127.0.0.1:${ORDERS_PORT}`);
});
inventoryServer.listen(INVENTORY_PORT, '127.0.0.1', () => {
  console.log(`inventory mock listening on http://127.0.0.1:${INVENTORY_PORT}`);
});

function shutdown() {
  ordersServer.close(() => {
    inventoryServer.close(() => process.exit(0));
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
