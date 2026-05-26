/**
 * On-disk capability cache (ARCHITECTURE.md §5.3, CAPABILITY_PROBES.md "Probe result file").
 *
 * Probe results are serialised as JSON under `$HEROKUMCP_HOME/capabilities/<fingerprint>.json`.
 * Phase 1 reads the file on startup; if it's missing, expired, or `force=true`
 * is passed we call {@link runProbes} from `@heroku-mcp/core` and rewrite the
 * file before returning. The file format is the {@link CapabilityResult}
 * defined in core's prober — we don't add extra fields here.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type CapabilityResult, runProbes, type RunProbesOptions } from '@heroku-mcp/core';

/** Result of {@link loadOrProbe}. */
export interface LoadOrProbeResult {
  capabilities: CapabilityResult;
  /** Source of the returned result. `cache` means the on-disk copy was fresh
   *  and re-used; `probe` means probes were re-issued; `refresh` mirrors
   *  `probe` but signals the caller passed `force: true`. */
  source: 'cache' | 'probe' | 'refresh';
}

/** Inputs to {@link loadOrProbe}. */
export interface LoadOrProbeOptions {
  /** Absolute path to the per-fingerprint result file. */
  filePath: string;
  /** Token fingerprint; written into the result and used by {@link runProbes}. */
  tokenFingerprint: string;
  /** Probe runner inputs forwarded verbatim when we need to re-probe. */
  probeOptions: Omit<RunProbesOptions, 'tokenFingerprint'>;
  /** If true, always re-probe regardless of cache freshness. */
  force?: boolean;
  /** Override the cache freshness clock (tests). */
  now?: () => number;
  /** Injectable probe runner; defaults to {@link runProbes}. */
  runProbesFn?: (opts: RunProbesOptions) => Promise<CapabilityResult>;
}

/** Read the cache, falling back to a fresh probe if missing or expired. */
export async function loadOrProbe(opts: LoadOrProbeOptions): Promise<LoadOrProbeResult> {
  const now = opts.now ?? Date.now;
  const runner = opts.runProbesFn ?? runProbes;

  if (!opts.force) {
    const cached = await readCapabilityFile(opts.filePath);
    if (cached && isFresh(cached, now())) {
      return { capabilities: cached, source: 'cache' };
    }
  }

  const capabilities = await runner({
    ...opts.probeOptions,
    tokenFingerprint: opts.tokenFingerprint,
  });
  await writeCapabilityFile(opts.filePath, capabilities);
  return { capabilities, source: opts.force ? 'refresh' : 'probe' };
}

/** Read a capability result from disk. Returns null on any read or parse
 *  failure — capabilities are advisory, never load-bearing for correctness. */
export async function readCapabilityFile(path: string): Promise<CapabilityResult | null> {
  let text: string;
  try {
    text = await readFile(path, { encoding: 'utf8' });
  } catch (err) {
    if (isENOENT(err)) return null;
    return null;
  }
  try {
    const parsed = JSON.parse(text) as CapabilityResult;
    if (parsed.schemaVersion !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Write a capability result to disk, creating the parent directory if needed. */
export async function writeCapabilityFile(path: string, result: CapabilityResult): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(result, null, 2), { encoding: 'utf8' });
}

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

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}
