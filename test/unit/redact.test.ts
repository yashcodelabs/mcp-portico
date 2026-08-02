import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultRedactor, Redactor } from '../../src/shared/redact';

const FIXTURE = JSON.parse(
  readFileSync(
    path.join(__dirname, '..', 'fixtures', 'redaction', 'sample-response.json'),
    'utf8',
  ),
) as Record<string, unknown>;

describe('redaction', () => {
  it('redacts authorization, cookie, and API key headers', () => {
    const headers = {
      Authorization: 'Bearer supersecret',
      Cookie: 'session=abc123',
      'Set-Cookie': 'sid=xyz',
      'X-Api-Key': 'key-12345',
      'X-Request-Id': 'req-1',
    };
    const redacted = defaultRedactor.redactHeaders(headers);
    expect(redacted).toEqual({
      Authorization: '<redacted>',
      Cookie: '<redacted>',
      'Set-Cookie': '<redacted>',
      'X-Api-Key': '<redacted>',
      'X-Request-Id': 'req-1',
    });
  });

  it('redacts nested sensitive fields regardless of casing', () => {
    const redacted = defaultRedactor.redact({
      accessToken: 'abc',
      AccessToken: 'def',
      password: 'hunter2',
      clientSecret: 's3cret',
      apiKey: 'key',
      ok: true,
      count: 3,
    });
    expect(redacted).toEqual({
      accessToken: '<redacted>',
      AccessToken: '<redacted>',
      password: '<redacted>',
      clientSecret: '<redacted>',
      apiKey: '<redacted>',
      ok: true,
      count: 3,
    });
  });

  it('redacts headers nested under a headers field', () => {
    const redacted = defaultRedactor.redact({
      headers: { authorization: 'Bearer abc', 'x-request-id': 'req-2' },
    });
    expect(redacted).toEqual({
      headers: { authorization: '<redacted>', 'x-request-id': 'req-2' },
    });
  });

  it('redacts arrays and preserves non-string values', () => {
    const redacted = defaultRedactor.redact({
      items: [{ token: 't1' }, { token: 't2', keep: 1 }],
      nullValue: null,
      nested: { list: ['a'], token: 'root-token' },
    });
    expect(redacted).toEqual({
      items: [{ token: '<redacted>' }, { token: '<redacted>', keep: 1 }],
      nullValue: null,
      nested: { list: ['a'], token: '<redacted>' },
    });
  });

  it('supports configured sensitive fields, allowlists, and placeholders', () => {
    const redactor = new Redactor({
      sensitiveFields: ['clientId', 'token'],
      placeholder: '***',
      allowlist: new Set(['public-client']),
    });
    expect(
      redactor.redact({
        clientId: 'public-client',
        otherField: 'secret-client',
        token: 'abc',
      }),
    ).toEqual({
      clientId: 'public-client',
      otherField: 'secret-client',
      token: '***',
    });
  });

  it('redacts the sample response fixture without losing safe data', () => {
    const redacted = defaultRedactor.redact(FIXTURE) as Record<string, unknown>;
    expect(redacted.id).toBe(42);
    expect(redacted.name).toBe('Acme Billing');
    expect(redacted.ok).toBe(true);
    expect(redacted.accessToken).toBe('<redacted>');
    expect((redacted.headers as Record<string, string>).authorization).toBe(
      '<redacted>',
    );
    expect((redacted.headers as Record<string, string>)['x-api-key']).toBe(
      '<redacted>',
    );
    expect((redacted.headers as Record<string, string>)['x-request-id']).toBe('req-1');
    const profile = redacted.profile as Record<string, string>;
    expect(profile.password).toBe('<redacted>');
    expect(profile.token).toBe('<redacted>');
    expect(profile.nickname).toBe('acme-bot');
  });
});
