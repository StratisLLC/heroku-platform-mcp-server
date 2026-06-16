/**
 * Pure predicates over a {@link CapabilityResult} (ARCHITECTURE.md §5.3).
 *
 * These read the probe matrix and answer yes/no questions every package needs
 * when deciding which tools to advertise. They do no I/O — the on-disk
 * capability cache (`loadOrProbe` and friends) lives in `@heroku-mcp/platform`,
 * which is server-bootstrap concern rather than tool-building concern.
 */

import type { CapabilityResult } from './prober.js';

/** True iff `result.probedAt + ttlSeconds*1000` is still in the future. */
export function isFresh(result: CapabilityResult, nowMs: number): boolean {
  const probedAt = Date.parse(result.probedAt);
  if (!Number.isFinite(probedAt)) return false;
  return probedAt + result.ttlSeconds * 1000 > nowMs;
}

/**
 * Convenience: did the probe matrix produce a tier we can build tools on top
 * of? `data.*` sub-tiers live under a nested object, so we handle them
 * specially.
 */
export function tierAvailable(result: CapabilityResult, tier: string): boolean {
  if (result.aborted) {
    // Only the account tier (and only in diagnostic mode) is usable when
    // probes aborted.
    if (tier !== 'account') return false;
  }
  if (tier.startsWith('data.')) {
    const sub = tier.slice('data.'.length);
    const dataGroup = result.tiers.data as Record<string, { available?: boolean }> | undefined;
    return Boolean(dataGroup?.[sub]?.available);
  }
  const t = result.tiers[tier] as { available?: boolean } | undefined;
  return Boolean(t?.available);
}

/** True iff the account tier is in diagnostic-only mode (delinquent or
 *  suspended). When set, the server should advertise diagnostic tools only. */
export function isDiagnosticOnly(result: CapabilityResult): boolean {
  const account = result.tiers.account as { diagnosticOnly?: boolean } | undefined;
  return Boolean(account?.diagnosticOnly);
}
