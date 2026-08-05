import { HEADER_PREFIX } from '../shared/brand';
import { PorticoError } from '../shared/errors';

/**
 * Upstream header hygiene.
 *
 * Connection-level static headers and any client-supplied headers must never
 * control hop-by-hop behavior, the request target, body framing, or Portico
 * client identity. The auth provider remains the only source of upstream
 * credentials.
 */

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const PROTECTED_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  'host',
  'content-length',
  'authorization',
  'expect',
]);

/** Remove headers that must never travel upstream from an outbound request. */
export function sanitizeUpstreamHeaders(headers: Map<string, string>): void {
  for (const name of [...headers.keys()]) {
    const normalized = name.toLowerCase();
    if (
      PROTECTED_HEADERS.has(normalized) ||
      normalized.startsWith(HEADER_PREFIX) ||
      normalized === 'x-mcp-portico'
    ) {
      headers.delete(name);
    }
  }
}

/**
 * Validate connection-level static headers at registry validation time so a
 * misconfigured header fails before it can reach an upstream server.
 */
export function assertStaticHeadersSafe(
  staticHeaders: Record<string, string> | undefined,
): string[] {
  const problems: string[] = [];
  for (const name of Object.keys(staticHeaders ?? {})) {
    const normalized = name.toLowerCase();
    if (PROTECTED_HEADERS.has(normalized)) {
      problems.push(
        `static header "${name}" is reserved (${normalized}) and cannot be set by a connection`,
      );
    }
    if (normalized.startsWith(HEADER_PREFIX) || normalized === 'x-mcp-portico') {
      problems.push(
        `static header "${name}" uses the MCP Portico client header prefix and cannot be set by a connection`,
      );
    }
  }
  return problems;
}

export function assertStaticHeadersSafeOrThrow(
  staticHeaders: Record<string, string> | undefined,
): void {
  const problems = assertStaticHeadersSafe(staticHeaders);
  if (problems.length > 0) {
    throw new PorticoError('CONFIG_ERROR', 'Unsafe connection static headers.', {
      details: { problems },
    });
  }
}
