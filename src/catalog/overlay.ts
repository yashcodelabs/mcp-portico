import fs from 'node:fs';

import { PorticoError } from '../shared/errors';
import { formatSchemaIssues, validateOverlaySchema } from './schema';
import type { PolicyOverlay } from './types';

export function validateOverlay(
  data: unknown,
): ReturnType<typeof validateOverlaySchema> {
  return validateOverlaySchema(data);
}

export function loadOverlay(filePath: string): PolicyOverlay {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new PorticoError('NOT_FOUND', `overlay file not found: ${filePath}`, {
      cause: error,
    });
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new PorticoError(
      'CONFIG_ERROR',
      `overlay file is not valid JSON: ${filePath}`,
      { cause: error },
    );
  }
  const issues = validateOverlaySchema(data);
  if (issues.length > 0) {
    throw new PorticoError('CONFIG_ERROR', `overlay is invalid: ${filePath}`, {
      details: { issues },
    });
  }
  return data as PolicyOverlay;
}

export { formatSchemaIssues };
