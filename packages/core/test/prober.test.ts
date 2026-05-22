import { describe, expect, it } from 'vitest';
import { PARTNER_PROBES, PLATFORM_PROBES, type Probe, substitutePath } from '../src/probes.js';
import { type CapabilityResult, type TierResult, runProbes } from '../src/prober.js';
import * as F from './fixtures/probe-responses.js';

// ---------------------------------------------------------------------------
// probes.ts coverage
// ---------------------------------------------------------------------------

describe('PLATFORM_PROBES matrix', () => {
  it('includes every tier called out in CAPABILITY_PROBES.md', () => {
    const tiers = new Set(PLATFORM_PROBES.map((p) => p.tier));
    expect(tiers).toContain('account');
    expect(tiers).toContain('apps');
    expect(tiers).toContain('teams');
    expect(tiers).toContain('enterprise');
    expect(tiers).toContain('spaces');
    expect(tiers).toContain('addons_consumer');
    expect(tiers).toContain('pipelines');
    expect(tiers).toContain('data.postgres');
    expect(tiers).toContain('data.redis');
    expect(tiers).toContain('data.kafka');
  });

  it('marks account.self as required and only that probe', () => {
    const required = PLATFORM_PROBES.filter((p) => p.required).map((p) => p.id);
    expect(required).toEqual(['account.self']);
  });

  it('uses GET or HEAD only — probes never mutate', () => {
    for (const p of PLATFORM_PROBES) {
      expect(['GET', 'HEAD']).toContain(p.method);
    }
  });

  it('ids are unique', () => {
    const ids = PLATFORM_PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('PARTNER_PROBES matrix', () => {
  it('contains the four Partner tiers from CAPABILITY_PROBES.md', () => {
    const tiers = new Set(PARTNER_PROBES.map((p) => p.tier));
    expect(tiers).toContain('partner.oauth_basic');
    expect(tiers).toContain('partner.pipelines');
    expect(tiers).toContain('partner.team_members');
    expect(tiers).toContain('partner.manifest');
  });

  it('partner.installs_list uses manifest auth', () => {
    const probe = PARTNER_PROBES.find((p) => p.id === 'partner.installs_list');
    expect(probe?.manifestAuth).toBe(true);
    expect(probe?.base).toBe('addons');
  });

  it('partner.team_members_list depends on partner.addon_info', () => {
    const probe = PARTNER_PROBES.find((p) => p.id === 'partner.team_members_list');
    expect(probe?.dependsOn).toBe('partner.addon_info');
  });
});

describe('substitutePath', () => {
  it('substitutes known variables', () => {
    expect(substitutePath('/addons/${resource_uuid}', { resource_uuid: 'abc' })).toBe(
      '/addons/abc',
    );
  });

  it('leaves unknown placeholders alone', () => {
    expect(substitutePath('/teams/${team_id}', {})).toBe('/teams/${team_id}');
  });

  it('handles multiple variables', () => {
    expect(substitutePath('/x/${a}/y/${b}', { a: '1', b: '2' })).toBe('/x/1/y/2');
  });
});

// ---------------------------------------------------------------------------
// runProbes — response-class cross product
// ---------------------------------------------------------------------------

interface FetchScript {
  fetch: typeof globalThis.fetch;
  calls: { url: string; method?: string; headers?: Record<string, string> }[];
}

function scriptFetch(handlers: ((url: string) => Response | Error)[]): FetchScript {
  const calls: FetchScript['calls'] = [];
  let i = 0;
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => {
        headers[k] = v;
      });
    }
    const entry: { url: string; method?: string; headers?: Record<string, string> } = {
      url,
      headers,
    };
    if (init?.method) entry.method = init.method;
    calls.push(entry);
    const handler = handlers[Math.min(i, handlers.length - 1)];
    i += 1;
    const out = handler!(url);
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
  };
  return { fetch, calls };
}

const baseOpts = {
  token: 'HRKU-test',
  tokenFingerprint: 'fp1234567890abcd',
  maxAttempts: 1,
};

describe('runProbes — account.self response classes', () => {
  it('200 → account available, not diagnostic', async () => {
    const probes: Probe[] = [PLATFORM_PROBES.find((p) => p.id === 'account.self')!];
    const { fetch } = scriptFetch([() => F.ok({ email: 'a@b' })]);
    const r = await runProbes({ ...baseOpts, probes, fetch });
    const account = r.tiers.account as TierResult;
    expect(account.available).toBe(true);
    expect(account.diagnosticOnly).toBe(false);
    expect(r.aborted).toBeUndefined();
  });

  it('401 → aborted with reason unauthorized', async () => {
    const probes: Probe[] = [PLATFORM_PROBES.find((p) => p.id === 'account.self')!];
    const { fetch } = scriptFetch([() => F.unauthorized()]);
    const r = await runProbes({ ...baseOpts, probes, fetch });
    expect(r.aborted).toBe(true);
    expect(r.abortedBy?.reason).toBe('unauthorized');
  });

  it('402 → diagnosticOnly', async () => {
    const probes: Probe[] = [PLATFORM_PROBES.find((p) => p.id === 'account.self')!];
    const { fetch } = scriptFetch([() => F.delinquent()]);
    const r = await runProbes({ ...baseOpts, probes, fetch });
    const account = r.tiers.account as TierResult;
    expect(account.diagnosticOnly).toBe(true);
    expect(account.reason).toBe('delinquent');
  });

  it('403 suspended → diagnosticOnly', async () => {
    const probes: Probe[] = [PLATFORM_PROBES.find((p) => p.id === 'account.self')!];
    const { fetch } = scriptFetch([() => F.suspended()]);
    const r = await runProbes({ ...baseOpts, probes, fetch });
    const account = r.tiers.account as TierResult;
    expect(account.diagnosticOnly).toBe(true);
    expect(account.reason).toBe('suspended');
  });
});

describe('runProbes — apps.list response classes', () => {
  const appsListProbe = PLATFORM_PROBES.find((p) => p.id === 'apps.list')!;

  it('200 → available', async () => {
    const { fetch } = scriptFetch([() => F.ok([])]);
    const r = await runProbes({ ...baseOpts, probes: [appsListProbe], fetch });
    expect((r.tiers.apps as TierResult).available).toBe(true);
  });

  it('206 → available (partial content)', async () => {
    const { fetch } = scriptFetch([() => F.partial()]);
    const r = await runProbes({ ...baseOpts, probes: [appsListProbe], fetch });
    expect((r.tiers.apps as TierResult).available).toBe(true);
  });

  it('403 → not available, reason forbidden', async () => {
    const { fetch } = scriptFetch([() => F.forbidden()]);
    const r = await runProbes({ ...baseOpts, probes: [appsListProbe], fetch });
    const apps = r.tiers.apps as TierResult;
    expect(apps.available).toBe(false);
    expect(apps.reason).toBe('forbidden');
    expect(apps.status).toBe(403);
  });

  it('404 → available with reason empty (caller has access, no instances)', async () => {
    const { fetch } = scriptFetch([() => F.notFound()]);
    const r = await runProbes({ ...baseOpts, probes: [appsListProbe], fetch });
    const apps = r.tiers.apps as TierResult;
    expect(apps.available).toBe(true);
    expect(apps.probes?.['apps.list']?.reason).toBe('empty');
  });

  it('500 → not available, reason server_error', async () => {
    const { fetch } = scriptFetch([() => F.serverError()]);
    const r = await runProbes({ ...baseOpts, probes: [appsListProbe], fetch });
    const apps = r.tiers.apps as TierResult;
    expect(apps.available).toBe(false);
    expect(apps.reason).toBe('server_error');
  });

  it('timeout → not available, reason timeout', async () => {
    const { fetch } = scriptFetch([() => F.timeout()]);
    const r = await runProbes({ ...baseOpts, probes: [appsListProbe], fetch, timeoutMs: 10 });
    const apps = r.tiers.apps as TierResult;
    expect(apps.available).toBe(false);
    expect(apps.reason).toBe('timeout');
  });

  it('network error → not available, reason network', async () => {
    const { fetch } = scriptFetch([() => F.networkFail()]);
    const r = await runProbes({ ...baseOpts, probes: [appsListProbe], fetch });
    const apps = r.tiers.apps as TierResult;
    expect(apps.available).toBe(false);
    expect(apps.reason).toBe('network');
  });

  it('429 retries once, then fails-open with reason rate_limit', async () => {
    const { fetch, calls } = scriptFetch([() => F.rateLimited(), () => F.rateLimited()]);
    const r = await runProbes({
      ...baseOpts,
      maxAttempts: 2,
      probes: [appsListProbe],
      fetch,
    });
    expect(calls).toHaveLength(2);
    expect((r.tiers.apps as TierResult).reason).toBe('rate_limit');
  });

  it('429 retries once and succeeds on second attempt', async () => {
    const { fetch, calls } = scriptFetch([() => F.rateLimited(), () => F.ok([])]);
    const r = await runProbes({
      ...baseOpts,
      maxAttempts: 2,
      probes: [appsListProbe],
      fetch,
    });
    expect(calls).toHaveLength(2);
    expect((r.tiers.apps as TierResult).available).toBe(true);
  });
});

describe('runProbes — data tier nesting', () => {
  it('nests data.postgres under tiers.data per the result file shape', async () => {
    const probe = PLATFORM_PROBES.find((p) => p.id === 'data.postgres_root')!;
    const { fetch } = scriptFetch([() => new Response(null, { status: 200 })]);
    const r = await runProbes({ ...baseOpts, probes: [probe], fetch });
    const data = r.tiers.data as Record<string, TierResult>;
    expect(data.postgres?.available).toBe(true);
  });

  it('404 on data.postgres means unavailable (no add-on in scope)', async () => {
    const probe = PLATFORM_PROBES.find((p) => p.id === 'data.postgres_root')!;
    const { fetch } = scriptFetch([() => new Response(null, { status: 404 })]);
    const r = await runProbes({ ...baseOpts, probes: [probe], fetch });
    const data = r.tiers.data as Record<string, TierResult>;
    expect(data.postgres?.available).toBe(false);
    expect(data.postgres?.reason).toBe('not_found');
  });
});

describe('runProbes — dependsOn', () => {
  it('skips a dependent probe when its dependency was not ok/empty', async () => {
    const dep: Probe = {
      id: 'dep',
      tier: 'x',
      method: 'GET',
      path: '/dep',
      base: 'platform',
      required: false,
      successCodes: [200],
      emptyOkCodes: [],
      forbiddenCodes: [403],
    };
    const dependent: Probe = {
      id: 'dep_target',
      tier: 'y',
      method: 'GET',
      path: '/y',
      base: 'platform',
      required: false,
      successCodes: [200],
      emptyOkCodes: [],
      forbiddenCodes: [403],
      dependsOn: 'dep',
    };
    // Dep fails (403), so dependent is skipped — only one fetch issued.
    const { fetch, calls } = scriptFetch([() => F.forbidden()]);
    const r = await runProbes({ ...baseOpts, probes: [dep, dependent], fetch });
    expect(calls).toHaveLength(1);
    expect((r.tiers.y as TierResult).probes?.dep_target?.reason).toBe('skipped');
  });

  it('runs a dependent probe when its dependency succeeded', async () => {
    const dep: Probe = {
      id: 'dep',
      tier: 'x',
      method: 'GET',
      path: '/dep',
      base: 'platform',
      required: false,
      successCodes: [200],
      emptyOkCodes: [],
      forbiddenCodes: [403],
    };
    const dependent: Probe = {
      id: 'dep_target',
      tier: 'y',
      method: 'GET',
      path: '/y',
      base: 'platform',
      required: false,
      successCodes: [200],
      emptyOkCodes: [],
      forbiddenCodes: [403],
      dependsOn: 'dep',
    };
    const { fetch, calls } = scriptFetch([() => F.ok(), () => F.ok()]);
    const r = await runProbes({ ...baseOpts, probes: [dep, dependent], fetch });
    expect(calls).toHaveLength(2);
    expect((r.tiers.y as TierResult).available).toBe(true);
  });
});

describe('runProbes — request shape', () => {
  it('sends Authorization Bearer and Accept headers', async () => {
    const probe = PLATFORM_PROBES.find((p) => p.id === 'account.self')!;
    const { fetch, calls } = scriptFetch([() => F.ok({ email: 'a@b' })]);
    await runProbes({ ...baseOpts, probes: [probe], fetch });
    expect(calls[0]!.headers!.authorization).toBe('Bearer HRKU-test');
    expect(calls[0]!.headers!.accept).toBe('application/vnd.heroku+json; version=3');
  });

  it('substitutes ${resource_uuid} in partner probes', async () => {
    const probe = PARTNER_PROBES.find((p) => p.id === 'partner.addon_info')!;
    const { fetch, calls } = scriptFetch([() => F.ok({})]);
    await runProbes({
      ...baseOpts,
      probes: [probe],
      fetch,
      vars: { resource_uuid: 'uuid-1234' },
    });
    expect(calls[0]!.url).toBe('https://api.heroku.com/addons/uuid-1234');
  });

  it('skips a probe when a required variable is missing', async () => {
    const probe = PARTNER_PROBES.find((p) => p.id === 'partner.team_members_list')!;
    const { fetch, calls } = scriptFetch([]); // never called
    const r = await runProbes({ ...baseOpts, probes: [probe], fetch, vars: {} });
    expect(calls).toHaveLength(0);
    expect(
      (r.tiers['partner.team_members'] as TierResult).probes?.['partner.team_members_list']?.reason,
    ).toBe('skipped');
  });

  it('uses manifest Basic auth for manifest probes', async () => {
    const probe = PARTNER_PROBES.find((p) => p.id === 'partner.installs_list')!;
    const { fetch, calls } = scriptFetch([() => F.ok([])]);
    await runProbes({
      ...baseOpts,
      probes: [probe],
      fetch,
      manifestAuth: { id: 'my-addon', password: 'secret' },
    });
    const expected = `Basic ${Buffer.from('my-addon:secret').toString('base64')}`;
    expect(calls[0]!.headers!.authorization).toBe(expected);
    expect(calls[0]!.url.startsWith('https://addons.heroku.com')).toBe(true);
  });

  it('skips a manifest probe when manifest credentials are absent', async () => {
    const probe = PARTNER_PROBES.find((p) => p.id === 'partner.installs_list')!;
    const { fetch, calls } = scriptFetch([]);
    const r = await runProbes({ ...baseOpts, probes: [probe], fetch });
    expect(calls).toHaveLength(0);
    expect(
      (r.tiers['partner.manifest'] as TierResult).probes?.['partner.installs_list']?.reason,
    ).toBe('skipped');
  });
});

describe('runProbes — result envelope', () => {
  it('populates schemaVersion, tokenFingerprint, ttlSeconds, probedAt', async () => {
    const { fetch } = scriptFetch([() => F.ok()]);
    const r: CapabilityResult = await runProbes({
      ...baseOpts,
      probes: [PLATFORM_PROBES[0]!],
      fetch,
      ttlSeconds: 1234,
      now: () => Date.parse('2026-05-22T14:33:01.234Z'),
    });
    expect(r.schemaVersion).toBe(1);
    expect(r.tokenFingerprint).toBe('fp1234567890abcd');
    expect(r.ttlSeconds).toBe(1234);
    expect(r.probedAt).toBe('2026-05-22T14:33:01.234Z');
  });
});
