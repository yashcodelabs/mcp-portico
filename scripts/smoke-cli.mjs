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
import net from 'node:net';
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
  if (!help.stdout.includes('mcp-portico') || !help.stdout.includes('serve')) {
    fail(`--help output missing name or serve command:\n${help.stdout}`);
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

function assertCatalog() {
  const help = spawnSync(process.execPath, [CLI, 'catalog', '--help'], {
    encoding: 'utf8',
  });
  if (help.status !== 0) fail(`catalog --help exited ${help.status}: ${help.stderr}`);
  for (const command of ['validate', 'diff']) {
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
assertCatalog();
await assertServe();
console.log('smoke: all checks passed');
