import { describe, expect, it } from 'vitest';

import {
  assertLoopbackBindingAllowed,
  DEFAULT_AUTH_MODE,
  isLoopbackHost,
  parseAuthMode,
} from '../../src/auth/binding';
import { PorticoError } from '../../src/shared/errors';

describe('loopback-only binding validation', () => {
  it('recognizes loopback hosts', () => {
    for (const host of ['localhost', '127.0.0.1', '127.8.8.8', '::1', '[::1]']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it('rejects non-loopback hosts', () => {
    for (const host of [
      '0.0.0.0',
      '::',
      '192.168.1.1',
      '10.0.0.1',
      'example.com',
      '',
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it('allows loopback binding in unauthenticated mode', () => {
    expect(() =>
      assertLoopbackBindingAllowed({ host: '127.0.0.1', authMode: 'none' }),
    ).not.toThrow();
    expect(() =>
      assertLoopbackBindingAllowed({ host: 'localhost', authMode: 'none' }),
    ).not.toThrow();
  });

  it('rejects remote binding in unauthenticated mode with CONFIG_ERROR', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.1', 'example.com']) {
      let thrown: unknown;
      try {
        assertLoopbackBindingAllowed({ host, authMode: 'none' });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, host).toBeInstanceOf(PorticoError);
      expect((thrown as PorticoError).code, host).toBe('CONFIG_ERROR');
    }
  });

  it('allows remote binding when an identity mode is configured', () => {
    expect(() =>
      assertLoopbackBindingAllowed({ host: '0.0.0.0', authMode: 'bearer' }),
    ).not.toThrow();
  });

  it('parses auth modes and rejects unknown ones', () => {
    expect(parseAuthMode(undefined)).toBe(DEFAULT_AUTH_MODE);
    expect(parseAuthMode('none')).toBe('none');
    expect(parseAuthMode('bearer')).toBe('bearer');
    expect(() => parseAuthMode('oauth')).toThrow(PorticoError);
  });
});
