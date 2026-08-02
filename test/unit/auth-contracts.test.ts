import { describe, expect, it } from 'vitest';

import type {
  IdentityProvider,
  PorticoAuthResult,
  SecretResolver,
  UpstreamAuthProvider,
  UpstreamConnectionAuth,
  UpstreamRequest,
} from '../../src/auth/types';

const fakeResolver: SecretResolver = {
  async resolve(reference) {
    return reference === 'env:BILLING_TOKEN' ? 'top-secret-token' : undefined;
  },
};

const fakeIdentity: IdentityProvider = {
  async authenticate(credential) {
    if (credential !== 'mpp_test_secret') return undefined;
    const result: PorticoAuthResult = {
      principal: {
        id: 'automation-1',
        tenantId: 'acme',
        allowedConnectionIds: ['billing-prod'],
      },
      authMethod: 'static-bearer',
    };
    return result;
  },
  async validate() {
    // Configuration is valid.
  },
};

const fakeUpstreamAuth: UpstreamAuthProvider = {
  type: 'bearer',
  async validate() {
    // Configuration is valid.
  },
  async apply(request, auth, secrets) {
    const token = await secrets.resolve(auth.config.tokenRef as string);
    if (token !== undefined) request.headers.set('authorization', `Bearer ${token}`);
  },
};

describe('authentication interface contracts', () => {
  it('IdentityProvider resolves an authorized principal for valid credentials only', async () => {
    await expect(fakeIdentity.validate()).resolves.toBeUndefined();
    const ok = await fakeIdentity.authenticate('mpp_test_secret');
    expect(ok?.principal).toEqual({
      id: 'automation-1',
      tenantId: 'acme',
      allowedConnectionIds: ['billing-prod'],
    });
    expect(ok?.authMethod).toBe('static-bearer');
    await expect(fakeIdentity.authenticate('wrong')).resolves.toBeUndefined();
  });

  it('UpstreamAuthProvider injects credentials through the SecretResolver', async () => {
    const request: UpstreamRequest = {
      url: new URL('https://billing.example.com/invoices/1'),
      headers: new Map(),
      query: new Map(),
    };
    const auth: UpstreamConnectionAuth = {
      type: 'bearer',
      config: { tokenRef: 'env:BILLING_TOKEN' },
    };
    await fakeUpstreamAuth.validate(auth);
    await fakeUpstreamAuth.apply(request, auth, fakeResolver);
    expect(request.headers.get('authorization')).toBe('Bearer top-secret-token');
  });

  it('does not inject credentials for unresolved secret references', async () => {
    const request: UpstreamRequest = {
      url: new URL('https://billing.example.com/invoices/1'),
      headers: new Map(),
      query: new Map(),
    };
    const auth: UpstreamConnectionAuth = {
      type: 'bearer',
      config: { tokenRef: 'env:MISSING_TOKEN' },
    };
    await fakeUpstreamAuth.apply(request, auth, fakeResolver);
    expect(request.headers.has('authorization')).toBe(false);
  });
});
