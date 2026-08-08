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

/** True when a header name is reserved and must never be client- or config-controlled. */
export function isProtectedUpstreamHeaderName(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    PROTECTED_HEADERS.has(normalized) ||
    normalized.startsWith(HEADER_PREFIX) ||
    normalized === 'x-mcp-portico'
  );
}

export interface SanitizeUpstreamHeadersOptions {
  /**
   * Header names that are allowed to survive sanitization. The auth
   * providers use this to keep their own `authorization` credential header
   * while still stripping every other protected header.
   */
  allow?: Iterable<string>;
}

/**
 * Remove headers that must never travel upstream from an outbound request.
 * Protected headers are stripped unless explicitly listed in `allow`
 * (credential injection by an auth provider).
 */
export function sanitizeUpstreamHeaders(
  headers: Map<string, string>,
  options: SanitizeUpstreamHeadersOptions = {},
): void {
  const allow = new Set([...(options.allow ?? [])].map((name) => name.toLowerCase()));
  for (const name of [...headers.keys()]) {
    const normalized = name.toLowerCase();
    if (allow.has(normalized)) continue;
    if (isProtectedUpstreamHeaderName(normalized)) {
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

/**
 * Render a URL with the values of the named query parameters replaced by a
 * redaction placeholder. Used wherever a request URL (including `finalUrl`)
 * can be observed: MCP results, inspector payloads, CLI output, and logs.
 */
export function redactUrlQuerySecrets(
  url: URL,
  secretParamNames: Iterable<string>,
): string {
  const redacted = new URL(url.toString());
  for (const name of secretParamNames) {
    if (redacted.searchParams.has(name)) {
      redacted.searchParams.set(name, '<redacted>');
    }
  }
  return redacted.toString();
}
