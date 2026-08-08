import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AuditEvent } from '../../src/audit/log';

const ROOT = path.join(__dirname, '..', '..');
const CLI_ENTRY = path.join(ROOT, 'src', 'cli', 'index.ts');

/**
 * tsx resolves its temp directory with os.userInfo(), which fails with
 * ENOMEM in restricted sandboxes. Stubbing process.geteuid (which tsx
 * prefers over userInfo) keeps the CLI runnable in tests.
 */
function tsxPreload(directory: string): string {
  const file = path.join(directory, 'tsx-preload.cjs');
  fs.writeFileSync(file, 'process.geteuid = () => 0;\n', 'utf8');
  return file;
}

function runCli(args: string[]): SpawnSyncReturns<string> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portico-cli-preload-'));
  try {
    return spawnSync(
      process.execPath,
      ['-r', tsxPreload(directory), '--import', 'tsx', CLI_ENTRY, ...args],
      {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function event(partial: Partial<AuditEvent>): AuditEvent {
  return {
    id: partial.id ?? 'event-id',
    timestamp: partial.timestamp ?? '2026-08-09T00:00:00.000Z',
    registryRevision: partial.registryRevision ?? 1,
    action: partial.action ?? 'call_operation',
    outcome: partial.outcome ?? 'success',
    ...partial,
  };
}

describe('mcp-portico usage summary CLI', () => {
  it('explains the in-memory persistence limitation without a file', () => {
    const result = runCli(['usage', 'summary']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('MCP Portico usage summary');
    expect(result.stdout).toContain('in-memory only');
    expect(result.stdout).toContain('never written to disk');
  });

  it('summarizes a JSON telemetry file and supports tenant filtering', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portico-cli-usage-'));
    try {
      const events = [
        event({
          tenantId: 'acme',
          connectionId: 'acme-billing',
          operation: 'invoice.get',
        }),
        event({
          tenantId: 'acme',
          connectionId: 'acme-billing',
          operation: 'invoice.get',
          outcome: 'failure',
        }),
        event({
          tenantId: 'acme',
          connectionId: 'acme-billing',
          operation: 'invoice.create',
        }),
        event({
          tenantId: 'globex',
          connectionId: 'globex-billing',
          operation: 'task.list',
        }),
        event({
          tenantId: 'globex',
          connectionId: 'globex-billing',
          operation: 'task.list',
        }),
        event({ tenantId: 'globex', action: 'select_connection' }),
      ];
      const jsonFile = path.join(directory, 'audit.json');
      const jsonlFile = path.join(directory, 'audit.jsonl');
      fs.writeFileSync(jsonFile, `${JSON.stringify(events, null, 2)}\n`);
      fs.writeFileSync(
        jsonlFile,
        `${events.map((item) => JSON.stringify(item)).join('\n')}\n`,
      );

      const all = runCli(['usage', 'summary', '--file', jsonFile]);
      expect(all.status).toBe(0);
      expect(all.stdout).toContain('Events: 6 (success 5, failure 1)');
      expect(all.stdout).toContain('By tenant:');
      expect(all.stdout).toContain('acme | acme: 3 (success 2, failure 1)');
      expect(all.stdout).toContain('globex | globex: 3 (success 3, failure 0)');
      expect(all.stdout).toContain('By connection:');
      expect(all.stdout).toContain('acme | acme-billing');
      expect(all.stdout).toContain('By operation:');
      expect(all.stdout).toContain('acme | invoice.get: 2 (success 1, failure 1)');
      expect(all.stdout).toContain('Persistence: in-memory only');

      const acmeOnly = runCli([
        'usage',
        'summary',
        '--file',
        jsonFile,
        '--tenant',
        'acme',
      ]);
      expect(acmeOnly.status).toBe(0);
      expect(acmeOnly.stdout).toContain('Scope: tenant "acme"');
      expect(acmeOnly.stdout).toContain('Events: 3 (success 2, failure 1)');
      expect(acmeOnly.stdout).not.toContain('globex');

      const jsonl = runCli(['usage', 'summary', '--file', jsonlFile]);
      expect(jsonl.status).toBe(0);
      expect(jsonl.stdout).toContain('Events: 6 (success 5, failure 1)');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects malformed telemetry files with a CONFIG_ERROR exit', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portico-cli-usage-'));
    try {
      const badFile = path.join(directory, 'bad.json');
      fs.writeFileSync(badFile, '{not json\n');
      const result = runCli(['usage', 'summary', '--file', badFile]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('CONFIG_ERROR');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
