#!/usr/bin/env node
/**
 * CLI smoke test against the built artifact.
 *
 * Requires `pnpm build` to have been run first. Verifies:
 *   1. `node dist/cli/index.js --help` exits 0 and advertises `serve`.
 *   2. `node dist/cli/index.js serve --help` lists the serve options.
 *   3. `node dist/cli/index.js serve` starts, answers /healthz, and shuts down.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist', 'cli', 'index.js');

function fail(message) {
  console.error(`smoke: ${message}`);
  process.exit(1);
}

function assertHelp() {
  const help = spawnSync(process.execPath, [CLI, '--help'], {
    encoding: 'utf8',
  });
  if (help.status !== 0) fail(`--help exited ${help.status}: ${help.stderr}`);
  if (
    !help.stdout.includes('mcp-portico') ||
    !help.stdout.includes('serve') ||
    !help.stdout.includes('demo')
  ) {
    fail(`--help output missing name, serve, or demo command:\n${help.stdout}`);
  }
  console.log('smoke: --help ok');
}

function assertServeHelp() {
  const help = spawnSync(process.execPath, [CLI, 'serve', '--help'], {
    encoding: 'utf8',
  });
  if (help.status !== 0) fail(`serve --help exited ${help.status}: ${help.stderr}`);
  for (const option of ['--host', '--port', '--auth-mode']) {
    if (!help.stdout.includes(option)) {
      fail(`serve --help missing ${option}:\n${help.stdout}`);
    }
  }
  console.log('smoke: serve --help ok');
}

function assertDemoHelp() {
  const help = spawnSync(process.execPath, [CLI, 'demo', '--help'], {
    encoding: 'utf8',
  });
  if (help.status !== 0) fail(`demo --help exited ${help.status}: ${help.stderr}`);
  for (const option of ['--max-orders', '--non-interactive']) {
    if (!help.stdout.includes(option)) {
      fail(`demo --help missing ${option}:\n${help.stdout}`);
    }
  }
  console.log('smoke: demo --help ok');
}

function assertCatalog() {
  const help = spawnSync(process.execPath, [CLI, 'catalog', '--help'], {
    encoding: 'utf8',
  });
  if (help.status !== 0) fail(`catalog --help exited ${help.status}: ${help.stderr}`);
  for (const command of ['import', 'validate', 'diff']) {
    if (!help.stdout.includes(command)) {
      fail(`catalog --help missing ${command}:\n${help.stdout}`);
    }
  }
  console.log('smoke: catalog --help ok');

  const valid = spawnSync(
    process.execPath,
    [CLI, 'catalog', 'validate', join(ROOT, 'examples', 'sample-catalog.json')],
    { encoding: 'utf8' },
  );
  if (valid.status !== 0)
    fail(`catalog validate exited ${valid.status}: ${valid.stderr}`);
  if (!valid.stdout.includes('Valid: 4 operation(s)')) {
    fail(`catalog validate unexpected output:\n${valid.stdout}`);
  }
  console.log('smoke: catalog validate ok');

  const invalid = spawnSync(
    process.execPath,
    [
      CLI,
      'catalog',
      'validate',
      join(ROOT, 'test', 'fixtures', 'catalog', 'invalid', 'unknown-field.json'),
    ],
    { encoding: 'utf8' },
  );
  if (invalid.status === 0) fail('catalog validate accepted an invalid catalog');
  if (!invalid.stderr.includes('CONFIG_ERROR')) {
    fail(`catalog validate did not report CONFIG_ERROR:\n${invalid.stderr}`);
  }
  console.log('smoke: catalog validate rejects invalid input ok');

  const diff = spawnSync(
    process.execPath,
    [
      CLI,
      'catalog',
      'diff',
      join(ROOT, 'examples', 'sample-catalog.json'),
      join(ROOT, 'examples', 'sample-catalog.json'),
    ],
    { encoding: 'utf8' },
  );
  if (diff.status !== 0) fail(`catalog diff exited ${diff.status}: ${diff.stderr}`);
  if (!diff.stdout.includes('No differences.')) {
    fail(`catalog diff unexpected output:\n${diff.stdout}`);
  }
  console.log('smoke: catalog diff ok');
}

function assertImport() {
  const directory = mkdtempSync(join(os.tmpdir(), 'portico-smoke-import-'));
  const catalogOut = join(directory, 'imported-catalog.json');
  const reportOut = join(directory, 'import-report.json');
  const spec = join(ROOT, 'test', 'fixtures', 'import', 'petstore.openapi30.json');
  try {
    const imported = spawnSync(
      process.execPath,
      [
        CLI,
        'catalog',
        'import',
        spec,
        '--api-id',
        'petstore',
        '--output',
        catalogOut,
        '--report',
        reportOut,
      ],
      { encoding: 'utf8' },
    );
    if (imported.status !== 0)
      fail(`catalog import exited ${imported.status}: ${imported.stderr}`);
    if (!imported.stdout.includes('6 operation(s)')) {
      fail(`catalog import unexpected output:\n${imported.stdout}`);
    }
    console.log('smoke: catalog import ok');

    const valid = spawnSync(
      process.execPath,
      [CLI, 'catalog', 'validate', catalogOut],
      { encoding: 'utf8' },
    );
    if (valid.status !== 0)
      fail(
        `catalog validate of imported output exited ${valid.status}: ${valid.stderr}`,
      );
    if (!valid.stdout.includes('Valid: 6 operation(s)')) {
      fail(`imported catalog validate unexpected output:\n${valid.stdout}`);
    }
    console.log('smoke: catalog import output validates ok');

    const report = JSON.parse(readFileSync(reportOut, 'utf8'));
    if (report.reportVersion !== '1.0' || report.summary.operations !== 6) {
      fail(`import report unexpected shape:\n${JSON.stringify(report)}`);
    }
    console.log('smoke: catalog import report ok');

    const rejected = spawnSync(
      process.execPath,
      [
        CLI,
        'catalog',
        'import',
        join(ROOT, 'test', 'fixtures', 'import', 'invalid', 'unknown-version.json'),
        '--api-id',
        'x',
        '--output',
        join(directory, 'rejected.json'),
      ],
      { encoding: 'utf8' },
    );
    if (rejected.status === 0) fail('catalog import accepted an unknown spec version');
    if (!rejected.stderr.includes('CONFIG_ERROR')) {
      fail(`catalog import did not report CONFIG_ERROR:\n${rejected.stderr}`);
    }
    console.log('smoke: catalog import rejects unknown spec version ok');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertRegistry() {
  const valid = spawnSync(
    process.execPath,
    [CLI, 'registry', 'validate', join(ROOT, 'examples', 'sample-registry.json')],
    { encoding: 'utf8' },
  );
  if (valid.status !== 0)
    fail(`registry validate exited ${valid.status}: ${valid.stderr}`);
  if (!valid.stdout.includes('Valid: 2 tenant(s), 2 principal(s), 2 backend(s)')) {
    fail(`registry validate unexpected output:\n${valid.stdout}`);
  }
  console.log('smoke: registry validate ok');

  const invalid = spawnSync(
    process.execPath,
    [
      CLI,
      'registry',
      'validate',
      join(ROOT, 'test', 'fixtures', 'registry', 'invalid', 'duplicate-ids.json'),
    ],
    { encoding: 'utf8' },
  );
  if (invalid.status === 0) fail('registry validate accepted an invalid registry');
  if (
    !invalid.stderr.includes('CONFIG_ERROR') ||
    !invalid.stderr.includes('DUPLICATE_ID')
  ) {
    fail(`registry validate did not report the duplicate id:\n${invalid.stderr}`);
  }
  console.log('smoke: registry validate rejects invalid input ok');
}

function assertKeyCreate() {
  const directory = mkdtempSync(join(os.tmpdir(), 'portico-smoke-key-'));
  const registry = join(directory, 'sample-registry.yaml');
  mkdirSync(join(directory, 'apis'), { recursive: true });
  copyFileSync(join(ROOT, 'examples', 'sample-registry.yaml'), registry);
  copyFileSync(
    join(ROOT, 'examples', 'sample-catalog.json'),
    join(directory, 'sample-catalog.json'),
  );
  copyFileSync(
    join(ROOT, 'examples', 'apis', 'petstore.catalog.json'),
    join(directory, 'apis', 'petstore.catalog.json'),
  );
  try {
    const created = spawnSync(
      process.execPath,
      [
        CLI,
        'key',
        'create',
        '--registry',
        registry,
        '--tenant',
        'acme',
        '--principal',
        'acme-automation',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, MCP_PORTICO_KEY_PEPPER: 'smoke-pepper' },
      },
    );
    if (created.status !== 0)
      fail(`key create exited ${created.status}: ${created.stderr}`);
    if (!created.stdout.includes('Key created - shown once: mpp_')) {
      fail(`key create did not print a key:\n${created.stdout}`);
    }
    console.log('smoke: key create ok');

    const withoutPepper = spawnSync(
      process.execPath,
      [
        CLI,
        'key',
        'create',
        '--registry',
        registry,
        '--tenant',
        'acme',
        '--principal',
        'acme-automation',
      ],
      { encoding: 'utf8', env: { ...process.env, MCP_PORTICO_KEY_PEPPER: '' } },
    );
    if (withoutPepper.status === 0) fail('key create succeeded without a pepper');
    if (!withoutPepper.stderr.includes('MCP_PORTICO_KEY_PEPPER')) {
      fail(`key create did not explain the missing pepper:\n${withoutPepper.stderr}`);
    }
    console.log('smoke: key create requires pepper ok');

    const validated = spawnSync(
      process.execPath,
      [CLI, 'registry', 'validate', registry],
      { encoding: 'utf8' },
    );
    if (validated.status !== 0)
      fail(
        `registry validate after key create exited ${validated.status}: ${validated.stderr}`,
      );
    console.log('smoke: registry validate after key create ok');

    const rollbackDirectory = mkdtempSync(
      join(os.tmpdir(), 'portico-smoke-key-rollback-'),
    );
    mkdirSync(join(rollbackDirectory, 'apis'), { recursive: true });
    copyFileSync(
      join(ROOT, 'examples', 'sample-catalog.json'),
      join(rollbackDirectory, 'sample-catalog.json'),
    );
    copyFileSync(
      join(ROOT, 'examples', 'apis', 'petstore.catalog.json'),
      join(rollbackDirectory, 'apis', 'petstore.catalog.json'),
    );
    const sample = JSON.parse(
      readFileSync(join(ROOT, 'examples', 'sample-registry.json'), 'utf8'),
    );
    sample.backends.push({
      id: 'billing',
      title: 'Duplicate backend',
      scope: 'global',
      catalogRef: './sample-catalog.json',
      catalogChecksum:
        'sha256:6d58295e29802224dad1624bb8b4c1e22c45433d32f91c69216c76ff5d87ed0d',
    });
    const rollbackRegistry = join(rollbackDirectory, 'registry.json');
    writeFileSync(rollbackRegistry, `${JSON.stringify(sample, null, 2)}\n`, 'utf8');
    const beforeRollback = readFileSync(rollbackRegistry, 'utf8');
    const rolledBack = spawnSync(
      process.execPath,
      [
        CLI,
        'key',
        'create',
        '--registry',
        rollbackRegistry,
        '--tenant',
        'acme',
        '--principal',
        'acme-automation',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, MCP_PORTICO_KEY_PEPPER: 'smoke-pepper' },
      },
    );
    if (rolledBack.status === 0)
      fail('key create succeeded against an invalid registry');
    if (!rolledBack.stderr.includes('Refusing to store the new key')) {
      fail(`key create did not refuse the invalid registry:\n${rolledBack.stderr}`);
    }
    if (readFileSync(rollbackRegistry, 'utf8') !== beforeRollback) {
      fail('key create did not restore the registry after a failed validation');
    }
    rmSync(rollbackDirectory, { recursive: true, force: true });
    console.log('smoke: key create rollback ok');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function assertConnectionTest() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"ok"}');
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const directory = mkdtempSync(join(os.tmpdir(), 'portico-smoke-connection-'));
  const registry = join(directory, 'smoke-registry.json');
  try {
    const catalogRef = join(ROOT, 'examples', 'sample-catalog.json').replace(
      /\\/g,
      '/',
    );
    writeFileSync(
      registry,
      `${JSON.stringify(
        {
          version: 1,
          tenants: [{ id: 'acme', name: 'Acme' }],
          principals: [],
          backends: [
            {
              id: 'smoke-backend',
              title: 'Smoke',
              scope: 'global',
              catalogRef,
              catalogChecksum:
                'sha256:6d58295e29802224dad1624bb8b4c1e22c45433d32f91c69216c76ff5d87ed0d',
            },
          ],
          connections: [
            {
              id: 'smoke-connection',
              tenantId: 'acme',
              backendId: 'smoke-backend',
              baseUrl: `http://127.0.0.1:${port}`,
              network: { allowedProtocols: ['http'], allowLoopback: true },
              auth: {
                type: 'apiKey',
                in: 'header',
                name: 'X-API-Key',
                valueRef: 'env:SMOKE_API_KEY',
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const result = await runCli(
      [
        'connection',
        'test',
        'smoke-connection',
        '--registry',
        registry,
        '--path',
        '/healthz',
      ],
      { SMOKE_API_KEY: 'smoke-key' },
    );
    if (result.status !== 0)
      fail(
        `connection test exited ${result.status}:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
    if (!result.stdout.includes('reachable') || !result.stdout.includes('status 200')) {
      fail(`connection test unexpected output:\n${result.stdout}`);
    }
    console.log('smoke: connection test ok');
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

function runCli(args, env = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', (error) =>
      resolveRun({ status: -1, stdout, stderr: String(error) }),
    );
    child.once('exit', (code) => resolveRun({ status: code ?? -1, stdout, stderr }));
  });
}

async function assertServe() {
  const port = await freePort();
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 15_000);

  try {
    await new Promise((resolveStarted, reject) => {
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
        if (output.includes('listening')) resolveStarted();
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (!timedOut)
          reject(new Error(`serve exited early with code ${code}: ${output}`));
      });
    });

    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    if (response.status !== 200) fail(`healthz returned ${response.status}`);
    const body = await response.json();
    if (body.name !== 'mcp-portico' || body.status !== 'ok') {
      fail(`unexpected healthz body: ${JSON.stringify(body)}`);
    }
    console.log('smoke: serve + /healthz ok');

    child.kill('SIGTERM');
    const exited = await new Promise((resolveExit) => {
      const exitTimer = setTimeout(() => {
        child.kill('SIGKILL');
        resolveExit(false);
      }, 5_000);
      child.once('exit', () => {
        clearTimeout(exitTimer);
        resolveExit(true);
      });
    });
    if (!exited) fail('serve did not stop after SIGTERM');
    console.log('smoke: graceful shutdown ok');
  } finally {
    clearTimeout(timer);
  }
}

assertHelp();
assertServeHelp();
assertDemoHelp();
assertCatalog();
assertImport();
assertRegistry();
assertKeyCreate();
await assertConnectionTest();
await assertServe();
console.log('smoke: all checks passed');
