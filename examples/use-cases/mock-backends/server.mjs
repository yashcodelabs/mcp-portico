#!/usr/bin/env node
/**
 * Local dummy backends for the Portico local demo.
 *
 * One process serves two independent "internal" APIs on separate ports:
 *   - Finance API   on 127.0.0.1:4010 (X-API-Key auth, key `finance-demo-key`)
 *   - Support API   on 127.0.0.1:4020 (Bearer auth, token `support-demo-token`)
 *
 * The OpenAPI documents in ../apis describe the same contracts. Portico is
 * configured to call these URLs as its upstream connections; the data below
 * is fixed demo data so the MCP flow is deterministic.
 */

import http from 'node:http';

const FINANCE_PORT = Number(process.env.FINANCE_MOCK_PORT ?? 4010);
const SUPPORT_PORT = Number(process.env.SUPPORT_MOCK_PORT ?? 4020);
const FINANCE_API_KEY = process.env.FINANCE_MOCK_API_KEY ?? 'finance-demo-key';
const SUPPORT_TOKEN = process.env.SUPPORT_MOCK_TOKEN ?? 'support-demo-token';

const invoices = [
  {
    id: 'INV-1001',
    customerId: 'C-101',
    amount: 2400,
    currency: 'USD',
    status: 'overdue',
  },
  {
    id: 'INV-1002',
    customerId: 'C-102',
    amount: 875,
    currency: 'EUR',
    status: 'open',
  },
  {
    id: 'INV-1003',
    customerId: 'C-103',
    amount: 1420,
    currency: 'USD',
    status: 'paid',
  },
  {
    id: 'INV-1004',
    customerId: 'C-104',
    amount: 3100,
    currency: 'GBP',
    status: 'overdue',
  },
];

let nextInvoiceId = 1005;

const tickets = [
  {
    id: 'TK-201',
    subject: 'Cannot log in after password reset',
    status: 'open',
    priority: 'high',
    customerId: 'C-101',
  },
  {
    id: 'TK-202',
    subject: 'Invoice PDF download fails',
    status: 'pending',
    priority: 'medium',
    customerId: 'C-102',
  },
  {
    id: 'TK-203',
    subject: 'Requesting an enterprise plan quote',
    status: 'closed',
    priority: 'low',
    customerId: 'C-105',
  },
];

const customers = {
  'C-101': {
    id: 'C-101',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    plan: 'enterprise',
  },
  'C-102': {
    id: 'C-102',
    name: 'Grace Hopper',
    email: 'grace@example.com',
    plan: 'pro',
  },
  'C-103': { id: 'C-103', name: 'Alan Turing', email: 'alan@example.com', plan: 'pro' },
  'C-104': {
    id: 'C-104',
    name: 'Katherine Johnson',
    email: 'katherine@example.com',
    plan: 'enterprise',
  },
  'C-105': {
    id: 'C-105',
    name: 'Linus Torvalds',
    email: 'linus@example.com',
    plan: 'free',
  },
};

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function createFinanceServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    if (req.headers['x-api-key'] !== FINANCE_API_KEY) {
      sendJson(res, 401, { error: 'invalid or missing X-API-Key' });
      return;
    }

    if (req.method === 'GET' && path === '/invoices') {
      const status = url.searchParams.get('status');
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const filtered = status
        ? invoices.filter((invoice) => invoice.status === status)
        : invoices;
      sendJson(res, 200, filtered.slice(0, limit));
      return;
    }

    if (req.method === 'GET' && path.startsWith('/invoices/')) {
      const invoiceId = decodePathSegment(path.slice('/invoices/'.length));
      if (invoiceId === undefined) {
        sendJson(res, 400, { error: 'invalid invoice id' });
        return;
      }
      const invoice = invoices.find((entry) => entry.id === invoiceId);
      if (invoice === undefined) {
        sendJson(res, 404, { error: 'invoice not found' });
        return;
      }
      sendJson(res, 200, invoice);
      return;
    }

    if (req.method === 'POST' && path === '/invoices') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        sendJson(res, 400, { error: 'request body must be valid JSON' });
        return;
      }
      if (
        typeof body !== 'object' ||
        body === null ||
        typeof body.amount !== 'number' ||
        typeof body.currency !== 'string'
      ) {
        sendJson(res, 400, { error: 'amount and currency are required' });
        return;
      }
      const invoice = {
        id: `INV-${nextInvoiceId}`,
        customerId: body.customerId ?? 'C-UNKNOWN',
        amount: body.amount ?? 0,
        currency: body.currency ?? 'USD',
        status: 'open',
      };
      nextInvoiceId += 1;
      invoices.push(invoice);
      sendJson(res, 201, invoice);
      return;
    }

    if (req.method === 'GET' && path === '/reports/usage') {
      sendJson(res, 200, {
        generatedAt: new Date().toISOString(),
        totals: {
          invoices: invoices.length,
          open: invoices.filter((invoice) => invoice.status === 'open').length,
          overdue: invoices.filter((invoice) => invoice.status === 'overdue').length,
          paid: invoices.filter((invoice) => invoice.status === 'paid').length,
        },
      });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  });
}

function createSupportServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    if (req.headers.authorization !== `Bearer ${SUPPORT_TOKEN}`) {
      sendJson(res, 401, { error: 'invalid or missing bearer token' });
      return;
    }

    if (req.method === 'GET' && path === '/tickets') {
      const status = url.searchParams.get('status');
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const filtered = status
        ? tickets.filter((ticket) => ticket.status === status)
        : tickets;
      sendJson(res, 200, filtered.slice(0, limit));
      return;
    }

    if (req.method === 'GET' && path.startsWith('/tickets/')) {
      const ticketId = decodePathSegment(path.slice('/tickets/'.length));
      if (ticketId === undefined) {
        sendJson(res, 400, { error: 'invalid ticket id' });
        return;
      }
      const ticket = tickets.find((entry) => entry.id === ticketId);
      if (ticket === undefined) {
        sendJson(res, 404, { error: 'ticket not found' });
        return;
      }
      sendJson(res, 200, ticket);
      return;
    }

    if (req.method === 'GET' && path.startsWith('/customers/')) {
      const customerId = decodePathSegment(path.slice('/customers/'.length));
      if (customerId === undefined) {
        sendJson(res, 400, { error: 'invalid customer id' });
        return;
      }
      const customer = customers[customerId];
      if (customer === undefined) {
        sendJson(res, 404, { error: 'customer not found' });
        return;
      }
      sendJson(res, 200, customer);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  });
}

const finance = createFinanceServer();
const support = createSupportServer();

finance.listen(FINANCE_PORT, '127.0.0.1', () => {
  console.log(`finance mock listening on http://127.0.0.1:${FINANCE_PORT}`);
});
support.listen(SUPPORT_PORT, '127.0.0.1', () => {
  console.log(`support mock listening on http://127.0.0.1:${SUPPORT_PORT}`);
});

function shutdown() {
  finance.close(() => process.exit(0));
  support.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
