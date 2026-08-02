import { defaultRedactor, type Redactor } from './redact';

export const EXIT_CODES = {
  OK: 0,
  USAGE: 2,
  AUTH: 3,
  NOT_FOUND: 4,
  API_ERROR: 5,
  CONFIG_ERROR: 6,
  INTERNAL: 7,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export type PorticoErrorCode =
  'USAGE' | 'AUTH' | 'NOT_FOUND' | 'API_ERROR' | 'CONFIG_ERROR' | 'INTERNAL';

const CODE_TO_EXIT: Record<PorticoErrorCode, ExitCode> = {
  USAGE: EXIT_CODES.USAGE,
  AUTH: EXIT_CODES.AUTH,
  NOT_FOUND: EXIT_CODES.NOT_FOUND,
  API_ERROR: EXIT_CODES.API_ERROR,
  CONFIG_ERROR: EXIT_CODES.CONFIG_ERROR,
  INTERNAL: EXIT_CODES.INTERNAL,
};

export interface PorticoErrorOptions {
  details?: unknown;
  cause?: unknown;
}

export class PorticoError extends Error {
  readonly code: PorticoErrorCode;
  readonly details: unknown;

  constructor(
    code: PorticoErrorCode,
    message: string,
    options: PorticoErrorOptions = {},
  ) {
    super(message);
    this.name = 'PorticoError';
    this.code = code;
    this.details = options.details;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  toJSON(): { error: { code: PorticoErrorCode; message: string } } {
    return { error: { code: this.code, message: this.message } };
  }
}

export function isPorticoError(error: unknown): error is PorticoError {
  return error instanceof PorticoError;
}

export function toExitCode(error: unknown): ExitCode {
  if (isPorticoError(error)) return CODE_TO_EXIT[error.code];
  return EXIT_CODES.INTERNAL;
}

export interface SerializedError {
  code: PorticoErrorCode;
  message: string;
  details?: unknown;
}

/** Serialize an error for CLI or HTTP output, redacting any embedded secrets. */
export function serializeError(
  error: unknown,
  redactor: Redactor = defaultRedactor,
): SerializedError {
  if (isPorticoError(error)) {
    const details =
      error.details === undefined ? undefined : redactor.redact(error.details);
    return {
      code: error.code,
      message: error.message,
      ...(details !== undefined ? { details } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'INTERNAL', message: redactor.redact(message) as string };
}

export function formatCliError(error: unknown): string {
  const serialized = serializeError(error);
  const details =
    serialized.details === undefined ? '' : ` ${JSON.stringify(serialized.details)}`;
  return `error: ${serialized.code}: ${serialized.message}${details}`;
}
