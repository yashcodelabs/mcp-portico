#!/usr/bin/env node
/**
 * Brand-reference and secret sweep.
 *
 * Scans the repository for legacy product names and committed-secret-shaped
 * strings. Exit code 0 when clean, 1 when any match is found.
 *
 * Usage:
 *   node scripts/sweep.mjs            # brand + secrets
 *   node scripts/sweep.mjs --brand    # brand references only
 *   node scripts/sweep.mjs --secrets  # secret-shaped strings only
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.pnpm-store',
]);

const IGNORED_FILES = new Set(['pnpm-lock.yaml', '.DS_Store', 'Thumbs.db']);

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
]);

/**
 * Files that intentionally document the legacy product names. The sweep
 * skips them; everything else must stay brand-clean.
 *
 * - docs/deprecation-inventory.md: the documented exception that names the
 *   legacy product identifiers so the rest of the repository can stay clean.
 * - scripts/sweep.mjs: contains the pattern definitions themselves.
 * - test/fixtures/redaction/sample-response.json: deliberately contains fake
 *   secret-shaped values so redaction tests have realistic input.
 * - test/unit/errors.test.ts: deliberately contains fake secret-shaped values
 *   to assert that error serialization redacts them.
 */
export const ALLOWLISTED_FILES = new Set([
  'docs/deprecation-inventory.md',
  'scripts/sweep.mjs',
  'test/fixtures/redaction/sample-response.json',
  'test/unit/errors.test.ts',
]);

export const BRAND_PATTERNS = [
  { name: 'legacy product name mcpify', re: /\bmcpify\b/gi },
  { name: 'legacy product name dfx', re: /\bdfx\b/gi },
  { name: 'legacy brand dfanx', re: /\bdfanx\b/gi },
  { name: 'legacy brand digitalfanexperience', re: /digitalfanexperience/gi },
  {
    name: 'legacy team identifiers',
    re: /dev-grizzlies|dev-hawks|dev-chicago-sky/gi,
  },
];

export const SECRET_PATTERNS = [
  {
    name: 'JWT-shaped token',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    name: 'private key block',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g,
  },
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'AWS access key ID', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'GitHub personal access token', re: /\bghp_[A-Za-z0-9]{30,}\b/g },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
];

export function scanText(content, patterns) {
  const matches = [];
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const pattern of patterns) {
      pattern.re.lastIndex = 0;
      let found;
      while ((found = pattern.re.exec(line)) !== null) {
        matches.push({
          pattern: pattern.name,
          line: index + 1,
          column: found.index + 1,
          snippet: line.trim().slice(0, 160),
        });
      }
    }
  }
  return matches;
}

function collectFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else if (stats.isFile() && !IGNORED_FILES.has(entry)) {
      const extension = entry.slice(entry.lastIndexOf('.')).toLowerCase();
      if (!BINARY_EXTENSIONS.has(extension)) files.push(fullPath);
    }
  }
  return files;
}

function parseArgs(argv) {
  const flags = new Set(argv.slice(2));
  const brand =
    flags.has('--brand') || (!flags.has('--secrets') && !flags.has('--brand'));
  const secrets =
    flags.has('--secrets') || (!flags.has('--secrets') && !flags.has('--brand'));
  return { brand, secrets };
}

const { brand, secrets } = parseArgs(process.argv);
const patterns = [
  ...(brand ? BRAND_PATTERNS : []),
  ...(secrets ? SECRET_PATTERNS : []),
];

const failures = [];
for (const file of collectFiles(ROOT)) {
  const relativePath = relative(ROOT, file).replace(/\\/g, '/');
  if (ALLOWLISTED_FILES.has(relativePath)) continue;
  const content = readFileSync(file, 'utf8');
  for (const match of scanText(content, patterns)) {
    failures.push({ file: relativePath, ...match });
  }
}

if (failures.length > 0) {
  console.error(`Found ${failures.length} match(es):`);
  for (const failure of failures) {
    console.error(
      `  ${failure.file}:${failure.line}:${failure.column} [${failure.pattern}] ${failure.snippet}`,
    );
  }
  process.exit(1);
}

const checks = [brand ? 'brand' : null, secrets ? 'secrets' : null].filter(Boolean);
console.log(
  `Sweep clean (${checks.join(' + ')}) across ${collectFiles(ROOT).length} files.`,
);
