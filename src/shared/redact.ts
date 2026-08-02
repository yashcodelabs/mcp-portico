/**
 * Centralized secret redaction for MCP Portico.
 *
 * Every runtime output - MCP responses, inspector payloads, logs, errors, and
 * telemetry - must be redacted before it can be observed.
 */

const DEFAULT_SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
]);

const DEFAULT_SENSITIVE_FIELDS = [
  'token',
  'accessToken',
  'password',
  'secret',
  'apiKey',
  'clientSecret',
];

const DEFAULT_REDACTED = '<redacted>';

export type RedactOptions = {
  sensitiveHeaders?: Iterable<string>;
  sensitiveFields?: Iterable<string>;
  placeholder?: string;
  /** Explicitly allow these full values even if they look like secrets. */
  allowlist?: Set<string>;
};

export class Redactor {
  private readonly sensitiveHeaders: Set<string>;
  private readonly sensitiveFields: Set<string>;
  private readonly placeholder: string;
  private readonly allowlist: Set<string>;

  constructor(options: RedactOptions = {}) {
    this.sensitiveHeaders = new Set(
      [...(options.sensitiveHeaders ?? DEFAULT_SENSITIVE_HEADERS)].map((name) =>
        name.toLowerCase(),
      ),
    );
    this.sensitiveFields = new Set(
      [...(options.sensitiveFields ?? DEFAULT_SENSITIVE_FIELDS)].map((name) =>
        name.toLowerCase(),
      ),
    );
    this.placeholder = options.placeholder ?? DEFAULT_REDACTED;
    this.allowlist = options.allowlist ?? new Set();
  }

  isSensitiveHeader(name: string): boolean {
    return this.sensitiveHeaders.has(name.toLowerCase());
  }

  redactHeaderValue(name: string, value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (this.isSensitiveHeader(name)) return this.placeholder;
    return value;
  }

  /** Deep-redact objects, replacing sensitive field values in place on a clone. */
  redact<T>(value: T, path = ''): T {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      return value.map((item) => this.redact(item, path)) as unknown as T;
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const nextPath = path ? `${path}.${key}` : key;
      const fieldName = key.toLowerCase();
      if (this.sensitiveFields.has(fieldName) && typeof entry === 'string') {
        out[key] = this.allowlist.has(entry) ? entry : this.placeholder;
        continue;
      }
      if (fieldName === 'headers' && entry && typeof entry === 'object') {
        out[key] = this.redactHeaders(entry as Record<string, unknown>);
        continue;
      }
      out[key] = this.redact(entry, nextPath);
    }
    return out as T;
  }

  /** Redact a header map by header name (case-insensitive). */
  redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(headers)) {
      out[name] =
        typeof value === 'string' ? this.redactHeaderValue(name, value) : value;
    }
    return out;
  }
}

export const defaultRedactor = new Redactor();
