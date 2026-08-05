import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { PorticoError } from '../shared/errors';

/**
 * Static bearer API keys for Portico identity.
 *
 * A key is `mpp_<keyId>_<secret>`. The registry stores only the public key
 * ID and an HMAC-SHA256 digest keyed by MCP_PORTICO_KEY_PEPPER. Verification
 * recomputes the digest and compares it in constant time.
 */

export const KEY_PREFIX = 'mpp_';
export const KEY_ID_PATTERN = /^[a-f0-9]{16}$/;
export const KEY_TOKEN_PATTERN = /^mpp_([a-f0-9]{16})_([A-Za-z0-9_-]{16,64})$/;
export const DIGEST_PREFIX = 'hmac256:';

export interface ParsedPorticoKey {
  keyId: string;
  secret: string;
}

export interface GeneratedPorticoKey extends ParsedPorticoKey {
  token: string;
  digest: string;
}

export function generatePorticoKey(pepper: string): GeneratedPorticoKey {
  if (pepper === '') {
    throw new PorticoError(
      'CONFIG_ERROR',
      'A non-empty MCP_PORTICO_KEY_PEPPER is required to create Portico API keys.',
    );
  }
  const keyId = randomBytes(8).toString('hex');
  const secret = randomBytes(24).toString('base64url');
  const token = `${KEY_PREFIX}${keyId}_${secret}`;
  return {
    keyId,
    secret,
    token,
    digest: computeKeyDigest(secret, pepper),
  };
}

export function computeKeyDigest(secret: string, pepper: string): string {
  const hmac = createHmac('sha256', pepper).update(secret).digest('hex');
  return `${DIGEST_PREFIX}${hmac}`;
}

export function parsePorticoKey(token: string): ParsedPorticoKey | undefined {
  if (typeof token !== 'string') return undefined;
  const match = KEY_TOKEN_PATTERN.exec(token);
  if (match === null) return undefined;
  return { keyId: match[1] as string, secret: match[2] as string };
}

export function isValidDigest(digest: string): boolean {
  return /^hmac256:[a-f0-9]{64}$/.test(digest);
}

/** Constant-time comparison of two ASCII digests; never leaks length differences. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
