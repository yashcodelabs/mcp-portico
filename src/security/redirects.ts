/**
 * Redirect policy for upstream calls.
 *
 * Redirects are disabled by default. `same-origin` allows only redirects
 * that stay on the connection's origin; the caller must re-run destination
 * validation on every hop.
 */

export type RedirectPolicy = 'none' | 'same-origin';

export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

/**
 * Resolve the redirect target for a response, or return undefined when the
 * configured policy forbids following it.
 */
export function resolveRedirectTarget(
  responseUrl: string,
  location: string | null,
  policy: RedirectPolicy,
): URL | undefined {
  if (policy === 'none' || location === null || location === '') return undefined;
  let target: URL;
  try {
    target = new URL(location, responseUrl);
  } catch {
    return undefined;
  }
  if (policy === 'same-origin') {
    const origin = new URL(responseUrl).origin;
    if (target.origin !== origin) return undefined;
  }
  return target;
}
