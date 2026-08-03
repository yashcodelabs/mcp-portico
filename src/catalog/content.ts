import type { BodyKind } from './types';

const EXACT_SUPPORTED: ReadonlyArray<{ contentType: string; kind: BodyKind }> = [
  { contentType: 'application/json', kind: 'json' },
  { contentType: 'application/x-www-form-urlencoded', kind: 'form' },
  { contentType: 'multipart/form-data', kind: 'multipart' },
  { contentType: 'application/octet-stream', kind: 'binary' },
];

/**
 * Classify a media type into a supported body kind, or undefined when the
 * content type is not supported. Supports exact types, `text/*`, and JSON
 * vendor types (`*+json`). Content-type parameters after `;` are ignored.
 */
export function classifyContentType(contentType: string): BodyKind | undefined {
  const mediaType = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  for (const entry of EXACT_SUPPORTED) {
    if (mediaType === entry.contentType) return entry.kind;
  }
  if (mediaType.startsWith('text/')) return 'text';
  if (mediaType.endsWith('+json')) return 'json';
  return undefined;
}

export function isSupportedContentType(contentType: string): boolean {
  return classifyContentType(contentType) !== undefined;
}

/** Derive the body kind for a set of content types; undefined when mixed. */
export function deriveBodyKind(contentTypes: string[]): BodyKind | undefined {
  const kinds = new Set<BodyKind>();
  for (const contentType of contentTypes) {
    const kind = classifyContentType(contentType);
    if (kind !== undefined) kinds.add(kind);
  }
  return kinds.size === 1 ? [...kinds][0] : undefined;
}
