/**
 * Input reading, JSON/YAML parsing, and spec-version detection for the
 * OpenAPI/Swagger importer.
 */

import fs from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

import { PorticoError } from '../../shared/errors';
import type { ImportFormat, ImportLimits, SpecVersion } from './types';
import { isPlainObject } from './util';

export interface InputFile {
  raw: string;
  bytes: number;
  format: ImportFormat;
}

/** Read and size-check the root input document. */
export function readInputFile(inputPath: string, limits: ImportLimits): InputFile {
  const resolved = path.resolve(inputPath);
  let raw: string;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    throw new PorticoError('NOT_FOUND', `input file not found: ${inputPath}`, {
      cause: error,
    });
  }
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes > limits.maxBytesPerDocument) {
    throw new PorticoError(
      'CONFIG_ERROR',
      `Input document ${inputPath} is ${bytes} bytes, exceeding the ${limits.maxBytesPerDocument}-byte per-document limit.`,
    );
  }
  return { raw, bytes, format: detectFormat(resolved, raw) };
}

function detectFormat(resolved: string, raw: string): ImportFormat {
  const extension = path.extname(resolved).toLowerCase();
  if (extension === '.yaml' || extension === '.yml') return 'yaml';
  if (extension === '.json') return 'json';
  // Unknown extension: sniff JSON first, then fall back to YAML.
  try {
    JSON.parse(raw);
    return 'json';
  } catch {
    return 'yaml';
  }
}

export function parseDocumentText(
  raw: string,
  format: ImportFormat,
  label: string,
): unknown {
  try {
    if (format === 'json') return JSON.parse(raw);
    return YAML.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PorticoError(
      'CONFIG_ERROR',
      `${label} is not valid ${format.toUpperCase()}: ${message}`,
      { cause: error },
    );
  }
}

const OPENAPI3_VERSION_PATTERN = /^3\.[012](?:\.\d+)?$/;

/** Detect Swagger 2.0 or OpenAPI 3.0/3.1/3.2; anything else fails closed. */
export function detectSpecVersion(data: unknown): SpecVersion {
  if (!isPlainObject(data)) {
    throw new PorticoError(
      'CONFIG_ERROR',
      'OpenAPI/Swagger document must be a JSON/YAML object.',
    );
  }
  const swagger = data.swagger;
  const openapi = data.openapi;
  if (typeof swagger === 'string' && swagger.trim() === '2.0') {
    return { kind: 'swagger2', version: '2.0' };
  }
  if (typeof openapi === 'string') {
    const trimmed = openapi.trim();
    if (OPENAPI3_VERSION_PATTERN.test(trimmed)) {
      return { kind: 'openapi3', version: trimmed };
    }
    throw new PorticoError(
      'CONFIG_ERROR',
      `Unsupported OpenAPI version "${openapi}". Supported versions are Swagger 2.0 and OpenAPI 3.0, 3.1, and 3.2.`,
    );
  }
  throw new PorticoError(
    'CONFIG_ERROR',
    'Document declares neither a supported "swagger" nor an "openapi" version.',
  );
}
