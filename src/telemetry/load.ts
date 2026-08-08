/**
 * Load audit events from a telemetry file for offline usage analysis.
 *
 * v1 never writes audit events to disk automatically; this loader accepts
 * an explicitly exported file (JSON array or newline-delimited JSON objects)
 * so the operator CLI can summarize usage without access to a running
 * server's in-memory audit log.
 */

import fs from 'node:fs';

import type { AuditAction, AuditEvent } from '../audit/log';
import { PorticoError } from '../shared/errors';

const ACTIONS: readonly AuditAction[] = [
  'authenticate',
  'discover',
  'select_connection',
  'describe_operation',
  'call_operation',
  'call_operations',
  'test_connection',
];

function invalid(message: string): PorticoError {
  return new PorticoError('CONFIG_ERROR', `Invalid telemetry file: ${message}`);
}

function parseEvent(value: unknown, location: string): AuditEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${location} must be a JSON object.`);
  }
  const record = value as Record<string, unknown>;
  const requiredString = (field: string, expected: string): string => {
    const fieldValue = record[field];
    if (typeof fieldValue !== 'string' || fieldValue === '') {
      throw invalid(`${location} field "${field}" must be ${expected}.`);
    }
    return fieldValue;
  };
  const requiredNumber = (field: string, expected: string): number => {
    const fieldValue = record[field];
    if (typeof fieldValue !== 'number') {
      throw invalid(`${location} field "${field}" must be ${expected}.`);
    }
    return fieldValue;
  };
  const optionalString = (field: string): string | undefined => {
    const fieldValue = record[field];
    if (fieldValue === undefined) return undefined;
    if (typeof fieldValue !== 'string') {
      throw invalid(`${location} field "${field}" must be a string.`);
    }
    return fieldValue;
  };
  const optionalNumber = (field: string): number | undefined => {
    const fieldValue = record[field];
    if (fieldValue === undefined) return undefined;
    if (typeof fieldValue !== 'number') {
      throw invalid(`${location} field "${field}" must be a number.`);
    }
    return fieldValue;
  };
  const action = requiredString('action', 'a known action') as AuditAction;
  if (!ACTIONS.includes(action)) {
    throw invalid(`${location} field "action" must be one of: ${ACTIONS.join(', ')}.`);
  }
  const outcome = requiredString('outcome', '"success" or "failure"');
  if (outcome !== 'success' && outcome !== 'failure') {
    throw invalid(`${location} field "outcome" must be "success" or "failure".`);
  }
  return {
    id: requiredString('id', 'a non-empty string'),
    timestamp: requiredString('timestamp', 'a non-empty string'),
    registryRevision: requiredNumber('registryRevision', 'a number'),
    action,
    outcome,
    ...(optionalString('tenantId') !== undefined
      ? { tenantId: optionalString('tenantId') }
      : {}),
    ...(optionalString('principalId') !== undefined
      ? { principalId: optionalString('principalId') }
      : {}),
    ...(optionalString('connectionId') !== undefined
      ? { connectionId: optionalString('connectionId') }
      : {}),
    ...(optionalString('backendId') !== undefined
      ? { backendId: optionalString('backendId') }
      : {}),
    ...(optionalString('catalogChecksum') !== undefined
      ? { catalogChecksum: optionalString('catalogChecksum') }
      : {}),
    ...(optionalString('operation') !== undefined
      ? { operation: optionalString('operation') }
      : {}),
    ...(optionalNumber('durationMs') !== undefined
      ? { durationMs: optionalNumber('durationMs') }
      : {}),
    ...(optionalString('errorCode') !== undefined
      ? { errorCode: optionalString('errorCode') }
      : {}),
    ...(optionalString('authMethod') !== undefined
      ? { authMethod: optionalString('authMethod') }
      : {}),
  };
}

function parseJsonLines(content: string): unknown[] {
  const events: unknown[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw invalid(`line ${index + 1} is not valid JSON.`);
    }
    events.push(parsed);
  }
  return events;
}

/**
 * Read audit events from a JSON array or JSONL file. Returns an empty list
 * for an empty file; throws CONFIG_ERROR on unreadable or malformed input.
 */
export function loadAuditEvents(filePath: string): AuditEvent[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new PorticoError(
      'CONFIG_ERROR',
      `Cannot read telemetry file "${filePath}".`,
      { cause: error },
    );
  }
  const trimmed = content.trim();
  if (trimmed === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = undefined;
  }
  const rawEvents = Array.isArray(parsed) ? parsed : parseJsonLines(trimmed);
  return rawEvents.map((value, index) => parseEvent(value, `event ${index + 1}`));
}
