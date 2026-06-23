/**
 * Capability prober (ARCHITECTURE.md §5, CAPABILITY_PROBES.md).
 *
 * The prober walks the curated probe matrix at startup, issues each request,
 * and produces a {@link CapabilityResult} describing which tiers are
 * available. Tools that depend on an unavailable tier are not advertised by
 * the MCP server (`tools/list`).
 *
 * This is a small, self-contained HTTP runner — it does not go through the
 * main {@link createClient} pipeline. Probes are read-only, time-bounded,
 * one-time-per-startup operations and so neither the audit log nor the ETag
 * cache apply.
 */

import { PLATFORM_PROBES, type Probe, type ProbeBase, substitutePath } from './probes.js';
import { scrubString } from './redact.js';

/** Reasons a tier is marked unavailable. */
export type ProbeReason =
  | 'ok'
  | 'empty'
  | 'forbidden'
  | 'not_found'
  | 'delinquent'
  | 'suspended'
  | 'rate_limit'
  | 'unauthorized'
  | 'timeout'
  | 'server_error'
  | 'network'
  | 'skipped';

/** Per-probe outcome stored alongside the tier verdict. */
export interface ProbeOutcome {
  id: string;
  status: number;
  reason: ProbeReason;
  rangeRemaining?: string;
}

/** One tier's verdict. */
export interface TierResult {
  available: boolean;
  /** Account tier only: when true, only diagnostic tools are exposed. */
  diagnosticOnly?: boolean;
  reason?: ProbeReason;
  status?: number;
  probes?: Record<string, ProbeOutcome>;
}

/** Result file as persisted under `$HEROKUMCP_HOME/capabilities/`.
 *  Sub-tiers under `data` are nested per CAPABILITY_PROBES.md §"Probe result file". */
export interface CapabilityResult {
  schemaVersion: 1;
  tokenFingerprint: string;
  probedAt: string;
  ttlSeconds: number;
  tiers: Record<string, TierResult | Record<string, TierResult>>;
  /** When true, a required probe failed and only diagnostic tools should run. */
  aborted?: boolean;
  /** When `aborted` is true, the probe id and reason that caused it. */
  abortedBy?: { probe: string; reason: ProbeReason };
}

/** Base URL for each {@link ProbeBase}. */
export const PROBE_BASE_URLS: Record<ProbeBase, string> = {
  platform: 'https://api.heroku.com',
  data: 'https://api.data.heroku.com',
  addons: 'https://addons.heroku.com',
};

/** Default capability TTL: 1h per ARCHITECTURE.md §5.3. */
export const DEFAULT_CAPABILITY_TTL_SECONDS = 3600;

export interface RunProbesOptions {
  /** Probes to run. Defaults to {@link PLATFORM_PROBES}. */
  probes?: readonly Probe[];
  /** Bearer token. Required for any probe whose base is `platform` or `data`. */
  token: string | null;
  /** Manifest Basic auth (`id:password`); needed for probes with `manifestAuth: true`. */
  manifestAuth?: { id: string; password: string };
  /** Variable substitutions for `${var}` placeholders in probe paths. */
  vars?: Record<string, string>;
  /** Fingerprint of the token (first 16 chars SHA-256). Recorded in the result. */
  tokenFingerprint: string;
  /** Injectable fetch (tests). */
  fetch?: typeof globalThis.fetch;
  /** Per-probe timeout. Default 10s per CAPABILITY_PROBES.md "Probe execution". */
  timeoutMs?: number;
  /** Max attempts for retryable failures. Default 2 (one initial + one retry). */
  maxAttempts?: number;
  /** Override base URLs for tests. */
  baseUrls?: Partial<Record<ProbeBase, string>>;
  /** Override the result TTL. */
  ttlSeconds?: number;
  /** Injectable clock; returns ms-since-epoch. */
  now?: () => number;
  /** API version for the Heroku Platform API (`platform` and `data` bases). */
  apiVersion?: string;
  /** User-Agent string. */
  userAgent?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = 'herokumcp probe';

/** Values that, used as `HEROKUMCP_PROBE_DEBUG`, leave debug logging off. */
const PROBE_DEBUG_OFF_VALUES = new Set(['', '0', 'false', 'off', 'no']);

/**
 * Whether per-probe status logging is enabled via `HEROKUMCP_PROBE_DEBUG`.
 * Default OFF — the env var must be set to a non-falsey value to turn it on.
 * Read per call so tests/operators can toggle it without re-importing.
 */
function probeDebugEnabled(): boolean {
  const v = process.env.HEROKUMCP_PROBE_DEBUG;
  return v !== undefined && !PROBE_DEBUG_OFF_VALUES.has(v.trim().toLowerCase());
}

/** Status-only diagnostic fields logged for a single probe. */
interface ProbeDebugFields {
  status: number;
  reason: ProbeReason;
  /** Substituted request path (no token; tokens travel in headers). */
  path?: string | undefined;
  /** Parsed Heroku error envelope `id`, when present. */
  errorId?: string | undefined;
  /** Parsed Heroku error envelope `message`, when present. */
  errorMessage?: string | undefined;
}

/**
 * Emit one per-probe diagnostic line to stderr when `HEROKUMCP_PROBE_DEBUG`
 * is enabled (default off). Logs the probe identity, method, path, HTTP
 * status, classified reason, and the parsed Heroku error id/message ONLY —
 * never tokens, auth headers, or response bodies. The line is additionally
 * run through {@link scrubString} as defence in depth.
 */
function logProbe(probe: Probe, fields: ProbeDebugFields): void {
  if (!probeDebugEnabled()) return;
  const parts = [
    `probe=${probe.id}`,
    `tier=${probe.tier}`,
    `method=${probe.method}`,
    `path=${fields.path ?? probe.path}`,
    `status=${fields.status}`,
    `reason=${fields.reason}`,
  ];
  if (fields.errorId !== undefined) parts.push(`error.id=${fields.errorId}`);
  if (fields.errorMessage !== undefined) parts.push(`error.message=${fields.errorMessage}`);
  console.error(`[probe-debug] ${scrubString(parts.join(' '))}`);
}

/** Log the required probe whose failure aborted the run (e.g. 401). */
function logProbeAbort(probe: Probe, reason: ProbeReason): void {
  if (!probeDebugEnabled()) return;
  console.error(`[probe-debug] aborted probe=${probe.id} tier=${probe.tier} reason=${reason}`);
}

/**
 * Run the probe matrix. Returns a {@link CapabilityResult}; never throws on
 * probe-level failures (those become tier verdicts). Only "aborted" startup
 * conditions (required probe returns 401, or any required probe fails such
 * that we can't proceed) set the top-level `aborted` flag.
 */
export async function runProbes(opts: RunProbesOptions): Promise<CapabilityResult> {
  const probes = opts.probes ?? PLATFORM_PROBES;
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? 2;
  const baseUrls: Record<ProbeBase, string> = { ...PROBE_BASE_URLS, ...opts.baseUrls };
  const ttlSeconds = opts.ttlSeconds ?? DEFAULT_CAPABILITY_TTL_SECONDS;
  const now = opts.now ?? Date.now;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const apiVersion = opts.apiVersion ?? '3';

  const outcomes = new Map<string, ProbeOutcome>();
  const result: CapabilityResult = {
    schemaVersion: 1,
    tokenFingerprint: opts.tokenFingerprint,
    probedAt: new Date(now()).toISOString(),
    ttlSeconds,
    tiers: {},
  };

  for (const probe of probes) {
    if (probe.dependsOn) {
      const dep = outcomes.get(probe.dependsOn);
      if (!dep || (dep.reason !== 'ok' && dep.reason !== 'empty')) {
        const outcome: ProbeOutcome = {
          id: probe.id,
          status: 0,
          reason: 'skipped',
        };
        outcomes.set(probe.id, outcome);
        applyOutcome(result, probe, outcome);
        logProbe(probe, { status: 0, reason: 'skipped' });
        continue;
      }
    }

    const outcome = await executeProbe(probe, {
      token: opts.token,
      manifestAuth: opts.manifestAuth,
      vars: opts.vars ?? {},
      fetchFn,
      timeoutMs,
      maxAttempts,
      baseUrls,
      userAgent,
      apiVersion,
    });
    outcomes.set(probe.id, outcome);
    applyOutcome(result, probe, outcome);

    if (probe.required && outcome.reason === 'unauthorized') {
      result.aborted = true;
      result.abortedBy = { probe: probe.id, reason: outcome.reason };
      logProbeAbort(probe, outcome.reason);
      break;
    }
  }

  return result;
}

interface ExecuteContext {
  token: string | null;
  manifestAuth: { id: string; password: string } | undefined;
  vars: Record<string, string>;
  fetchFn: typeof globalThis.fetch;
  timeoutMs: number;
  maxAttempts: number;
  baseUrls: Record<ProbeBase, string>;
  userAgent: string;
  apiVersion: string;
}

async function executeProbe(probe: Probe, ctx: ExecuteContext): Promise<ProbeOutcome> {
  const path = substitutePath(probe.path, ctx.vars);
  if (path.includes('${')) {
    // A required variable is missing; treat as skipped rather than fail.
    logProbe(probe, { status: 0, reason: 'skipped', path });
    return { id: probe.id, status: 0, reason: 'skipped' };
  }
  const url = `${ctx.baseUrls[probe.base]}${path.startsWith('/') ? path : `/${path}`}`;

  const headers: Record<string, string> = {
    Accept: `application/vnd.heroku+json; version=${ctx.apiVersion}`,
    'User-Agent': ctx.userAgent,
  };
  if (probe.range) headers.Range = probe.range;
  if (probe.manifestAuth) {
    if (!ctx.manifestAuth) {
      logProbe(probe, { status: 0, reason: 'skipped', path });
      return { id: probe.id, status: 0, reason: 'skipped' };
    }
    const credential = Buffer.from(`${ctx.manifestAuth.id}:${ctx.manifestAuth.password}`).toString(
      'base64',
    );
    headers.Authorization = `Basic ${credential}`;
  } else if (ctx.token) {
    if (probe.authScheme === 'basic') {
      // Heroku Data API `/postgres/v0/*` namespace: HTTP Basic auth with an
      // empty username and the OAuth token as the password.
      headers.Authorization = `Basic ${Buffer.from(`:${ctx.token}`).toString('base64')}`;
    } else {
      headers.Authorization = `Bearer ${ctx.token}`;
    }
  }

  let lastOutcome: ProbeOutcome | undefined;
  for (let attempt = 1; attempt <= ctx.maxAttempts; attempt += 1) {
    lastOutcome = await issueOnce(probe, url, path, headers, ctx);
    if (lastOutcome.reason !== 'rate_limit') return lastOutcome;
  }
  return lastOutcome ?? { id: probe.id, status: 0, reason: 'network' };
}

async function issueOnce(
  probe: Probe,
  url: string,
  path: string,
  headers: Record<string, string>,
  ctx: ExecuteContext,
): Promise<ProbeOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
  let response: Response;
  try {
    response = await ctx.fetchFn(url, {
      method: probe.method,
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const reason: ProbeReason =
      err instanceof Error &&
      (err.name === 'AbortError' || (err as { code?: string }).code === 'ABORT_ERR')
        ? 'timeout'
        : 'network';
    logProbe(probe, { status: 0, reason, path });
    return { id: probe.id, status: 0, reason };
  }
  clearTimeout(timer);

  const status = response.status;
  const contentRange = response.headers.get('content-range') ?? undefined;
  const herokuError = await tryReadHerokuError(response);

  let reason: ProbeReason;
  if (probe.successCodes.includes(status)) reason = 'ok';
  else if (probe.emptyOkCodes.includes(status)) reason = 'empty';
  else if (status === 401) reason = 'unauthorized';
  else if (status === 402) reason = 'delinquent';
  else if (status === 403) reason = herokuError.id === 'suspended' ? 'suspended' : 'forbidden';
  else if (status === 404) reason = probe.emptyOkCodes.includes(404) ? 'empty' : 'not_found';
  else if (status === 429) reason = 'rate_limit';
  else if (status >= 500) reason = 'server_error';
  else if (probe.forbiddenCodes.includes(status)) reason = 'forbidden';
  else reason = 'forbidden';

  const outcome: ProbeOutcome = { id: probe.id, status, reason };
  if (contentRange !== undefined) outcome.rangeRemaining = contentRange;
  logProbe(probe, {
    status,
    reason,
    path,
    errorId: herokuError.id,
    errorMessage: herokuError.message,
  });
  return outcome;
}

/** Parsed fields from a Heroku error envelope (`{ id, message }`). */
interface HerokuErrorInfo {
  id?: string | undefined;
  message?: string | undefined;
}

/**
 * Best-effort parse of a Heroku error envelope. The `id` drives classification
 * (e.g. `suspended` vs generic `forbidden`); `id` and `message` are also used
 * for `HEROKUMCP_PROBE_DEBUG` logging. Returns the two named fields only — the
 * raw body is never retained or logged.
 */
async function tryReadHerokuError(response: Response): Promise<HerokuErrorInfo> {
  try {
    const text = await response.clone().text();
    if (!text) return {};
    const body = JSON.parse(text) as { id?: unknown; message?: unknown };
    return {
      id: typeof body.id === 'string' ? body.id : undefined,
      message: typeof body.message === 'string' ? body.message : undefined,
    };
  } catch {
    return {};
  }
}

/** Mutate the result with one probe outcome. */
function applyOutcome(result: CapabilityResult, probe: Probe, outcome: ProbeOutcome): void {
  if (probe.tier.startsWith('data.')) {
    const sub = probe.tier.slice('data.'.length);
    let dataGroup = result.tiers.data as Record<string, TierResult> | undefined;
    if (!dataGroup) {
      dataGroup = {};
      result.tiers.data = dataGroup;
    }
    dataGroup[sub] = tierFromOutcome(outcome);
    return;
  }

  const tier = (result.tiers[probe.tier] as TierResult | undefined) ?? { available: false };
  // available is the disjunction across the tier's probes.
  if (outcome.reason === 'ok' || outcome.reason === 'empty') tier.available = true;
  tier.probes ??= {};
  tier.probes[probe.id] = outcome;
  // Tier-level reason/status reflect the first non-ok probe, or the last ok.
  if (!tier.available) {
    tier.reason = outcome.reason;
    tier.status = outcome.status;
  } else {
    delete tier.reason;
    delete tier.status;
  }

  // Special case: account.self carrying 402 → diagnosticOnly.
  if (probe.id === 'account.self') {
    if (outcome.reason === 'delinquent' || outcome.reason === 'suspended') {
      tier.diagnosticOnly = true;
      tier.available = true; // diagnostic mode still "available", just restricted
      tier.reason = outcome.reason;
      tier.status = outcome.status;
    } else if (outcome.reason === 'ok') {
      tier.diagnosticOnly = false;
    }
  }

  result.tiers[probe.tier] = tier;
}

function tierFromOutcome(outcome: ProbeOutcome): TierResult {
  const ok = outcome.reason === 'ok' || outcome.reason === 'empty';
  const tier: TierResult = { available: ok };
  if (!ok) {
    tier.reason = outcome.reason;
    tier.status = outcome.status;
  }
  return tier;
}
