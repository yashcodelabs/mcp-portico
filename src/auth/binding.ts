import { PorticoError } from '../shared/errors';

/** Supported Portico client authentication modes. */
export const AUTH_MODES = ['none', 'bearer'] as const;

export type AuthMode = (typeof AUTH_MODES)[number];

export const DEFAULT_AUTH_MODE: AuthMode = 'none';

export function parseAuthMode(value: string | undefined): AuthMode {
  const mode = value ?? DEFAULT_AUTH_MODE;
  if (!AUTH_MODES.includes(mode as AuthMode)) {
    throw new PorticoError(
      'CONFIG_ERROR',
      `Unsupported auth mode "${mode}". Supported modes: ${AUTH_MODES.join(', ')}.`,
      { details: { authMode: mode } },
    );
  }
  return mode as AuthMode;
}

/** True for localhost and any IPv4 loopback address or IPv6 ::1. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (normalized === 'localhost') return true;
  if (normalized === '::1' || normalized === '::ffff:127.0.0.1') return true;
  if (!normalized.startsWith('127.')) return false;
  const octets = normalized.split('.');
  if (octets.length !== 4) return false;
  return octets.every(
    (part) => part !== '' && /^\d{1,3}$/.test(part) && Number(part) <= 255,
  );
}

export interface BindingPolicy {
  host: string;
  authMode: AuthMode;
}

/**
 * Serve-time auth policy: the loopback binding rules plus whether a
 * tenant-aware registry runtime is configured.
 */
export interface ServeAuthPolicy extends BindingPolicy {
  /**
   * True when a registry is loaded, which enables tenant-aware MCP tools,
   * resources, and the inspector.
   */
  registryConfigured: boolean;
}

/**
 * Unauthenticated mode may only bind to a loopback interface. Remote binding
 * requires a real identity provider (Phase 3).
 */
export function assertLoopbackBindingAllowed(policy: BindingPolicy): void {
  if (policy.authMode === 'none' && !isLoopbackHost(policy.host)) {
    throw new PorticoError(
      'CONFIG_ERROR',
      `Unauthenticated mode (MCP_PORTICO_AUTH_MODE=none) may only bind to a loopback interface; refusing to bind to "${policy.host}".`,
      { details: { host: policy.host } },
    );
  }
}

/**
 * Startup validation for a serve process.
 *
 * Unauthenticated mode is preserved only for health-only loopback serving
 * without a registry. Tenant-aware MCP tools require an authenticated
 * principal, and `none` has no identity provider, so combining it with a
 * registry would produce a runtime that no MCP client or inspector can
 * authenticate against. The safe local-development contract for tenant-aware
 * serving is an explicitly configured synthetic local-development principal
 * (not yet supported); until one exists, startup fails instead of silently
 * serving an unauthenticatable registry.
 */
export function assertServeAuthAllowed(policy: ServeAuthPolicy): void {
  assertLoopbackBindingAllowed(policy);
  if (policy.authMode === 'none' && policy.registryConfigured) {
    throw new PorticoError(
      'CONFIG_ERROR',
      'Unauthenticated mode (MCP_PORTICO_AUTH_MODE=none) cannot serve a tenant-aware registry: no synthetic local-development principal is configured. Start with --auth-mode bearer and a keyed principal, or omit --registry for health-only loopback serving.',
      { details: { host: policy.host } },
    );
  }
}
