import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimitTracker } from '../src/ratelimit.js';

describe('RateLimitTracker.observe', () => {
  it('starts with undefined remaining', () => {
    const t = new RateLimitTracker();
    expect(t.getState().remaining).toBeUndefined();
    expect(t.getState().serialMode).toBe(false);
    expect(t.getState().exhausted).toBe(false);
  });

  it('parses a numeric string', () => {
    const t = new RateLimitTracker();
    t.observe('250');
    expect(t.getState().remaining).toBe(250);
  });

  it('accepts a number', () => {
    const t = new RateLimitTracker();
    t.observe(150);
    expect(t.getState().remaining).toBe(150);
  });

  it('ignores null and undefined', () => {
    const t = new RateLimitTracker();
    t.observe(null);
    t.observe(undefined);
    expect(t.getState().remaining).toBeUndefined();
  });

  it('ignores non-numeric strings', () => {
    const t = new RateLimitTracker();
    t.observe(100);
    t.observe('not a number');
    expect(t.getState().remaining).toBe(100);
  });

  it('ignores negative values', () => {
    const t = new RateLimitTracker();
    t.observe(50);
    t.observe(-1);
    expect(t.getState().remaining).toBe(50);
  });

  it('records observedAt from the injected clock', () => {
    let nowMs = 1000;
    const t = new RateLimitTracker({ now: () => nowMs });
    t.observe(10);
    expect(t.getState().observedAt).toBe(1000);
    nowMs = 2000;
    t.observe(5);
    expect(t.getState().observedAt).toBe(2000);
  });
});

describe('RateLimitTracker — serial mode threshold', () => {
  it('flips to serial mode when remaining drops below threshold', () => {
    const t = new RateLimitTracker({ serialThreshold: 100 });
    t.observe(200);
    expect(t.getState().serialMode).toBe(false);
    t.observe(99);
    expect(t.getState().serialMode).toBe(true);
  });

  it('threshold is exclusive — equal to threshold is still parallel', () => {
    const t = new RateLimitTracker({ serialThreshold: 100 });
    t.observe(100);
    expect(t.getState().serialMode).toBe(false);
  });

  it('exhausted is true only at zero', () => {
    const t = new RateLimitTracker();
    t.observe(1);
    expect(t.getState().exhausted).toBe(false);
    t.observe(0);
    expect(t.getState().exhausted).toBe(true);
  });

  it('respects a custom threshold', () => {
    const t = new RateLimitTracker({ serialThreshold: 10 });
    t.observe(50);
    expect(t.getState().serialMode).toBe(false);
    t.observe(9);
    expect(t.getState().serialMode).toBe(true);
  });
});

describe('RateLimitTracker.acquire — parallel mode', () => {
  it('returns immediately when in parallel mode', async () => {
    const t = new RateLimitTracker();
    t.observe(4000);
    const release1 = await t.acquire();
    const release2 = await t.acquire();
    const release3 = await t.acquire();
    expect(typeof release1).toBe('function');
    release1();
    release2();
    release3();
  });

  it('returns immediately when remaining was never observed', async () => {
    const t = new RateLimitTracker();
    const release = await t.acquire();
    expect(typeof release).toBe('function');
    release();
  });
});

describe('RateLimitTracker.acquire — serial mode ordering', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serializes concurrent acquires in FIFO order', async () => {
    const t = new RateLimitTracker({ serialThreshold: 100 });
    t.observe(50);

    const order: number[] = [];
    const inFlight: number[] = [];

    const task = async (id: number) => {
      const release = await t.acquire();
      inFlight.push(id);
      order.push(id);
      // While we hold the slot, no other task may enter.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      const idx = inFlight.indexOf(id);
      inFlight.splice(idx, 1);
      release();
    };

    const p1 = task(1);
    const p2 = task(2);
    const p3 = task(3);

    // Drive each step.
    await vi.advanceTimersByTimeAsync(0);
    expect(inFlight).toEqual([1]);
    await vi.advanceTimersByTimeAsync(10);
    expect(inFlight).toEqual([2]);
    await vi.advanceTimersByTimeAsync(10);
    expect(inFlight).toEqual([3]);
    await vi.advanceTimersByTimeAsync(10);

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('release is idempotent', async () => {
    const t = new RateLimitTracker({ serialThreshold: 100 });
    t.observe(50);

    const release = await t.acquire();
    release();
    release(); // no-op
    // After release, a fresh acquire should succeed immediately.
    const next = await t.acquire();
    expect(typeof next).toBe('function');
    next();
  });

  it('serializes correctly when serial mode is entered after some acquires', async () => {
    const t = new RateLimitTracker({ serialThreshold: 100 });
    t.observe(500); // parallel
    const r1 = await t.acquire();
    // r1 holds nothing meaningful in parallel mode. Now go serial:
    t.observe(50);
    // r2 and r3 should now serialize.
    const events: string[] = [];
    const tA = (async () => {
      const r = await t.acquire();
      events.push('A-start');
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      events.push('A-end');
      r();
    })();
    const tB = (async () => {
      const r = await t.acquire();
      events.push('B-start');
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      events.push('B-end');
      r();
    })();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(['A-start']);
    await vi.advanceTimersByTimeAsync(5);
    expect(events).toEqual(['A-start', 'A-end', 'B-start']);
    await vi.advanceTimersByTimeAsync(5);
    await Promise.all([tA, tB]);
    expect(events).toEqual(['A-start', 'A-end', 'B-start', 'B-end']);
    r1();
  });
});

describe('RateLimitTracker.reset', () => {
  it('clears observed state', () => {
    const t = new RateLimitTracker();
    t.observe(10);
    t.reset();
    expect(t.getState().remaining).toBeUndefined();
    expect(t.getState().serialMode).toBe(false);
    expect(t.getState().exhausted).toBe(false);
  });
});
