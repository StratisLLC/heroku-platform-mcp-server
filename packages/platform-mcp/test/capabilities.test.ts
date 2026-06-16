import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CapabilityResult } from '@heroku-mcp/core';
import { loadOrProbe, readCapabilityFile, writeCapabilityFile } from '../src/capabilities.js';

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

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'herokumcp-cap-'));
});

// The pure predicates (isFresh, tierAvailable, isDiagnosticOnly) moved to
// `@heroku-mcp/core` in Phase 8a and are tested there
// (core/test/capabilities.test.ts). This file covers the filesystem cache,
// which stays in platform.

describe('readCapabilityFile + writeCapabilityFile', () => {
  it('round-trips a result through disk', async () => {
    const path = join(dir, 'cap.json');
    await writeCapabilityFile(path, makeResult());
    const read = await readCapabilityFile(path);
    expect(read).not.toBeNull();
    expect(read?.tiers).toEqual(makeResult().tiers);
  });

  it('returns null on missing file', async () => {
    const result = await readCapabilityFile(join(dir, 'nope.json'));
    expect(result).toBeNull();
  });

  it('returns null on corrupt JSON', async () => {
    const path = join(dir, 'cap.json');
    await writeFile(path, 'not json', { encoding: 'utf8' });
    expect(await readCapabilityFile(path)).toBeNull();
  });

  it('returns null on wrong schemaVersion', async () => {
    const path = join(dir, 'cap.json');
    await writeFile(path, JSON.stringify({ schemaVersion: 999 }), { encoding: 'utf8' });
    expect(await readCapabilityFile(path)).toBeNull();
  });
});

describe('loadOrProbe', () => {
  it('returns the cached result when fresh', async () => {
    const path = join(dir, 'cap.json');
    await writeCapabilityFile(path, makeResult());
    let probeCalls = 0;
    const result = await loadOrProbe({
      filePath: path,
      tokenFingerprint: 'abc',
      probeOptions: { token: 't' },
      now: () => FROZEN_NOW + 60_000,
      runProbesFn: () => {
        probeCalls += 1;
        return Promise.resolve(makeResult());
      },
    });
    expect(result.source).toBe('cache');
    expect(probeCalls).toBe(0);
  });

  it('re-probes when cache is stale and writes the new file', async () => {
    const path = join(dir, 'cap.json');
    await writeCapabilityFile(path, makeResult({ ttlSeconds: 60 }));
    const fresh = makeResult({
      tiers: { account: { available: true }, teams: { available: true } },
    });
    const result = await loadOrProbe({
      filePath: path,
      tokenFingerprint: 'abc',
      probeOptions: { token: 't' },
      now: () => FROZEN_NOW + 120_000,
      runProbesFn: () => Promise.resolve(fresh),
    });
    expect(result.source).toBe('probe');
    expect(result.capabilities.tiers).toEqual(fresh.tiers);
    const onDisk = JSON.parse(await readFile(path, { encoding: 'utf8' })) as CapabilityResult;
    expect(onDisk.tiers).toEqual(fresh.tiers);
  });

  it('force=true re-probes even when cache is fresh', async () => {
    const path = join(dir, 'cap.json');
    await writeCapabilityFile(path, makeResult());
    let probeCalls = 0;
    const result = await loadOrProbe({
      filePath: path,
      tokenFingerprint: 'abc',
      probeOptions: { token: 't' },
      now: () => FROZEN_NOW + 60_000,
      force: true,
      runProbesFn: () => {
        probeCalls += 1;
        return Promise.resolve(makeResult());
      },
    });
    expect(result.source).toBe('refresh');
    expect(probeCalls).toBe(1);
  });
});
