import { describe, expect, it } from 'vitest';

import {
  assertConnectionBaseUrlAllowed,
  assertDestinationAllowed,
  assertDestinationDnsAllowed,
  classifyIpAddress,
  defaultNetworkPolicy,
} from '../../src/security/network';
import { PorticoError } from '../../src/shared/errors';

function expectDenied(url: string, policy = defaultNetworkPolicy()): void {
  expect(() => assertDestinationAllowed(new URL(url), policy)).toThrow(PorticoError);
}

function expectAllowed(url: string, policy = defaultNetworkPolicy()): void {
  expect(() => assertDestinationAllowed(new URL(url), policy)).not.toThrow();
}

describe('IP address classification', () => {
  it('classifies loopback, private, link-local, metadata, and public addresses', () => {
    expect(classifyIpAddress('127.0.0.1')).toBe('loopback');
    expect(classifyIpAddress('::1')).toBe('loopback');
    expect(classifyIpAddress('10.1.2.3')).toBe('private');
    expect(classifyIpAddress('172.16.0.1')).toBe('private');
    expect(classifyIpAddress('192.168.1.1')).toBe('private');
    expect(classifyIpAddress('100.64.0.1')).toBe('private');
    expect(classifyIpAddress('169.254.10.10')).toBe('linkLocal');
    expect(classifyIpAddress('169.254.169.254')).toBe('metadata');
    expect(classifyIpAddress('fe80::1')).toBe('linkLocal');
    expect(classifyIpAddress('fd00::1')).toBe('private');
    expect(classifyIpAddress('::ffff:10.0.0.1')).toBe('private');
    expect(classifyIpAddress('8.8.8.8')).toBe('public');
    expect(classifyIpAddress('0.0.0.0')).toBe('unspecified');
  });
});

describe('destination network policy', () => {
  it('defaults to https only', () => {
    expectDenied('http://example.com');
    expectAllowed('https://example.com');
  });

  it('rejects loopback, link-local, private, and metadata by default', () => {
    expectDenied('https://127.0.0.1');
    expectDenied('https://localhost');
    expectDenied('https://169.254.169.254');
    expectDenied('https://169.254.10.10');
    expectDenied('https://10.0.0.5');
    expectDenied('https://192.168.1.1');
    expectDenied('https://[::1]');
  });

  it('permits loopback and private networks when explicitly allowed', () => {
    const permissive = {
      ...defaultNetworkPolicy(),
      allowedProtocols: ['http', 'https'] as const,
      allowLoopback: true,
      allowPrivateNetwork: true,
    };
    expectAllowed('http://127.0.0.1:3000', permissive);
    expectAllowed('http://10.0.0.5', permissive);
    expectAllowed('http://192.168.1.1', permissive);
  });

  it('always denies metadata endpoints even when link-local is allowed', () => {
    const policy = {
      ...defaultNetworkPolicy(),
      allowedProtocols: ['https'] as const,
      allowLinkLocal: true,
    };
    expectDenied('https://169.254.169.254', policy);
    expectDenied('https://metadata.google.internal', policy);
  });

  it('rejects user-info credentials in the URL', () => {
    expectDenied('https://user:pass@example.com');
  });

  it('treats .local and .internal hostnames as private', () => {
    expectDenied('https://ledger.internal');
    expectDenied('https://printer.local');
    const policy = { ...defaultNetworkPolicy(), allowPrivateNetwork: true };
    expectAllowed('https://ledger.internal', policy);
  });

  it('validates base URLs with the connection policy', () => {
    expect(() =>
      assertConnectionBaseUrlAllowed('https://example.com', defaultNetworkPolicy()),
    ).not.toThrow();
    expect(() =>
      assertConnectionBaseUrlAllowed('not a url', defaultNetworkPolicy()),
    ).toThrow(PorticoError);
  });

  it('fails closed when a hostname cannot be resolved at request time', async () => {
    await expect(
      assertDestinationDnsAllowed(
        new URL('https://does-not-exist.invalid'),
        defaultNetworkPolicy(),
        { context: 'request' },
      ),
    ).rejects.toThrow(PorticoError);
  });

  it('skips DNS for literal IPs and reserved hostnames', async () => {
    await expect(
      assertDestinationDnsAllowed(new URL('https://127.0.0.1'), {
        ...defaultNetworkPolicy(),
        allowLoopback: true,
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertDestinationDnsAllowed(
        new URL('https://metadata.google.internal'),
        defaultNetworkPolicy(),
      ),
    ).resolves.toBeUndefined();
  });
});
