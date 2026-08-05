import { PorticoError } from '../shared/errors';
import type { SecretResolver } from './types';
import type { Connection, ConnectionAuthConfig } from '../registry/types';

/**
 * Environment-variable secret references.
 *
 * v1 resolves only `env:VARIABLE_NAME` references. Secrets never appear in
 * MCP responses, inspector payloads, telemetry, errors, or logs; unknown
 * references fail startup or connection activation.
 */

const ENV_REF_PATTERN = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;

export function isSecretReference(value: string): boolean {
  return ENV_REF_PATTERN.test(value);
}

export function secretReferenceName(value: string): string | undefined {
  const match = ENV_REF_PATTERN.exec(value);
  return match?.[1];
}

export class EnvSecretResolver implements SecretResolver {
  resolve(reference: string): Promise<string | undefined> {
    const name = secretReferenceName(reference);
    if (name === undefined) return Promise.resolve(undefined);
    const value = process.env[name];
    return Promise.resolve(value === undefined ? undefined : value);
  }
}

export const defaultSecretResolver = new EnvSecretResolver();

/** Collect every `env:` reference used by a connection's auth and static headers. */
export function collectConnectionSecretRefs(connection: Connection): string[] {
  const refs = new Set<string>();
  const auth = connection.auth;
  switch (auth.type) {
    case 'bearer':
      refs.add(auth.tokenRef);
      break;
    case 'apiKey':
      refs.add(auth.valueRef);
      break;
    case 'basic':
      refs.add(auth.usernameRef);
      refs.add(auth.passwordRef);
      break;
    case 'staticHeaders':
      for (const value of Object.values(auth.headers)) {
        if (isSecretReference(value)) refs.add(value);
      }
      break;
    case 'none':
      break;
  }
  for (const value of Object.values(connection.staticHeaders ?? {})) {
    if (isSecretReference(value)) refs.add(value);
  }
  return [...refs];
}

/**
 * Fail startup or connection activation when any referenced secret cannot be
 * resolved. Missing secrets must never silently degrade to unauthenticated
 * upstream calls.
 */
export async function assertSecretsResolvable(
  refs: string[],
  resolver: SecretResolver,
): Promise<void> {
  const missing: string[] = [];
  for (const ref of refs) {
    const value = await resolver.resolve(ref);
    if (value === undefined) missing.push(ref);
  }
  if (missing.length > 0) {
    throw new PorticoError(
      'CONFIG_ERROR',
      `Connection references unresolved secrets: ${missing.join(', ')}.`,
      { details: { missing } },
    );
  }
}

/** Resolve a reference, returning undefined for non-reference literals. */
export async function resolveSecretOrLiteral(
  value: string,
  resolver: SecretResolver,
): Promise<string | undefined> {
  if (!isSecretReference(value)) return value;
  return resolver.resolve(value);
}
