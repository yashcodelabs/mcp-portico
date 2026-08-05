/**
 * Per-connection circuit breakers.
 *
 * Failure state is keyed by tenant and connection so one tenant's upstream
 * failures cannot trip another tenant's circuit. After the reset timeout
 * elapses, an open circuit becomes half-open and may close again on the
 * next success.
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. Defaults to 5. */
  failureThreshold?: number;
  /** Milliseconds before an open circuit becomes half-open. Defaults to 30s. */
  resetTimeoutMs?: number;
  clock?: () => number;
}

interface CircuitStateEntry {
  state: 'closed' | 'open';
  failures: number;
  openedAt: number;
}

export class CircuitBreakerStore {
  private readonly entries = new Map<string, CircuitStateEntry>();
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly clock: () => number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.clock = options.clock ?? Date.now;
  }

  /** Current state for a tenant:connection scope. */
  state(scope: string, now: number = this.clock()): CircuitState {
    const entry = this.entries.get(scope);
    if (entry === undefined || entry.state === 'closed') return 'closed';
    if (now - entry.openedAt >= this.resetTimeoutMs) return 'half-open';
    return 'open';
  }

  onSuccess(scope: string): void {
    this.entries.set(scope, { state: 'closed', failures: 0, openedAt: 0 });
  }

  onFailure(scope: string, now: number = this.clock()): CircuitState {
    const current = this.entries.get(scope);
    const failures = (current?.failures ?? 0) + 1;
    if (failures >= this.failureThreshold) {
      this.entries.set(scope, { state: 'open', failures, openedAt: now });
      return 'open';
    }
    this.entries.set(scope, { state: 'closed', failures, openedAt: 0 });
    return 'closed';
  }

  reset(): void {
    this.entries.clear();
  }
}
