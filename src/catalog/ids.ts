import type { HttpMethod } from './types';

/** Deterministic operation ID generation for the normalized model. */
export function generateOperationId(method: HttpMethod, path: string): string {
  const segments = path
    .split('/')
    .filter((segment) => segment !== '' && !isTemplateSegment(segment));
  const base = segments.length > 0 ? segments.join('.') : 'root';
  return `${base}.${method.toLowerCase()}`;
}

export function isTemplateSegment(segment: string): boolean {
  return segment.startsWith('{') && segment.endsWith('}');
}
