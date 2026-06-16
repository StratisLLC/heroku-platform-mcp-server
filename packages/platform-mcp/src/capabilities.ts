/**
 * On-disk capability cache (ARCHITECTURE.md §5.3, CAPABILITY_PROBES.md "Probe result file").
 *
 * Probe results are serialised as JSON under `$HEROKUMCP_HOME/capabilities/<fingerprint>.json`.
 * Phase 1 reads the file on startup; if it's missing, expired, or `force=true`
 * is passed we call {@link runProbes} from `@heroku-mcp/core` and rewrite the
 * file before returning. The file format is the {@link CapabilityResult}
 * defined in core's prober — we don't add extra fields here.
 *
 * The pure predicates over a `CapabilityResult` (`tierAvailable`,
 * `isDiagnosticOnly`, `isFresh`) moved to `@heroku-mcp/core` in Phase 8a; they
 * are re-exported here for back-compat. The filesystem cache below stays in
 * platform because it is server-bootstrap concern, not tool-building concern.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type CapabilityResult, isFresh, runProbes, type RunProbesOptions } from '@heroku-mcp/core';

export { isDiagnosticOnly, isFresh, tierAvailable } from '@heroku-mcp/core';

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

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}
