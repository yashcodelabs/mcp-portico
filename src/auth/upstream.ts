import { PorticoError } from '../shared/errors';
import { isProtectedUpstreamHeaderName } from '../security/headers';
import { isSecretReference, resolveSecretOrLiteral } from './secrets';
import type {
  SecretResolver,
  UpstreamAuthProvider,
  UpstreamConnectionAuth,
  UpstreamRequest,
} from './types';
import type { ConnectionAuthConfig, UpstreamAuthType } from '../registry/types';

/**
 * Built-in v1 upstream authentication providers.
 *
 * Providers validate their canonical configuration at load time and inject
 * credentials at request time through the SecretResolver. Credentials are
 * never logged, echoed, or stored; unresolved references simply skip
 * injection (startup validation already refused unknown references).
 */

const noneProvider: UpstreamAuthProvider = {
  type: 'none',
  async validate() {
    // No configuration.
  },
  async apply() {
    // No credentials.
  },
};

const bearerProvider: UpstreamAuthProvider = {
  type: 'bearer',
  async validate(auth) {
    requireRef(auth, 'tokenRef');
  },
  async apply(request, auth, secrets) {
    const token = await secrets.resolve(auth.config.tokenRef as string);
    if (token !== undefined) request.headers.set('authorization', `Bearer ${token}`);
  },
};

const apiKeyProvider: UpstreamAuthProvider = {
  type: 'apiKey',
  async validate(auth) {
    requireRef(auth, 'valueRef');
    const location = auth.config.in;
    if (location !== 'header' && location !== 'query') {
      throw new PorticoError(
        'CONFIG_ERROR',
        `apiKey auth "in" must be "header" or "query", got "${String(location)}".`,
      );
    }
    if (typeof auth.config.name !== 'string' || auth.config.name === '') {
      throw new PorticoError(
        'CONFIG_ERROR',
        'apiKey auth requires a non-empty "name".',
      );
    }
    if (location === 'header') {
      assertInjectionHeaderAllowed(auth.config.name, 'apiKey auth');
    }
  },
  async apply(request, auth, secrets) {
    const value = await secrets.resolve(auth.config.valueRef as string);
    if (value === undefined) return;
    const name = auth.config.name as string;
    if (auth.config.in === 'query') {
      request.query.set(name, value);
      request.secretQueryParams ??= new Set();
      request.secretQueryParams.add(name);
    } else {
      setInjectedHeader(request, name, value, 'apiKey auth');
    }
  },
};

const basicProvider: UpstreamAuthProvider = {
  type: 'basic',
  async validate(auth) {
    requireRef(auth, 'usernameRef');
    requireRef(auth, 'passwordRef');
  },
  async apply(request, auth, secrets) {
    const username = await secrets.resolve(auth.config.usernameRef as string);
    const password = await secrets.resolve(auth.config.passwordRef as string);
    if (username === undefined || password === undefined) return;
    const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
    request.headers.set('authorization', `Basic ${encoded}`);
  },
};

const staticHeadersProvider: UpstreamAuthProvider = {
  type: 'staticHeaders',
  async validate(auth) {
    const headers = auth.config.headers;
    if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
      throw new PorticoError(
        'CONFIG_ERROR',
        'staticHeaders auth requires a "headers" object.',
      );
    }
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      if (name === '' || typeof value !== 'string' || value === '') {
        throw new PorticoError(
          'CONFIG_ERROR',
          `staticHeaders entry "${name}" must map to a non-empty string.`,
        );
      }
      assertInjectionHeaderAllowed(name, 'staticHeaders auth');
    }
  },
  async apply(request, auth, secrets) {
    for (const [name, value] of Object.entries(
      (auth.config.headers as Record<string, string>) ?? {},
    )) {
      const resolved = await resolveSecretOrLiteral(value, secrets);
      if (resolved !== undefined) {
        setInjectedHeader(request, name, resolved, 'staticHeaders auth');
      }
    }
  },
};

/**
 * Refuse to inject a reserved header (host, hop-by-hop, framing, Portico
 * client identity). The bearer/basic providers own `authorization`; every
 * other provider must never set it or any other protected header.
 */
function assertInjectionHeaderAllowed(name: string, owner: string): void {
  if (isProtectedUpstreamHeaderName(name)) {
    throw new PorticoError(
      'CONFIG_ERROR',
      `${owner} refused to inject protected header "${name}".`,
    );
  }
}

function setInjectedHeader(
  request: UpstreamRequest,
  name: string,
  value: string,
  owner: string,
): void {
  assertInjectionHeaderAllowed(name, owner);
  request.headers.set(name.toLowerCase(), value);
}

function requireRef(auth: UpstreamConnectionAuth, field: string): void {
  const value = auth.config[field];
  if (typeof value !== 'string' || !isSecretReference(value)) {
    throw new PorticoError(
      'CONFIG_ERROR',
      `${auth.type} auth requires "${field}" to be an env: secret reference, got "${String(value)}".`,
    );
  }
}

export const UPSTREAM_AUTH_PROVIDERS: UpstreamAuthProvider[] = [
  noneProvider,
  bearerProvider,
  apiKeyProvider,
  basicProvider,
  staticHeadersProvider,
];

export class UpstreamAuthRegistry {
  private readonly providers = new Map<string, UpstreamAuthProvider>();

  constructor(providers: UpstreamAuthProvider[] = UPSTREAM_AUTH_PROVIDERS) {
    for (const provider of providers) {
      this.providers.set(provider.type, provider);
    }
  }

  get(type: UpstreamAuthType): UpstreamAuthProvider {
    const provider = this.providers.get(type);
    if (provider === undefined) {
      throw new PorticoError(
        'CONFIG_ERROR',
        `Unsupported upstream auth type "${type}".`,
      );
    }
    return provider;
  }

  toConnectionAuth(config: ConnectionAuthConfig): UpstreamConnectionAuth {
    const { type, ...rest } = config;
    return { type, config: { ...rest } };
  }
}

export const defaultUpstreamAuthRegistry = new UpstreamAuthRegistry();
