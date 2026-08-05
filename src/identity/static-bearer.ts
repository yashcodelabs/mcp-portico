import type {
  IdentityProvider,
  PorticoAuthResult,
  PorticoPrincipal,
} from '../auth/types';
import type { RegistrySnapshot } from '../registry/snapshot';
import type { PrincipalRecord } from '../registry/types';
import { PorticoError } from '../shared/errors';
import {
  computeKeyDigest,
  constantTimeEqual,
  isValidDigest,
  KEY_ID_PATTERN,
  parsePorticoKey,
} from './keys';

/**
 * Static bearer API-key identity provider.
 *
 * Credentials are `mpp_<keyId>_<secret>` tokens. The registry stores only
 * keyId and an HMAC digest keyed by MCP_PORTICO_KEY_PEPPER; verification
 * recomputes the digest and compares in constant time.
 */
export class StaticBearerIdentityProvider implements IdentityProvider {
  constructor(
    private readonly snapshot: RegistrySnapshot,
    private readonly pepper: string,
  ) {}

  async validate(): Promise<void> {
    if (this.pepper === '') {
      throw new PorticoError(
        'CONFIG_ERROR',
        'MCP_PORTICO_KEY_PEPPER must be set when bearer auth mode is enabled.',
      );
    }
    const principals = this.snapshot.document.principals;
    if (principals.length === 0) {
      throw new PorticoError(
        'CONFIG_ERROR',
        'Bearer auth mode requires at least one principal with a Portico API key; the registry defines none.',
      );
    }
    const owners = new Map<string, string>();
    for (const principal of principals) {
      if (principal.keyId === undefined || principal.keyDigest === undefined) {
        throw new PorticoError(
          'CONFIG_ERROR',
          `Principal "${principal.id}" has no Portico API key; run "mcp-portico key create --tenant ${principal.tenantId} --principal ${principal.id}".`,
        );
      }
      if (!KEY_ID_PATTERN.test(principal.keyId)) {
        throw new PorticoError(
          'CONFIG_ERROR',
          `Principal "${principal.id}" has an invalid keyId "${principal.keyId}".`,
        );
      }
      if (!isValidDigest(principal.keyDigest)) {
        throw new PorticoError(
          'CONFIG_ERROR',
          `Principal "${principal.id}" has an invalid keyDigest.`,
        );
      }
      const existing = owners.get(principal.keyId);
      if (existing !== undefined) {
        throw new PorticoError(
          'CONFIG_ERROR',
          `Key id "${principal.keyId}" is shared by principals "${existing}" and "${principal.id}".`,
        );
      }
      owners.set(principal.keyId, principal.id);
    }
  }

  async authenticate(credential: string): Promise<PorticoAuthResult | undefined> {
    const parsed = parsePorticoKey(credential);
    if (parsed === undefined) return undefined;
    const principal = this.snapshot.document.principals.find(
      (candidate) => candidate.keyId === parsed.keyId,
    );
    if (principal === undefined || principal.keyDigest === undefined) {
      return undefined;
    }
    const expected = computeKeyDigest(parsed.secret, this.pepper);
    if (!constantTimeEqual(expected, principal.keyDigest)) return undefined;
    return {
      principal: toPorticoPrincipal(principal, this.snapshot),
      authMethod: 'static-bearer',
    };
  }
}

/** Defensive filter: only still-authorized, same-tenant connections survive. */
function toPorticoPrincipal(
  record: PrincipalRecord,
  snapshot: RegistrySnapshot,
): PorticoPrincipal {
  return {
    id: record.id,
    tenantId: record.tenantId,
    allowedConnectionIds: record.allowedConnectionIds.filter(
      (connectionId) =>
        snapshot.authorizeConnection(record, connectionId) !== undefined,
    ),
  };
}
