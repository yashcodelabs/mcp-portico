/**
 * Registry domain types for MCP Portico.
 *
 * These types are the Phase 1 contract for Phase 3 (tenant registry,
 * connections, and authentication). v1 persists YAML/JSON files; the storage
 * interface keeps a database-backed implementation reachable later.
 */

export interface Tenant {
  id: string;
  name: string;
}

export interface PrincipalRecord {
  id: string;
  tenantId: string;
  allowedConnectionIds: string[];
  /** Public key identifier for the Portico API key. */
  keyId: string;
  /** Keyed HMAC digest of the Portico API key. Never the plaintext key. */
  keyDigest: string;
}

export interface Backend {
  id: string;
  title: string;
  catalogRef: string;
}

export interface ConnectionAuthConfig {
  type: 'none' | 'bearer' | 'apiKey' | 'basic' | 'staticHeaders';
  [key: string]: unknown;
}

export interface Connection {
  id: string;
  tenantId: string;
  backendId: string;
  baseUrl: string;
  auth: ConnectionAuthConfig;
  /** Upstream headers injected per connection. */
  staticHeaders?: Record<string, string>;
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
