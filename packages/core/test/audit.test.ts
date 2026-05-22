import { mkdtemp, readFile, readdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_FILE_PREFIX, AUDIT_FILE_SUFFIX, AuditLogger, audutFileName } from '../src/audit.js';
import type { AuditEntry } from '../src/audit.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'herokumcp-audit-'));
});

afterEach(async () => {
  // Files left in tmpdir are harmless; the OS cleans them up.
});

const baseEntry: AuditEntry = {
  server: 'platform',
  tool: 'apps_delete',
  method: 'DELETE',
  url: 'https://api.heroku.com/apps/example',
  target: 'example',
  tokenFp: 'a7b2c1d3e4f56789',
  status: 200,
  requestId: 'req-abc',
  durationMs: 412,
};

describe('audutFileName', () => {
  it('formats as audit-YYYY-MM-DD.log in UTC', () => {
    const d = new Date('2026-05-22T23:59:59.000Z');
    expect(audutFileName(d)).toBe('audit-2026-05-22.log');
  });
});

describe('AuditLogger.append', () => {
  it("writes a JSONL line to today's file", async () => {
    const fixedNow = new Date('2026-05-22T14:33:01.234Z');
    const log = new AuditLogger({ dir, now: () => fixedNow });
    await log.append(baseEntry);

    const filename = audutFileName(fixedNow);
    const contents = await readFile(join(dir, filename), { encoding: 'utf8' });
    const lines = contents.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as AuditEntry;
    expect(parsed.tool).toBe('apps_delete');
    expect(parsed.target).toBe('example');
    expect(parsed.tokenFp).toBe('a7b2c1d3e4f56789');
    expect(parsed.ts).toBe('2026-05-22T14:33:01.234Z');
  });

  it('creates the directory if it does not exist', async () => {
    const sub = join(dir, 'nested', 'audit');
    const log = new AuditLogger({ dir: sub });
    await log.append(baseEntry);
    const filename = audutFileName(new Date());
    const contents = await readFile(join(sub, filename), { encoding: 'utf8' });
    expect(contents).toContain('apps_delete');
  });

  it('appends multiple entries as separate lines', async () => {
    const log = new AuditLogger({ dir });
    await log.append(baseEntry);
    await log.append({ ...baseEntry, tool: 'config_vars_update', method: 'PATCH' });
    await log.append({ ...baseEntry, tool: 'dynos_restart_all', method: 'DELETE' });

    const filename = audutFileName(new Date());
    const contents = await readFile(join(dir, filename), { encoding: 'utf8' });
    const lines = contents.split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('redacts tokens embedded in the URL', async () => {
    const log = new AuditLogger({ dir });
    await log.append({
      ...baseEntry,
      url: 'https://api.heroku.com/apps/x?token=HRKU-abcdef-1234',
    });
    const filename = audutFileName(new Date());
    const contents = await readFile(join(dir, filename), { encoding: 'utf8' });
    expect(contents).toContain('[REDACTED]');
    expect(contents).not.toContain('HRKU-abcdef-1234');
  });

  it('serialises concurrent appends without interleaving', async () => {
    const log = new AuditLogger({ dir });
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        log.append({ ...baseEntry, tool: `tool_${i}`, durationMs: i }),
      ),
    );
    const filename = audutFileName(new Date());
    const contents = await readFile(join(dir, filename), { encoding: 'utf8' });
    const lines = contents.split('\n').filter(Boolean);
    expect(lines).toHaveLength(25);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('uses a daily file per UTC date', async () => {
    let now = new Date('2026-05-22T01:00:00.000Z');
    const log = new AuditLogger({ dir, now: () => now });
    await log.append(baseEntry);
    now = new Date('2026-05-23T01:00:00.000Z');
    await log.append(baseEntry);
    const files = (await readdir(dir)).filter(
      (f) => f.startsWith(AUDIT_FILE_PREFIX) && f.endsWith(AUDIT_FILE_SUFFIX),
    );
    expect(files.sort()).toEqual(['audit-2026-05-22.log', 'audit-2026-05-23.log']);
  });
});

describe('AuditLogger.tail', () => {
  it('returns an empty array when no file exists', async () => {
    const log = new AuditLogger({ dir });
    expect(await log.tail()).toEqual([]);
  });

  it("returns the last N entries from today's file", async () => {
    const log = new AuditLogger({ dir });
    for (let i = 0; i < 10; i++) {
      await log.append({ ...baseEntry, tool: `t${i}` });
    }
    const tail = await log.tail(3);
    expect(tail.map((e) => e.tool)).toEqual(['t7', 't8', 't9']);
  });

  it('uses the default limit (50) when not given', async () => {
    const log = new AuditLogger({ dir });
    for (let i = 0; i < 5; i++) await log.append({ ...baseEntry, tool: `t${i}` });
    const tail = await log.tail();
    expect(tail).toHaveLength(5);
  });

  it('skips malformed lines but still returns the good ones', async () => {
    const filename = audutFileName(new Date());
    await writeFile(
      join(dir, filename),
      [
        JSON.stringify({ ...baseEntry, tool: 'ok' }),
        'not json',
        JSON.stringify({ ...baseEntry, tool: 'ok2' }),
      ].join('\n') + '\n',
      { encoding: 'utf8' },
    );
    const log = new AuditLogger({ dir });
    const out = await log.tail();
    expect(out.map((e) => e.tool)).toEqual(['ok', 'ok2']);
  });
});

describe('AuditLogger.cleanupExpired', () => {
  it('removes files older than the retention window', async () => {
    // Use the real clock — relying on a fake clock here is fragile because
    // file mtimes come from the OS, not the injected clock.
    const realNow = new Date();
    const log = new AuditLogger({ dir, retentionDays: 7 });

    // File from today (within retention).
    await log.append(baseEntry);
    const todayFile = join(dir, audutFileName(realNow));

    // File from 30 days ago (well outside retention).
    const ancient = join(dir, 'audit-old.log');
    await writeFile(ancient, '{}\n', { encoding: 'utf8' });
    const ancientDate = new Date(realNow.getTime() - 30 * 24 * 60 * 60 * 1000);
    await utimes(ancient, ancientDate, ancientDate);

    const removed = await log.cleanupExpired();
    expect(removed).toBe(1);

    const remaining = await readdir(dir);
    expect(remaining).toContain(audutFileName(realNow));
    expect(remaining).not.toContain('audit-old.log');

    const text = await readFile(todayFile, { encoding: 'utf8' });
    expect(text).toContain('apps_delete');
  });

  it('returns 0 when the directory does not exist', async () => {
    const log = new AuditLogger({ dir: join(dir, 'does-not-exist') });
    expect(await log.cleanupExpired()).toBe(0);
  });

  it("ignores files that don't match the audit naming convention", async () => {
    const fixedNow = new Date('2026-06-01T00:00:00.000Z');
    const log = new AuditLogger({ dir, retentionDays: 1, now: () => fixedNow });

    const unrelated = join(dir, 'not-an-audit-file.txt');
    await writeFile(unrelated, 'x', { encoding: 'utf8' });
    const ancientDate = new Date('2020-01-01T00:00:00.000Z');
    await utimes(unrelated, ancientDate, ancientDate);

    expect(await log.cleanupExpired()).toBe(0);
    const remaining = await readdir(dir);
    expect(remaining).toContain('not-an-audit-file.txt');
  });
});
