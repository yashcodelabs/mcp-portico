/**
 * Registry domain types for MCP Portico.
 *
 * The registry is the version-controlled security model: tenants own
 * principals and connections, backends are scoped global or tenant-owned,
 * and connections pin catalog checksums. v1 persists YAML/JSON files; the
 * storage interface keeps a database-backed implementation reachable later.
 */

import type { ConfirmationPolicy, RedactionRule } from '../catalog/types';

export interface Tenant {
  id: string;
  name: string;
}

export interface PrincipalRecord {
  id: string;
  tenantId: string;
  allowedConnectionIds: string[];
  /** Public key identifier for the Portico API key (set by `key create`). */
  keyId?: string;
  /** Keyed HMAC digest of the Portico API key. Never the plaintext key. */
  keyDigest?: string;
}

export type BackendScope = 'global' | 'tenant';

export interface Backend {
  id: string;
  title: string;
  /**
   * `global` backends have no owner and may be referenced by connections
   * from any tenant. `tenant` backends require an existing ownerTenantId and
   * may only be referenced by connections owned by that tenant.
   */
  scope: BackendScope;
  ownerTenantId?: string;
  catalogRef: string;
  /** Must match the referenced catalog's own checksum field. */
  catalogChecksum: string;
}

export type UpstreamAuthType = 'none' | 'bearer' | 'apiKey' | 'basic' | 'staticHeaders';

export type ConnectionAuthConfig =
  | { type: 'none' }
  | { type: 'bearer'; tokenRef: string }
  | { type: 'apiKey'; in: 'header' | 'query'; name: string; valueRef: string }
  | { type: 'basic'; usernameRef: string; passwordRef: string }
  | { type: 'staticHeaders'; headers: Record<string, string> };

/**
 * Monotonic connection policy. It may only further restrict a catalog:
 * disable operations, reduce limits, require stricter confirmation, or add
 * redaction. It can never enable or add operations, widen schemas, remove
 * security requirements, or relax catalog limits.
 */
export interface ConnectionPolicy {
  disabledOperations?: string[];
  confirmation?: ConfirmationPolicy;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxConcurrency?: number;
  rateLimitPerMinute?: number;
  allowedContentTypes?: string[];
  redactions?: RedactionRule[];
}

export interface NetworkPolicy {
  /** Allowed URL protocols for upstream calls. Defaults to https only. */
  allowedProtocols?: Array<'http' | 'https'>;
  /** Permit loopback targets (dev only). Defaults to false. */
  allowLoopback?: boolean;
  /** Permit link-local targets. Defaults to false. Metadata endpoints are always denied. */
  allowLinkLocal?: boolean;
  /** Permit RFC1918/unique-local targets. Defaults to false. */
  allowPrivateNetwork?: boolean;
  /** Redirect handling. Defaults to `none`; `same-origin` permits same-origin redirects. */
  redirects?: 'none' | 'same-origin';
}

export interface Connection {
  id: string;
  tenantId: string;
  backendId: string;
  baseUrl: string;
  auth: ConnectionAuthConfig;
  /** Upstream headers injected per connection. Values may be `env:` secret references. */
  staticHeaders?: Record<string, string>;
  policy?: ConnectionPolicy;
  network?: NetworkPolicy;
}

export interface RegistryDocument {
  version: 1;
  tenants: Tenant[];
  principals: PrincipalRecord[];
  backends: Backend[];
  connections: Connection[];
}

export interface RegistryStore {
  load(): Promise<RegistryDocument>;
}

export const REGISTRY_VERSION = 1 as const;
