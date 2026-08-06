/**
 * Small shared helpers for untrusted OpenAPI/Swagger input handling.
 */

import { PorticoError } from '../../shared/errors';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Return an array, treating `undefined` as an empty array and rejecting non-arrays. */
export function asArray(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new PorticoError('CONFIG_ERROR', `${label} must be an array.`);
  }
  return value;
}

export function asStringArray(value: unknown, label: string): string[] {
  return asArray(value, label).map((item, index) => {
    if (typeof item !== 'string') {
      throw new PorticoError('CONFIG_ERROR', `${label}[${index}] must be a string.`);
    }
    return item;
  });
}

export function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new PorticoError('CONFIG_ERROR', `${label} must be a string.`);
  }
  return value;
}

export function requiredString(value: unknown, label: string): string {
  const result = optionalString(value, label);
  if (result === undefined || result === '') {
    throw new PorticoError('CONFIG_ERROR', `${label} is required.`);
  }
  return result;
}

/** Encode one JSON pointer reference token per RFC 6901. */
export function encodePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Decode one JSON pointer reference token per RFC 6901. */
export function decodePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Readable location string for report entries, e.g. /paths/~1pets/get. */
export function locationOf(pathKey: string, method?: string, suffix?: string): string {
  const encoded = encodePointerToken(pathKey);
  const parts = [`/paths/${encoded}`];
  if (method !== undefined) parts.push(method);
  if (suffix !== undefined) parts.push(suffix);
  return parts.join('/');
}
