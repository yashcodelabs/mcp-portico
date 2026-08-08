import { defaultUpstreamAuthRegistry } from '../auth/upstream';
import { defaultSecretResolver, resolveSecretOrLiteral } from '../auth/secrets';
import type { SecretResolver, UpstreamRequest } from '../auth/types';
import type { Connection, NetworkPolicy } from '../registry/types';
import { defaultRedactor } from '../shared/redact';
import { redactUrlQuerySecrets } from './headers';
import { assertDestinationAllowed, assertDestinationDnsAllowed } from './network';
import { sanitizeUpstreamHeaders } from './headers';
import { isRedirectStatus, resolveRedirectTarget } from './redirects';

/**
 * Connection probe (`connection test`).
 *
 * Executes an operator-initiated health/authentication probe against a
 * connection under the full security policy: destination validation with
 * DNS checks, protocol and private-network restrictions, controlled
 * redirects, header sanitization, secret-resolved auth injection, and
 * response-size limits. Results are redacted.
 */

export interface ProbeOptions {
  url: URL;
  method?: string;
  body?: string;
  auth: Connection['auth'];
  staticHeaders?: Record<string, string>;
  network: NetworkPolicy;
  secrets?: SecretResolver;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface ProbeResult {
  ok: boolean;
  status: number;
  durationMs: number;
  bytes: number;
  truncated: boolean;
  redirected: boolean;
  finalUrl: string;
  headers: Record<string, string>;
  errorCode?: string;
  message?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const MAX_REDIRECTS = 5;

export async function executeProbe(options: ProbeOptions): Promise<ProbeResult> {
  const secrets = options.secrets ?? defaultSecretResolver;
  const authRegistry = defaultUpstreamAuthRegistry;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const redirects = options.network.redirects ?? 'none';
  const startedAt = Date.now();

  let url = options.url;
  let redirected = false;
  let method = options.method ?? 'GET';
  let body = options.body;
  let secretQueryParams = new Set<string>();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertDestinationAllowed(url, options.network, {
      context: 'request',
    });
    await assertDestinationDnsAllowed(url, options.network, {
      context: 'request',
    });

    const headers = new Map<string, string>();
    for (const [name, value] of Object.entries(options.staticHeaders ?? {})) {
      const resolved = await resolveSecretOrLiteral(value, secrets);
      if (resolved !== undefined) headers.set(name.toLowerCase(), resolved);
    }
    sanitizeUpstreamHeaders(headers);

    const request: UpstreamRequest = { url, headers, query: new Map() };
    const auth = authRegistry.toConnectionAuth(options.auth);
    const provider = authRegistry.get(options.auth.type);
    await provider.validate(auth);
    await provider.apply(request, auth, secrets);
    sanitizeUpstreamHeaders(request.headers, {
      allow:
        options.auth.type === 'bearer' || options.auth.type === 'basic'
          ? ['authorization']
          : [],
    });
    for (const [name, value] of request.query) {
      request.url.searchParams.set(name, value);
    }
    secretQueryParams = request.secretQueryParams ?? new Set<string>();

    let response: Response;
    try {
      response = await fetch(request.url, {
        method,
        headers: Object.fromEntries(request.headers),
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return {
        ok: false,
        status: 0,
        durationMs: Date.now() - startedAt,
        bytes: 0,
        truncated: false,
        redirected,
        finalUrl: redactUrlQuerySecrets(url, secretQueryParams),
        headers: {},
        errorCode: 'REQUEST_FAILED',
        message: error instanceof Error ? error.message : String(error),
      };
    }

    if (isRedirectStatus(response.status)) {
      const target = resolveRedirectTarget(
        response.url,
        response.headers.get('location'),
        redirects,
      );
      if (target !== undefined) {
        redirected = true;
        url = target;
        if (response.status === 303) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }
    }

    const { bytes, truncated } = await readBounded(response, maxResponseBytes);
    return {
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      durationMs: Date.now() - startedAt,
      bytes,
      truncated,
      redirected,
      finalUrl: redactUrlQuerySecrets(url, secretQueryParams),
      headers: redactResponseHeaders(response),
    };
  }

  return {
    ok: false,
    status: 0,
    durationMs: Date.now() - startedAt,
    bytes: 0,
    truncated: false,
    redirected,
    finalUrl: redactUrlQuerySecrets(url, secretQueryParams),
    headers: {},
    errorCode: 'TOO_MANY_REDIRECTS',
    message: `Exceeded ${MAX_REDIRECTS} redirect hops.`,
  };
}

async function readBounded(
  response: Response,
  limit: number,
): Promise<{ bytes: number; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const lengthHeader = response.headers.get('content-length');
    const declared = lengthHeader === null ? 0 : Number(lengthHeader);
    return { bytes: Number.isFinite(declared) ? declared : 0, truncated: false };
  }
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        return { bytes, truncated: true };
      }
    }
  } catch {
    return { bytes, truncated: true };
  }
  return { bytes, truncated: false };
}

function redactResponseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = defaultRedactor.redactHeaderValue(name, value) ?? value;
  });
  return headers;
}
