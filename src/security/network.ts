import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';

import { PorticoError } from '../shared/errors';
import type { NetworkPolicy } from '../registry/types';

/**
 * Destination security policy for upstream calls.
 *
 * MCP Portico is an operator-controlled relay, not an open HTTP proxy:
 * every upstream destination is validated against the connection's network
 * policy at load time (literal checks) and at request time (including DNS
 * resolution) so a hostname cannot be rebound to a private address after
 * validation.
 */

export type AddressClass =
  | 'unspecified'
  | 'loopback'
  | 'metadata'
  | 'linkLocal'
  | 'private'
  | 'public'
  | 'unknown';

export type DestinationContext = 'load' | 'request';

export interface DestinationCheckOptions {
  context?: DestinationContext;
}

export function defaultNetworkPolicy(): NetworkPolicy {
  return {
    allowedProtocols: ['https'],
    allowLoopback: false,
    allowLinkLocal: false,
    allowPrivateNetwork: false,
    redirects: 'none',
  };
}

/** Well-known cloud metadata endpoints are always denied, even if link-local is permitted. */
const METADATA_HOSTS = new Set(['metadata', 'metadata.google.internal']);
const PRIVATE_HOSTNAME_SUFFIXES = ['.local', '.internal'];

export function isIpAddress(host: string): boolean {
  return net.isIP(stripHost(host)) !== 0;
}

export function classifyIpAddress(input: string): AddressClass {
  const ip = stripHost(input).toLowerCase();
  const version = net.isIP(ip);
  if (version === 4) return classifyIpv4(ip);
  if (version === 6) return classifyIpv6(ip);
  return 'unknown';
}

function stripHost(host: string): string {
  const withoutBrackets = host.replace(/^\[|\]$/g, '');
  return stripZone(withoutBrackets);
}

function stripZone(host: string): string {
  const percent = host.indexOf('%');
  return percent === -1 ? host : host.slice(0, percent);
}

function classifyIpv4(ip: string): AddressClass {
  const octets = ip.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => Number.isNaN(part))) {
    return 'unknown';
  }
  const value =
    ((octets[0] ?? 0) << 24) |
    ((octets[1] ?? 0) << 16) |
    ((octets[2] ?? 0) << 8) |
    (octets[3] ?? 0);
  if (value === 0) return 'unspecified';
  if (value >>> 24 === 127) return 'loopback';
  if (value >>> 0 === 0xa9fea9fe) return 'metadata'; // 169.254.169.254
  if (value >>> 16 === 0xa9fe) return 'linkLocal'; // 169.254.0.0/16
  if (value >>> 24 === 10) return 'private';
  if (value >>> 20 === 0xac1) return 'private'; // 172.16.0.0/12
  if (value >>> 16 === 0xc0a8) return 'private'; // 192.168.0.0/16
  if (value >>> 22 === 0x191) return 'private'; // 100.64.0.0/10 CGNAT
  if (value >>> 28 === 0xe) return 'private'; // 224.0.0.0/4 multicast
  if (value >>> 24 >= 240) return 'private'; // 240.0.0.0/4 reserved
  return 'public';
}

function classifyIpv6(ip: string): AddressClass {
  if (ip === '::') return 'unspecified';
  if (ip === '::1') return 'loopback';
  const v4Mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ip);
  if (v4Mapped !== null) {
    return classifyIpv4(v4Mapped[1] as string);
  }
  if (ip === 'fd00:ec2::254') return 'metadata';
  const firstHextet = parseInt(ip.split(':')[0] ?? '0', 16);
  if ((firstHextet & 0xffc0) === 0xfe80) return 'linkLocal'; // fe80::/10
  if ((firstHextet & 0xfe00) === 0xfc00) return 'private'; // fc00::/7
  return 'public';
}

function addressClassAllowed(
  addressClass: AddressClass,
  policy: NetworkPolicy,
): boolean {
  switch (addressClass) {
    case 'public':
      return true;
    case 'loopback':
      return policy.allowLoopback === true;
    case 'linkLocal':
      return policy.allowLinkLocal === true;
    case 'private':
      return policy.allowPrivateNetwork === true;
    case 'metadata':
    case 'unspecified':
    case 'unknown':
      return false;
  }
}

function deny(code: 'CONFIG_ERROR' | 'API_ERROR', message: string): never {
  throw new PorticoError(code, message);
}

/**
 * Validate that an upstream URL is reachable under the connection's network
 * policy using literal checks: protocol, user-info, literal IP
 * classification, and reserved hostname conventions. Callers that are about
 * to make a request must additionally run `assertDestinationDnsAllowed` so
 * hostnames are resolved and every address satisfies the policy.
 */
export function assertDestinationAllowed(
  url: URL,
  policy: NetworkPolicy,
  options: DestinationCheckOptions = {},
): void {
  const code = options.context === 'request' ? 'API_ERROR' : 'CONFIG_ERROR';
  const phase = options.context === 'request' ? 'request' : 'load';

  const protocols = policy.allowedProtocols ?? ['https'];
  const scheme = url.protocol.replace(/:$/, '');
  if (!protocols.includes(scheme as 'http' | 'https')) {
    deny(
      code,
      `Destination ${url.host} uses ${scheme.toUpperCase()}, which is not allowed by the network policy (allowed: ${protocols.join(', ')}).`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    deny(code, `Destination ${url.host} must not contain user-info credentials.`);
  }

  const host = url.hostname;
  if (isIpAddress(host)) {
    const addressClass = classifyIpAddress(host);
    if (!addressClassAllowed(addressClass, policy)) {
      deny(
        code,
        `Destination ${url.host} resolves to a ${addressClass} address that the connection network policy does not permit at ${phase} time.`,
      );
    }
    return;
  }

  const normalizedHost = host.toLowerCase();
  if (METADATA_HOSTS.has(normalizedHost)) {
    deny(code, `Destination ${url.host} is a metadata endpoint and is always denied.`);
  }
  if (normalizedHost === 'localhost') {
    if (policy.allowLoopback !== true) {
      deny(
        code,
        `Destination ${url.host} is a loopback host that the connection network policy does not permit at ${phase} time.`,
      );
    }
    return;
  }
  if (PRIVATE_HOSTNAME_SUFFIXES.some((suffix) => normalizedHost.endsWith(suffix))) {
    if (policy.allowPrivateNetwork !== true) {
      deny(
        code,
        `Destination ${url.host} looks like a private-network hostname that the connection network policy does not permit at ${phase} time.`,
      );
    }
    return;
  }
}

/** Parse and validate a connection base URL against the network policy. */
export function assertConnectionBaseUrlAllowed(
  baseUrl: string,
  policy: NetworkPolicy,
  options: DestinationCheckOptions = {},
): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    deny('CONFIG_ERROR', `Connection base URL is not a valid URL: "${baseUrl}".`);
  }
  assertDestinationAllowed(url, policy, { ...options, context: 'load' });
  return url;
}

/**
 * Resolve a hostname and verify every address satisfies the network policy.
 * Fails closed on resolution errors so a DNS rebind cannot redirect a
 * request to a private network after the literal load-time check passed.
 */
export async function assertDestinationDnsAllowed(
  url: URL,
  policy: NetworkPolicy,
  options: DestinationCheckOptions = {},
): Promise<void> {
  const host = url.hostname;
  if (isIpAddress(host)) return;
  const normalized = host.toLowerCase();
  if (
    normalized === 'localhost' ||
    METADATA_HOSTS.has(normalized) ||
    PRIVATE_HOSTNAME_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  ) {
    return;
  }
  const code = options.context === 'request' ? 'API_ERROR' : 'CONFIG_ERROR';
  const phase = options.context === 'request' ? 'request' : 'load';

  let addresses: string[];
  try {
    const result = await dnsLookup(normalized, { all: true, verbatim: true });
    addresses = result.map((entry) => entry.address);
  } catch {
    deny(
      code,
      `Destination ${url.host} could not be resolved at ${phase} time; refusing to proceed.`,
    );
  }
  const denied = addresses
    .map((address) => classifyIpAddress(address))
    .filter((addressClass) => !addressClassAllowed(addressClass, policy));
  if (denied.length > 0) {
    deny(
      code,
      `Destination ${url.host} resolves to an address class (${[...new Set(denied)].join(', ')}) that the connection network policy does not permit at ${phase} time.`,
    );
  }
}
