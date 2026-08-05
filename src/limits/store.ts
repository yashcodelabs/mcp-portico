/**
 * In-memory rate and concurrency limits, namespaced by the isolation
 * dimensions they depend on. Every key includes tenant and connection;
 * rate keys include the principal so no principal can share another's
 * allowance through a connection.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

const WINDOW_MS = 60_000;

export class LimitsStore {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  private readonly concurrency = new Map<string, number>();

  /** Fixed one-minute window rate check for a scoped key. */
  rateLimit(key: string, perMinute: number, now: number = Date.now()): RateLimitResult {
    const entry = this.windows.get(key);
    if (entry === undefined || now - entry.startedAt >= WINDOW_MS) {
      this.windows.set(key, { startedAt: now, count: 1 });
      return { allowed: true, remaining: Math.max(0, perMinute - 1), retryAfterMs: 0 };
    }
    if (entry.count >= perMinute) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: WINDOW_MS - (now - entry.startedAt),
      };
    }
    entry.count += 1;
    return {
      allowed: true,
      remaining: Math.max(0, perMinute - entry.count),
      retryAfterMs: 0,
    };
  }

  acquireConcurrency(key: string, limit: number): boolean {
    const current = this.concurrency.get(key) ?? 0;
    if (current >= limit) return false;
    this.concurrency.set(key, current + 1);
    return true;
  }

  releaseConcurrency(key: string): void {
    const current = this.concurrency.get(key) ?? 0;
    if (current <= 1) {
      this.concurrency.delete(key);
    } else {
      this.concurrency.set(key, current - 1);
    }
  }

  concurrencyFor(key: string): number {
    return this.concurrency.get(key) ?? 0;
  }

  reset(): void {
    this.windows.clear();
    this.concurrency.clear();
  }
}

/** Build an isolation-scoped key for rate/concurrency hooks. */
export function scopeKey(...parts: Array<string | number>): string {
  return parts.join(':');
}
