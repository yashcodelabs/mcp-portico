#!/usr/bin/env node
/**
 * Package smoke test and content audit (Phase 7 release prep).
 *
 * Packs the npm artifact (packing runs `prepack`, which builds a fresh
 * `dist/`), audits its contents against the published surface, verifies that
 * every relative link in the packaged documentation resolves inside the
 * tarball, audits the licenses of every installed production dependency, and
 * runs the CLI from the extracted tarball. Fails on any missing expected
 * file, leaked development file, broken doc link, unexpected dependency
 * license, or CLI regression.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(join(os.tmpdir(), 'portico-pack-'));

const EXPECTED_PACKAGE_FILES = [
  'dist/cli/index.js',
  'dist/cli/serve.js',
  'dist/inspector/server.js',
  'dist/inspector/page.js',
  'schemas/catalog.v2.schema.json',
  'schemas/overlay.v1.schema.json',
  'schemas/registry.v1.schema.json',
  'schemas/README.md',
  'LICENSE',
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'examples/README.md',
  'examples/apis/petstore.openapi.yaml',
  'examples/apis/petstore.catalog.json',
  'examples/sample-catalog.json',
  'examples/sample-overlay.json',
  'examples/sample-registry.json',
  'examples/sample-registry.yaml',
  'docs/registry.md',
  'docs/migration.md',
  'docs/deprecation-inventory.md',
];

const FORBIDDEN_PACKAGE_PREFIXES = [
  'src/',
  'test/',
  'scripts/',
  'node_modules/',
  'dist/../',
  '.env',
  '.github/',
  '.opencode/',
  '.cursor/',
  'docs/assets/',
  'docs/ai-analysis.md',
  'docs/mcp-portico-implementation-plan.md',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'vitest.config.ts',
];

const ALLOWED_LICENSES = new Set([
  '0BSD',
  'APACHE-2.0',
  'BSD-2-CLAUSE',
  'BSD-3-CLAUSE',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'UNLICENSE',
]);

const problems = [];

function listFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) files.push(...listFiles(fullPath));
    else files.push(fullPath);
  }
  return files;
}

function run(cmd, args, cwd, options = {}) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  });
}

function licenseExpression(license) {
  if (license === undefined || license === null) return null;
  if (typeof license === 'string') return license;
  if (typeof license === 'object' && typeof license.type === 'string') {
    return license.type;
  }
  if (Array.isArray(license)) {
    const types = license
      .map((entry) => (typeof entry === 'string' ? entry : entry?.type))
      .filter((entry) => typeof entry === 'string');
    return types.length > 0 ? types.join(' OR ') : null;
  }
  return null;
}

function isAllowedLicense(expression) {
  if (expression === null) return false;
  const tokens = expression
    .toUpperCase()
    .replace(/[()]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return tokens.every((token) => {
    if (token === 'AND' || token === 'OR' || token === 'WITH') return true;
    if (/^\d+(?:\.\d+)*$/.test(token)) return true; // SPDX version suffix, e.g. 2.0
    return ALLOWED_LICENSES.has(token);
  });
}

function collectInstalledPackages(nodeModulesDir) {
  const packages = [];
  const pending = [nodeModulesDir];
  while (pending.length > 0) {
    const dir = pending.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      pending.push(join(dir, entry.name));
    }
    const manifestFile = join(dir, 'package.json');
    if (!existsSync(manifestFile)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
      if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
        packages.push({
          name: manifest.name,
          version: manifest.version,
          license: manifest.license,
        });
      }
    } catch {
      // Ignore malformed manifests; a broken install fails earlier.
    }
  }
  return packages;
}

function auditMarkdownLinks(extractDir, files) {
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const text = readFileSync(join(extractDir, file), 'utf8');
    linkPattern.lastIndex = 0;
    let match;
    while ((match = linkPattern.exec(text)) !== null) {
      const raw = match[1].trim();
      if (raw === '' || raw.startsWith('#')) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue; // absolute URL or scheme
      const target = raw.split('#')[0];
      if (target === '') continue;
      if (!existsSync(resolve(extractDir, dirname(file), target))) {
        problems.push(`broken link in packaged ${file}: ${raw}`);
      }
    }
  }
}

try {
  // When invoked through pnpm, npm_execpath points at the pnpm JS entrypoint,
  // which spawnSync can execute on every platform (raw "pnpm" is a .CMD shim
  // on Windows and is not directly spawnable).
  const pnpmEntry = process.env.npm_execpath;
  const packOutput =
    pnpmEntry !== undefined && pnpmEntry !== ''
      ? run(process.execPath, [pnpmEntry, 'pack', '--pack-destination', TMP], ROOT)
      : run('pnpm', ['pack', '--pack-destination', TMP], ROOT, {
          shell: process.platform === 'win32',
        });
  const tarballName = /([^\s]+\.tgz)/.exec(packOutput)?.[1];
  if (tarballName === undefined) {
    problems.push(`could not determine packed tarball from output: ${packOutput}`);
  }
  const tarball = isAbsolute(tarballName ?? '')
    ? tarballName
    : join(TMP, tarballName ?? '');
  if (!existsSync(tarball)) {
    problems.push(`packed tarball not found: ${tarball}`);
  } else {
    const extractDir = join(TMP, 'package');
    run('tar', ['-xzf', tarball, '-C', TMP], ROOT);
    if (!existsSync(join(extractDir, 'package.json'))) {
      problems.push('tarball does not contain a package root');
    } else {
      const pkg = JSON.parse(readFileSync(join(extractDir, 'package.json'), 'utf8'));
      if (pkg.name !== 'mcp-portico') problems.push(`package name is "${pkg.name}"`);
      if (pkg.version !== '0.1.0') problems.push(`package version is "${pkg.version}"`);
      if (pkg.license !== 'Apache-2.0') {
        problems.push(`package license is "${pkg.license}"`);
      }

      const files = listFiles(extractDir).map((file) =>
        relative(extractDir, file).replace(/\\/g, '/'),
      );
      for (const expected of EXPECTED_PACKAGE_FILES) {
        if (!files.includes(expected))
          problems.push(`missing packaged file: ${expected}`);
      }
      for (const file of files) {
        for (const prefix of FORBIDDEN_PACKAGE_PREFIXES) {
          if (file.startsWith(prefix)) {
            problems.push(`leaked file in package: ${file}`);
          }
        }
      }
      auditMarkdownLinks(extractDir, files);

      // Install the tarball into a fresh consumer project so dependency
      // resolution is tested exactly like a real installation.
      const consumer = join(TMP, 'consumer');
      mkdirSync(consumer);
      writeFileSync(
        join(consumer, 'package.json'),
        JSON.stringify({ name: 'portico-consumer', version: '0.0.0', private: true }),
        'utf8',
      );
      const consumerPnpmEntry = process.env.npm_execpath;
      const pnpmArgs = [consumerPnpmEntry, 'add', tarball, '--dir', consumer];
      if (consumerPnpmEntry === undefined || consumerPnpmEntry === '') {
        pnpmArgs.shift();
      }
      const addOutput = run(
        consumerPnpmEntry !== undefined && consumerPnpmEntry !== ''
          ? process.execPath
          : 'pnpm',
        pnpmArgs,
        ROOT,
        {
          shell: consumerPnpmEntry === undefined && process.platform === 'win32',
        },
      );
      if (!existsSync(join(consumer, 'node_modules', 'mcp-portico'))) {
        problems.push(
          `consumer install did not produce node_modules/mcp-portico: ${addOutput}`,
        );
      }

      const cli = join(
        consumer,
        'node_modules',
        'mcp-portico',
        'dist',
        'cli',
        'index.js',
      );
      const help = run('node', [cli, '--help'], consumer);
      if (!help.includes('Usage'))
        problems.push('packed CLI --help does not show usage');
      const validate = run(
        'node',
        [
          cli,
          'catalog',
          'validate',
          join(ROOT, 'test', 'fixtures', 'catalog', 'sample-catalog.json'),
        ],
        consumer,
      );
      if (!validate.includes('Valid:')) {
        problems.push('packed CLI catalog validate failed');
      }
      const imported = run(
        'node',
        [
          cli,
          'catalog',
          'import',
          join(ROOT, 'test', 'fixtures', 'import', 'petstore.openapi30.json'),
          '--api-id',
          'pack-smoke',
          '--output',
          join(TMP, 'pack-smoke.catalog.json'),
        ],
        consumer,
      );
      if (!imported.includes('Imported')) {
        problems.push('packed CLI catalog import failed');
      }

      const installed = collectInstalledPackages(join(consumer, 'node_modules'));
      const licenseProblems = installed.filter(
        (pkg) => !isAllowedLicense(licenseExpression(pkg.license)),
      );
      if (licenseProblems.length > 0) {
        problems.push(
          `license audit failed: ${licenseProblems
            .map((pkg) => `${pkg.name}@${pkg.version} (${JSON.stringify(pkg.license)})`)
            .join(', ')}`,
        );
      }
    }
  }
} catch (error) {
  problems.push(`pack smoke failed: ${String(error)}`);
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(`Package smoke test failed (${problems.length} problem(s)):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('Package smoke test passed: tarball contents and CLI verified.');
}
