import { describe, expect, it } from 'vitest';

import {
  EXIT_CODES,
  formatCliError,
  isPorticoError,
  PorticoError,
  serializeError,
  toExitCode,
} from '../../src/shared/errors';

describe('structured errors', () => {
  it('carries a code, message, and details', () => {
    const error = new PorticoError('CONFIG_ERROR', 'bad config', {
      details: { host: '0.0.0.0' },
    });
    expect(error.code).toBe('CONFIG_ERROR');
    expect(error.message).toBe('bad config');
    expect(error.details).toEqual({ host: '0.0.0.0' });
    expect(isPorticoError(error)).toBe(true);
  });

  it('maps codes to stable exit codes', () => {
    expect(toExitCode(new PorticoError('USAGE', 'x'))).toBe(EXIT_CODES.USAGE);
    expect(toExitCode(new PorticoError('AUTH', 'x'))).toBe(EXIT_CODES.AUTH);
    expect(toExitCode(new PorticoError('NOT_FOUND', 'x'))).toBe(EXIT_CODES.NOT_FOUND);
    expect(toExitCode(new PorticoError('API_ERROR', 'x'))).toBe(EXIT_CODES.API_ERROR);
    expect(toExitCode(new PorticoError('CONFIG_ERROR', 'x'))).toBe(
      EXIT_CODES.CONFIG_ERROR,
    );
    expect(toExitCode(new PorticoError('INTERNAL', 'x'))).toBe(EXIT_CODES.INTERNAL);
    expect(toExitCode(new Error('boom'))).toBe(EXIT_CODES.INTERNAL);
  });

  it('redacts secret-shaped details during serialization', () => {
    const error = new PorticoError('API_ERROR', 'upstream failed', {
      details: {
        token: 'sk-live-abcdef1234567890',
        headers: { authorization: 'Bearer secret' },
        safe: 'visible',
      },
    });
    const serialized = serializeError(error);
    expect(serialized.code).toBe('API_ERROR');
    expect(serialized.details).toEqual({
      token: '<redacted>',
      headers: { authorization: '<redacted>' },
      safe: 'visible',
    });
  });

  it('formats CLI errors with code and redacted details', () => {
    const error = new PorticoError('CONFIG_ERROR', 'refusing to bind', {
      details: { host: '0.0.0.0', token: 'sk-live-abcdef1234567890' },
    });
    expect(formatCliError(error)).toContain('error: CONFIG_ERROR: refusing to bind');
    expect(formatCliError(error)).toContain('"host":"0.0.0.0"');
    expect(formatCliError(error)).not.toContain('sk-live-abcdef1234567890');
  });
});
