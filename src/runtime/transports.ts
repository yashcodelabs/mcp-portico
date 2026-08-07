import { randomBytes } from 'node:crypto';

import type { NetworkPolicy } from '../registry/types';
import {
  assertDestinationAllowed,
  assertDestinationDnsAllowed,
} from '../security/network';
import { isRedirectStatus, resolveRedirectTarget } from '../security/redirects';
import { PorticoError } from '../shared/errors';

/**
 * Upstream request rendering and dispatch (Phase 5).
 *
 * Renders catalog paths/query strings/request bodies into wire form and
 * dispatches them under the connection's network policy: destination
 * validation (literal + DNS) before every hop, policy-controlled redirects,
 * per-request timeouts, and bounded response reads.
 */

export type RequestBodyKind = 'json' | 'form' | 'multipart' | 'binary' | 'text';

export interface EncodedRequestBody {
  body?: Buffer | string;
  contentType?: string;
}

export interface DispatchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string | null;
}

export interface DispatchOptions {
  timeoutMs: number;
  maxResponseBytes: number;
  network: NetworkPolicy;
}

export interface DispatchResult {
  status: number;
  /** Raw response headers keyed by lowercase name. */
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
  finalUrl: string;
}

export interface MultipartPart {
  base64: string;
  filename?: string;
  contentType?: string;
}

const MAX_REDIRECTS = 5;

/** Replace `{name}` placeholders with percent-encoded path values. */
export function renderPath(
  pathTemplate: string,
  pathValues: Record<string, string>,
): string {
  return pathTemplate.replace(/\{([^{}]+)\}/g, (_match: string, name: string) =>
    encodeURIComponent(pathValues[name] ?? ''),
  );
}

/** Render query values into a `application/x-www-form-urlencoded` query string. */
export function buildQuery(queryValues: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(queryValues)) {
    params.append(name, value);
  }
  return params.toString();
}

function encodeFormBody(body: unknown): string {
  if (typeof body === 'string') return body;
  const params = new URLSearchParams();
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    for (const [name, value] of Object.entries(body as Record<string, unknown>)) {
      if (value === undefined || value === null) continue;
      params.append(
        name,
        typeof value === 'object' ? JSON.stringify(value) : String(value),
      );
    }
  }
  return params.toString();
}

function isMultipartPart(value: unknown): value is MultipartPart {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { base64?: unknown }).base64 === 'string'
  );
}

function escapeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, '').replace(/"/g, '\\"');
}

function encodeMultipartBody(body: unknown): EncodedRequestBody {
  const boundary = `----portico-${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  const pushText = (text: string): void => {
    chunks.push(Buffer.from(text, 'utf8'));
  };
  const fields =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? Object.entries(body as Record<string, unknown>)
      : [];
  for (const [name, value] of fields) {
    if (value === undefined || value === null) continue;
    pushText(`--${boundary}\r\n`);
    if (isMultipartPart(value)) {
      const filename =
        value.filename === undefined
          ? ''
          : `; filename="${escapeHeaderValue(value.filename)}"`;
      pushText(
        `Content-Disposition: form-data; name="${escapeHeaderValue(name)}"${filename}\r\n`,
      );
      if (value.contentType !== undefined) {
        pushText(`Content-Type: ${value.contentType}\r\n`);
      }
      pushText('\r\n');
      chunks.push(Buffer.from(value.base64, 'base64'));
      pushText('\r\n');
    } else {
      pushText(`Content-Disposition: form-data; name="${escapeHeaderValue(name)}"\r\n`);
      pushText('\r\n');
      pushText(typeof value === 'object' ? JSON.stringify(value) : String(value));
      pushText('\r\n');
    }
  }
  pushText(`--${boundary}--\r\n`);
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * Encode a request body for its catalog body kind. Multipart parts support
 * plain string values and binary values shaped as
 * `{base64, filename?, contentType?}`.
 */
export function encodeRequestBody(
  kind: RequestBodyKind,
  body: unknown,
): EncodedRequestBody {
  switch (kind) {
    case 'json':
      return { body: JSON.stringify(body), contentType: 'application/json' };
    case 'form':
      return {
        body: encodeFormBody(body),
        contentType: 'application/x-www-form-urlencoded',
      };
    case 'multipart':
      return encodeMultipartBody(body);
    case 'binary':
      return {
        body: Buffer.from(String(body), 'base64'),
        contentType: 'application/octet-stream',
      };
    case 'text':
      return { body: String(body), contentType: 'text/plain' };
  }
}

function mapFetchError(error: unknown): never {
  const isTimeout =
    error instanceof DOMException
      ? error.name === 'TimeoutError'
      : error instanceof Error && error.name === 'TimeoutError';
  if (isTimeout) {
    throw new PorticoError('API_ERROR', 'Upstream request timed out.', {
      details: { errorCode: 'UPSTREAM_TIMEOUT' },
      cause: error,
    });
  }
  throw new PorticoError('API_ERROR', 'Upstream request failed.', {
    details: { errorCode: 'UPSTREAM_ERROR' },
    cause: error,
  });
}

async function readBodyBounded(
  response: Response,
  limit: number,
): Promise<{ buffer: Buffer; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) return { buffer: Buffer.alloc(0), truncated: false };
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const remaining = limit - total;
      if (remaining <= 0) {
        await reader.cancel().catch(() => undefined);
        return { buffer: Buffer.concat(chunks), truncated: true };
      }
      if (value.byteLength > remaining) {
        chunks.push(Buffer.from(value.subarray(0, remaining)));
        await reader.cancel().catch(() => undefined);
        return { buffer: Buffer.concat(chunks), truncated: true };
      }
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } catch (error) {
    throw new PorticoError('API_ERROR', 'Failed to read upstream response body.', {
      details: { errorCode: 'UPSTREAM_ERROR' },
      cause: error,
    });
  }
  return { buffer: Buffer.concat(chunks), truncated: false };
}

/**
 * Dispatch an upstream request under the connection's network policy.
 * Destination policy is enforced (literal + DNS) before every hop; redirects
 * are followed only when the policy allows them, up to five hops. Timeout
 * and transport failures surface as API_ERROR with a machine-readable
 * `details.errorCode` (`UPSTREAM_ERROR` | `UPSTREAM_TIMEOUT` |
 * `DESTINATION_DENIED`).
 */
export async function dispatchUpstream(
  url: URL,
  init: DispatchInit,
  options: DispatchOptions,
): Promise<DispatchResult> {
  const redirects = options.network.redirects ?? 'none';
  let currentUrl = url;
  let method = init.method ?? 'GET';
  let body: Buffer | string | null = init.body ?? null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    try {
      assertDestinationAllowed(currentUrl, options.network, { context: 'request' });
      await assertDestinationDnsAllowed(currentUrl, options.network, {
        context: 'request',
      });
    } catch (error) {
      if (error instanceof PorticoError) {
        throw new PorticoError('API_ERROR', error.message, {
          details: { errorCode: 'DESTINATION_DENIED' },
          cause: error,
        });
      }
      throw error;
    }

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        method,
        headers: init.headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      mapFetchError(error);
    }

    if (isRedirectStatus(response.status)) {
      const target = resolveRedirectTarget(
        response.url,
        response.headers.get('location'),
        redirects,
      );
      if (target !== undefined) {
        currentUrl = target;
        if (response.status === 303) {
          method = 'GET';
          body = null;
        }
        continue;
      }
    }

    const { buffer, truncated } = await readBodyBounded(
      response,
      options.maxResponseBytes,
    );
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });
    return {
      status: response.status,
      headers,
      body: buffer,
      truncated,
      finalUrl: currentUrl.toString(),
    };
  }

  throw new PorticoError('API_ERROR', `Exceeded ${MAX_REDIRECTS} redirect hops.`, {
    details: { errorCode: 'UPSTREAM_ERROR' },
  });
}
