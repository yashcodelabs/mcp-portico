import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AI_CONFIDENCE_THRESHOLD,
  AI_DEFAULT_CONFIDENCE,
} from '../../src/catalog/types';
import { CompileError } from '../../src/catalog/compile';
import { isPorticoError } from '../../src/shared/errors';
import { importOpenApi } from '../../src/importers/openapi/import';
import type { ImportOptions } from '../../src/importers/openapi/types';

const FIXED_NOW = new Date('2026-08-07T00:00:00.000Z');

function writeTemp(name: string, content: string): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'portico-ai-'));
  const file = path.join(dir, name);
  writeFileSync(file, content, 'utf8');
  return { dir, file };
}

function aiDocument(overrides: Record<string, unknown> = {}): string {
  const doc: Record<string, unknown> = {
    openapi: '3.0.3',
    info: { title: 'Orders API', version: '1.0.0' },
    paths: {
      '/orders': {
        get: {
          operationId: 'orders.list',
          responses: { 200: { description: 'ok' } },
          security: [{ bearerAuth: [] }],
          'x-mcp-portico': { confidence: 0.95, authStatus: 'resolved' },
        },
        post: {
          operationId: 'orders.create',
          responses: { 201: { description: 'created' } },
          security: [{ bearerAuth: [] }],
          'x-mcp-portico': { confidence: 0.4, authStatus: 'resolved' },
        },
      },
      '/orders/{orderId}': {
        get: {
          operationId: 'orders.get',
          parameters: [
            { name: 'orderId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'ok' } },
          security: [{ bearerAuth: [] }],
          'x-mcp-portico': { confidence: 0.9, authStatus: 'unresolved' },
        },
      },
      '/health': {
        get: {
          operationId: 'health.get',
          responses: { 200: { description: 'ok' } },
          'x-mcp-portico': { confidence: 0.99, authStatus: 'public' },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
    },
    'x-mcp-portico': {
      confidence: 0.85,
      analyzer: 'mcp-portico-analyze',
      analyzerVersion: '0.1.0',
      repo: 'acme/orders-api',
      warnings: [{ code: 'INFERRED_SCHEMA', message: 'Order inferred from DTO' }],
      ...overrides,
    },
  };
  return JSON.stringify(doc, null, 2);
}

async function importAi(content: string, options: Partial<ImportOptions> = {}) {
  const { dir, file } = writeTemp('openapi.json', content);
  try {
    return await importOpenApi(file, {
      apiId: 'orders',
      sourceType: 'ai',
      now: FIXED_NOW,
      ...options,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('AI artifact import (--ai)', () => {
  it('records AI provenance and confidence on the compiled catalog', async () => {
    const { catalog, report } = await importAi(aiDocument());
    expect(catalog.provenance.sourceType).toBe('ai');
    expect(catalog.provenance.confidence).toBe(0.85);
    expect(catalog.provenance.warnings?.map((w) => w.code)).toContain(
      'INFERRED_SCHEMA',
    );
    expect(report.sourceType).toBe('ai');
    expect(report.confidence).toBe(0.85);
    expect(catalog.operations['orders.list']?.available).toBe(true);
    expect(catalog.operations['health.get']?.available).toBe(true);
  });

  it('marks unresolved-authorization operations as unavailable', async () => {
    const { catalog } = await importAi(aiDocument());
    const op = catalog.operations['orders.get'];
    expect(op?.available).toBe(false);
    expect(catalog.provenance.warnings?.map((w) => w.code)).toContain(
      'UNRESOLVED_AUTHORIZATION',
    );
  });

  it('marks low-confidence operations as unavailable', async () => {
    const { catalog } = await importAi(aiDocument());
    const op = catalog.operations['orders.create'];
    expect(op?.available).toBe(false);
    const lowConfidence = catalog.provenance.warnings?.find(
      (w) => w.code === 'LOW_CONFIDENCE',
    );
    expect(lowConfidence?.message).toContain(String(AI_CONFIDENCE_THRESHOLD));
  });

  it('compiles deterministically with a stable checksum', async () => {
    const first = await importAi(aiDocument());
    const second = await importAi(aiDocument());
    expect(second.catalog.checksum).toBe(first.catalog.checksum);
    expect(second.catalog.provenance.generatedAt).toBe(
      first.catalog.provenance.generatedAt,
    );
  });

  it('fails closed when the root x-mcp-portico block is missing', async () => {
    const doc = JSON.parse(aiDocument()) as Record<string, unknown>;
    delete doc['x-mcp-portico'];
    const error = await importAi(JSON.stringify(doc)).catch((e: unknown) => e);
    expect(isPorticoError(error)).toBe(true);
    expect((error as { code: string }).code).toBe('CONFIG_ERROR');
    const details = (
      error as {
        details?: { issues?: Array<{ code: string }> };
      }
    ).details;
    expect(details?.issues?.map((i) => i.code)).toContain('AI_METADATA_REQUIRED');
  });

  it('uses the fail-safe confidence with a warning when confidence is missing', async () => {
    const { catalog } = await importAi(
      aiDocument({
        confidence: undefined,
      }),
    );
    expect(catalog.provenance.confidence).toBe(AI_DEFAULT_CONFIDENCE);
    expect(catalog.provenance.warnings?.map((w) => w.code)).toContain(
      'AI_UNSET_CONFIDENCE',
    );
  });

  it('rejects out-of-range root confidence', async () => {
    const error = await importAi(aiDocument({ confidence: 1.5 })).catch(
      (e: unknown) => e,
    );
    expect(isPorticoError(error)).toBe(true);
    expect(String((error as Error).message)).toContain('0 and 1');
  });

  it('rejects out-of-range operation confidence at compile time', async () => {
    const doc = JSON.parse(aiDocument()) as Record<string, unknown>;
    ((doc.paths as Record<string, unknown>)['/orders'] as Record<string, unknown>).get =
      {
        operationId: 'orders.list',
        responses: { 200: { description: 'ok' } },
        'x-mcp-portico': { confidence: 2, authStatus: 'resolved' },
      };
    const error = await importAi(JSON.stringify(doc)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CompileError);
    expect((error as CompileError).issues.map((i) => i.code)).toContain(
      'INVALID_AI_CONFIDENCE',
    );
  });

  it('rejects malformed root warnings entries', async () => {
    const error = await importAi(aiDocument({ warnings: [{ code: 42 }] })).catch(
      (e: unknown) => e,
    );
    expect(isPorticoError(error)).toBe(true);
    expect(String((error as Error).message)).toContain('warnings');
  });

  it('still rejects overlays that invent operations', async () => {
    const error = await importAi(aiDocument(), {
      overlay: {
        overlayVersion: '1.0',
        operations: { 'orders.invented': { enabled: true } },
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CompileError);
    expect((error as CompileError).issues.map((i) => i.code)).toContain(
      'OVERLAY_UNKNOWN_OPERATION',
    );
  });

  it('ignores x-mcp-portico metadata in non-AI imports', async () => {
    const { dir, file } = writeTemp('openapi.json', aiDocument());
    try {
      const { catalog } = await importOpenApi(file, {
        apiId: 'orders',
        now: FIXED_NOW,
      });
      expect(catalog.provenance.sourceType).toBe('openapi');
      expect(catalog.provenance.confidence).toBe(1);
      expect(catalog.operations['orders.get']?.available).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
