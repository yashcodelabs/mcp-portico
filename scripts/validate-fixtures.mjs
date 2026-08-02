#!/usr/bin/env node
/**
 * Fixture validation.
 *
 * Ensures the fixture directories exist, JSON fixtures parse, and no fixture
 * contains secret-shaped strings or legacy brand references.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALLOWLISTED_FILES,
  BRAND_PATTERNS,
  SECRET_PATTERNS,
  scanText,
} from './sweep.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_ROOTS = ['examples', 'test/fixtures'];

function collectFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

const problems = [];
let fileCount = 0;

for (const root of FIXTURE_ROOTS) {
  const absoluteRoot = join(ROOT, root);
  if (!existsSync(absoluteRoot)) {
    problems.push(`Missing fixture root: ${root}/`);
    continue;
  }
  for (const file of collectFiles(absoluteRoot)) {
    fileCount += 1;
    const relativePath = relative(ROOT, file).replace(/\\/g, '/');
    if (ALLOWLISTED_FILES.has(relativePath)) continue;
    const content = readFileSync(file, 'utf8');
    if (file.endsWith('.json')) {
      try {
        JSON.parse(content);
      } catch (error) {
        problems.push(`${relativePath}: invalid JSON (${error.message})`);
      }
    }
    for (const match of scanText(content, [...BRAND_PATTERNS, ...SECRET_PATTERNS])) {
      problems.push(
        `${relativePath}:${match.line} [${match.pattern}] ${match.snippet}`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`Fixture validation failed (${problems.length} problem(s)):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`Fixture validation clean (${fileCount} file(s)).`);
