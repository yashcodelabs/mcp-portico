#!/usr/bin/env node
/**
 * Fixture validation.
 *
 * Ensures the fixture directories exist, JSON fixtures parse, catalog and
 * overlay fixtures pass their published JSON Schemas, fixtures under an
 * `invalid/` directory fail schema validation as expected, and no fixture
 * contains secret-shaped strings or legacy brand references.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALLOWLISTED_FILES,
  BRAND_PATTERNS,
  SECRET_PATTERNS,
  scanText,
} from './sweep.mjs';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

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

function loadJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function createValidator(schemaFile) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(loadJson(join(ROOT, 'schemas', schemaFile)));
  return (data) => {
    if (validate(data)) return [];
    return (validate.errors ?? []).map(
      (error) => `${error.instancePath || '/'}: ${error.message ?? 'invalid'}`,
    );
  };
}

const validateCatalog = createValidator('catalog.v2.schema.json');
const validateOverlay = createValidator('overlay.v1.schema.json');
const validateRegistry = createValidator('registry.v1.schema.json');

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
    const isJson = file.endsWith('.json');
    const isYaml = file.endsWith('.yaml') || file.endsWith('.yml');
    const basename = relativePath.split('/').pop() ?? '';
    const isRegistryFile = basename.includes('registry');
    if (isJson || isYaml) {
      let data;
      try {
        data = isJson ? JSON.parse(content) : require('yaml').parse(content);
      } catch (error) {
        problems.push(`${relativePath}: invalid document (${error.message})`);
        continue;
      }
      if (relativePath.includes('/invalid/')) {
        const catalogIssues = validateCatalog(data);
        const overlayIssues = validateOverlay(data);
        const registryIssues = validateRegistry(data);
        if (
          catalogIssues.length === 0 &&
          overlayIssues.length === 0 &&
          registryIssues.length === 0
        ) {
          problems.push(
            `${relativePath}: expected an invalid fixture, but it passed catalog, overlay, and registry schema validation`,
          );
        }
      } else if (relativePath.endsWith('catalog.json')) {
        const issues = validateCatalog(data);
        for (const issue of issues) {
          problems.push(`${relativePath}: catalog schema: ${issue}`);
        }
      } else if (relativePath.endsWith('overlay.json')) {
        const issues = validateOverlay(data);
        for (const issue of issues) {
          problems.push(`${relativePath}: overlay schema: ${issue}`);
        }
      } else if (isRegistryFile) {
        const issues = validateRegistry(data);
        for (const issue of issues) {
          problems.push(`${relativePath}: registry schema: ${issue}`);
        }
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
