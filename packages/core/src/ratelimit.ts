/**
 * Rate-limit accounting (ARCHITECTURE.md §7).
 *
 * Heroku exposes the remaining budget for the current hour via the
 * `RateLimit-Remaining` response header. The bucket refills continuously and
 * resets on the hour boundary; there is no single "reset at" value.
 *
 * Strategy:
 *   - Observe the header on every response we see.
 *   - Below a low-budget threshold (default 100), serialize outgoing requests
 *     so we don't burn the remaining budget in a parallel burst.
 *   - At budget=0, callers can read `exhausted` and short-circuit with a
 *     {@link RateLimitError} rather than blasting retries.
 *
 * The tracker is a small primitive: it doesn't issue requests itself. Callers
 * wrap their request in `acquire()` / release.
 */

export interface RateLimitState {
  /** Last observed `RateLimit-Remaining` value, or undefined if never seen. */
  readonly remaining: number | undefined;
  /** Wall-clock ms when `remaining` was observed (from `now()`). */
  readonly observedAt: number;
  /** True iff `remaining` is below the configured threshold. New requests
   *  will be queued one-at-a-time while this holds. */
  readonly serialMode: boolean;
  /** True iff `remaining` is exactly zero. */
  readonly exhausted: boolean;
}

export interface RateLimitTrackerOptions {
  /** Switch to serial mode once `remaining` drops below this value. ARCHITECTURE.md §7 specifies 100. */
  serialThreshold?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** Released by the caller when its request is done. Safe to call more than once. */
export type RateLimitRelease = () => void;

/**
 * Tracks Heroku's per-hour rate budget and serializes outgoing requests when
 * the budget is low. See module docstring for context.
 */
export class RateLimitTracker {
  private readonly threshold: number;
  private readonly clock: () => number;
  private remainingValue: number | undefined;
  private observedAtMs = 0;
  private serialBusy = false;
  private readonly serialQueue: (() => void)[] = [];

  constructor(opts: RateLimitTrackerOptions = {}) {
    this.threshold = opts.serialThreshold ?? 100;
    this.clock = opts.now ?? Date.now;
  }

  /** Acquire a slot. Returns a release function. In serial mode, callers are
   *  queued and woken in FIFO order. In normal mode, returns immediately. */
  async acquire(): Promise<RateLimitRelease> {
    if (!this.isSerialMode()) return noop;

    if (this.serialBusy) {
      await new Promise<void>((resolve) => this.serialQueue.push(resolve));
    }
    this.serialBusy = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.serialBusy = false;
      const next = this.serialQueue.shift();
      if (next) next();
    };
  }

  /**
   * Update state from a `RateLimit-Remaining` header value. Accepts a number,
   * a numeric string, or null/undefined (treated as no-op). Non-numeric strings
   * are ignored — defensive against odd middleboxes.
   */
  observe(remaining: number | string | null | undefined): void {
    if (remaining == null) return;
    const n = typeof remaining === 'string' ? Number.parseInt(remaining, 10) : remaining;
    if (!Number.isFinite(n) || n < 0) return;
    this.remainingValue = n;
    this.observedAtMs = this.clock();
  }

  /** Snapshot the current state. */
  getState(): RateLimitState {
    return {
      remaining: this.remainingValue,
      observedAt: this.observedAtMs,
      serialMode: this.isSerialMode(),
      exhausted: this.remainingValue === 0,
    };
  }

  /** Forget what we've seen; useful for tests and `refresh_capabilities`. */
  reset(): void {
    this.remainingValue = undefined;
    this.observedAtMs = 0;
  }

  private isSerialMode(): boolean {
    return this.remainingValue !== undefined && this.remainingValue < this.threshold;
  }
}

const noop: RateLimitRelease = () => undefined;
