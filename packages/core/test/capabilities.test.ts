import { describe, expect, it } from 'vitest';
import { isDiagnosticOnly, isFresh, tierAvailable } from '../src/capabilities.js';
import type { CapabilityResult } from '../src/prober.js';

const FROZEN_NOW = Date.parse('2026-05-26T12:00:00.000Z');

function makeResult(overrides: Partial<CapabilityResult> = {}): CapabilityResult {
  return {
    schemaVersion: 1,
    tokenFingerprint: 'abc',
    probedAt: new Date(FROZEN_NOW).toISOString(),
    ttlSeconds: 3600,
    tiers: {
      account: { available: true },
      apps: { available: true },
    },
    ...overrides,
  };
}

describe('isFresh', () => {
  it('is true when probedAt + ttl > now', () => {
    expect(isFresh(makeResult(), FROZEN_NOW + 60_000)).toBe(true);
  });
  it('is false past the TTL window', () => {
    expect(isFresh(makeResult({ ttlSeconds: 60 }), FROZEN_NOW + 120_000)).toBe(false);
  });
  it('is false when probedAt is unparseable', () => {
    expect(isFresh(makeResult({ probedAt: 'not-a-date' }), FROZEN_NOW)).toBe(false);
  });
});

describe('tierAvailable', () => {
  it('returns true for an available tier', () => {
    expect(tierAvailable(makeResult(), 'apps')).toBe(true);
  });
  it('returns false for a missing tier', () => {
    expect(tierAvailable(makeResult(), 'teams')).toBe(false);
  });
  it('reads nested data sub-tiers', () => {
    const result = makeResult({
      tiers: { data: { postgres: { available: true }, redis: { available: false } } },
    });
    expect(tierAvailable(result, 'data.postgres')).toBe(true);
    expect(tierAvailable(result, 'data.redis')).toBe(false);
  });
  it('hides all tiers when probes aborted (account is the only exception)', () => {
    const result = makeResult({ aborted: true });
    expect(tierAvailable(result, 'apps')).toBe(false);
    expect(tierAvailable(result, 'account')).toBe(true);
  });
});

describe('isDiagnosticOnly', () => {
  it('reads the account tier diagnosticOnly flag', () => {
    expect(
      isDiagnosticOnly(
        makeResult({ tiers: { account: { available: true, diagnosticOnly: true } } }),
      ),
    ).toBe(true);
    expect(isDiagnosticOnly(makeResult())).toBe(false);
  });
});
