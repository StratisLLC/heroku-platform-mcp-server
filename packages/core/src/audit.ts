/**
 * JSONL audit log with daily rotation (ARCHITECTURE.md §10).
 *
 * Every mutating Heroku call (POST/PATCH/PUT/DELETE) is recorded as one JSON
 * line in `audit-<YYYY-MM-DD>.log` under the configured directory. Bodies are
 * not logged; only the structured metadata defined in §10. Entries are passed
 * through {@link redact} before writing as a defensive measure against
 * accidentally-secret URLs.
 *
 * Files older than the retention period (default 30 days) are removed by
 * {@link AuditLogger.cleanupExpired}, which the host is expected to call on
 * startup. The logger does not run timers itself — Phase 0 stays pure.
 */

import { appendFile, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { redact } from './redact.js';

/** Discriminator for which MCP server produced an entry. */
export type AuditServer = 'platform' | 'partner';

/** One audit record. Optional fields are omitted from the serialised line when
 *  not provided, keeping the on-disk format tight. */
export interface AuditEntry {
  /** ISO-8601 timestamp; set by {@link AuditLogger.append} if absent. */
  ts?: string;
  server: AuditServer;
  tool: string;
  method: string;
  url: string;
  /** Human-readable target (app name, team name…); used for confirms. */
  target?: string;
  /** First 16 chars of SHA-256(token). Never the raw token. */
  tokenFp: string;
  status: number;
  requestId?: string;
  durationMs: number;
}

export interface AuditLoggerOptions {
  /** Directory to write audit files into. Created if it does not exist. */
  dir: string;
  /** How long to keep historical files (in days). Default 30. */
  retentionDays?: number;
  /** Injectable clock for tests; returns a `Date`. Defaults to `new Date()`. */
  now?: () => Date;
  /** Replace the default redactor (used for tests). */
  redactFn?: (value: unknown) => unknown;
}

/** Filename prefix for audit files. Public so tools and host scripts can
 *  glob-match the directory. */
export const AUDIT_FILE_PREFIX = 'audit-';
/** Filename suffix for audit files. */
export const AUDIT_FILE_SUFFIX = '.log';

/**
 * Append-only audit log. One instance per process is typical; calls are
 * serialised internally so the on-disk file never contains interleaved
 * partial lines.
 */
export class AuditLogger {
  private readonly dir: string;
  private readonly retentionDays: number;
  private readonly clock: () => Date;
  private readonly redactFn: (value: unknown) => unknown;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: AuditLoggerOptions) {
    this.dir = opts.dir;
    this.retentionDays = opts.retentionDays ?? 30;
    this.clock = opts.now ?? (() => new Date());
    this.redactFn = opts.redactFn ?? redact;
  }

  /** Append a single entry. Resolves once the line is durably written. */
  append(entry: AuditEntry): Promise<void> {
    const now = this.clock();
    const ts = entry.ts ?? now.toISOString();
    const filename = audutFileName(now);
    const filePath = join(this.dir, filename);

    const merged: AuditEntry = { ...entry, ts };
    const redactedRaw = this.redactFn(merged);
    const redactedEntry =
      typeof redactedRaw === 'object' && redactedRaw !== null
        ? (redactedRaw as Record<string, unknown>)
        : { value: redactedRaw };
    const line = `${JSON.stringify(redactedEntry)}\n`;

    const job = this.writeChain.then(async () => {
      await mkdir(this.dir, { recursive: true });
      await appendFile(filePath, line, { encoding: 'utf8' });
    });
    this.writeChain = job.catch(() => undefined);
    return job;
  }

  /**
   * Read the last `limit` entries from today's file. Returns an empty array
   * when no file exists for today. Older files are not scanned — for cross-day
   * tailing, callers should read directly from disk.
   */
  async tail(limit = 50): Promise<AuditEntry[]> {
    const filename = audutFileName(this.clock());
    const filePath = join(this.dir, filename);
    let text: string;
    try {
      text = await readFile(filePath, { encoding: 'utf8' });
    } catch (err) {
      if (isENOENT(err)) return [];
      throw err;
    }
    const lines = text.split('\n').filter((l) => l.length > 0);
    const start = Math.max(0, lines.length - Math.max(0, Math.floor(limit)));
    const out: AuditEntry[] = [];
    for (const line of lines.slice(start)) {
      try {
        out.push(JSON.parse(line) as AuditEntry);
      } catch {
        // Skip malformed lines silently — the audit log is best-effort for tailing.
      }
    }
    return out;
  }

  /**
   * Delete audit files older than {@link AuditLoggerOptions.retentionDays}.
   * Returns the number of files removed. Safe to call when the directory
   * doesn't exist.
   */
  async cleanupExpired(): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if (isENOENT(err)) return 0;
      throw err;
    }
    const cutoff = this.clock().getTime() - this.retentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const name of entries) {
      if (!name.startsWith(AUDIT_FILE_PREFIX) || !name.endsWith(AUDIT_FILE_SUFFIX)) continue;
      const full = join(this.dir, name);
      const s = await stat(full);
      if (s.mtimeMs < cutoff) {
        await unlink(full);
        removed += 1;
      }
    }
    return removed;
  }
}

/** Build the audit filename for a given date (UTC). Exposed for tests and
 *  host glob patterns. */
export function audutFileName(now: Date): string {
  const ymd = now.toISOString().slice(0, 10);
  return `${AUDIT_FILE_PREFIX}${ymd}${AUDIT_FILE_SUFFIX}`;
}

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}
