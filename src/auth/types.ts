/**
 * Authentication contracts for MCP Portico.
 *
 * Two authentication layers exist and must never be confused:
 *
 * 1. Portico identity - proves which tenant/principal an MCP client belongs to.
 * 2. Upstream authentication - proves MCP Portico to a backend connection.
 *
 * These interfaces are the Phase 1 seam. OAuth 2.1 can replace the static
 * bearer implementation later without changing MCP tool handlers.
 */

export interface PorticoPrincipal {
  /** Stable principal identifier, e.g. automation-1. */
  id: string;
  /** Tenant that owns this principal. */
  tenantId: string;
  /** Connection IDs the principal may select. */
  allowedConnectionIds: string[];
}

export interface PorticoAuthResult {
  principal: PorticoPrincipal;
  /** Metadata recorded for audit, never the credential. */
  authMethod: string;
}

export interface IdentityProvider {
  /** Validate a client credential and resolve the authorized principal. */
  authenticate(credential: string): Promise<PorticoAuthResult | undefined>;
  /** Startup-time configuration validation; throws on invalid config. */
  validate(): Promise<void>;
}

/** Secret reference shape, e.g. env:BILLING_PROD_TOKEN. */
export type SecretReference = string;

export interface SecretResolver {
  resolve(reference: SecretReference): Promise<string | undefined>;
}

export interface UpstreamRequest {
  url: URL;
  headers: Map<string, string>;
  /** Query parameters to inject when the auth scheme requires them. */
  query: Map<string, string>;
  /**
   * Names of query parameters whose values are secrets (for example an
   * `apiKey` credential injected `in: query`). Any URL rendered from the
   * request must redact these values before it can be observed.
   */
  secretQueryParams?: Set<string>;
}

export interface UpstreamConnectionAuth {
  type: string;
  /** Canonical config, validated at load time. */
  config: Record<string, unknown>;
}

export interface UpstreamAuthProvider {
  type: string;
  validate(auth: UpstreamConnectionAuth): Promise<void>;
  /** Apply credentials to an upstream request before dispatch. */
  apply(
    request: UpstreamRequest,
    auth: UpstreamConnectionAuth,
    secrets: SecretResolver,
  ): Promise<void>;
}
