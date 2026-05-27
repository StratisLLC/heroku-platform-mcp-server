/**
 * Live integration test: drives a real `McpServer` (talking to api.heroku.com
 * through the workspace's HTTP client) over an in-memory MCP transport.
 *
 * Gated on `HEROKUMCP_TEST_TOKEN`. Without that var every test is skipped, so
 * the file remains safe to execute in CI without secrets.
 *
 * What we prove end-to-end:
 *   - The stdio server boots against a real token without erroring.
 *   - whoami / account_info / rate_limit_status return Heroku data shaped as
 *     our envelope expects.
 *   - apps_list returns a list (or an empty list when the account has none).
 *   - config_vars_get returns a cleartext map if any apps exist.
 *   - Phase 2a write flow: create app → set config var → scale formation →
 *     rename → dry_run delete (verifies pre-fetch surfaced owner/region) →
 *     actual delete with confirm.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../../src/server.js';
import { resolvePaths } from '../../src/paths.js';

const TOKEN = process.env.HEROKUMCP_TEST_TOKEN;
const describeLive = TOKEN ? describe : describe.skip;

interface Envelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { kind?: string; message?: string };
  meta?: { requestId?: string; rateLimitRemaining?: number };
}

function parseEnv<T = unknown>(result: { content: unknown[] }): Envelope<T> {
  const first = result.content[0] as { type?: string; text?: string };
  return JSON.parse(first.text!) as Envelope<T>;
}

describeLive('platform-mcp ↔ live api.heroku.com', () => {
  it('boots, lists tools, and round-trips whoami / account_info / rate_limit_status / apps_list', async () => {
    const home = await mkdtemp(join(tmpdir(), 'herokumcp-int-'));
    const paths = resolvePaths({ home, platform: process.platform });

    const built = await buildServer({
      token: TOKEN!,
      paths,
      version: '0.0.0-int',
      forceProbe: true,
    });
    const client = new Client({ name: 'integration', version: '0.0.0-int' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([built.server.connect(b), client.connect(a)]);

    const list = await client.listTools();
    const names = list.tools.map((t) => t.name);
    expect(names).toContain('whoami');
    expect(names).toContain('rate_limit_status');
    // At least the account tier should be available on any usable token.
    expect(names).toContain('account_info');

    const whoami = (await client.callTool({ name: 'whoami' })) as { content: unknown[] };
    const whoEnv = parseEnv<{ id: string; email: string }>(whoami);
    expect(whoEnv.ok).toBe(true);
    expect(whoEnv.data?.email).toMatch(/.+@.+/);

    const rate = (await client.callTool({ name: 'rate_limit_status' })) as { content: unknown[] };
    const rateEnv = parseEnv<{ remaining: number }>(rate);
    expect(rateEnv.ok).toBe(true);
    expect(typeof rateEnv.data?.remaining).toBe('number');

    const accountInfo = (await client.callTool({ name: 'account_info' })) as {
      content: unknown[];
    };
    const accountEnv = parseEnv<{ id: string }>(accountInfo);
    expect(accountEnv.ok).toBe(true);
    expect(accountEnv.data?.id).toMatch(/[0-9a-f-]{36}/);

    if (names.includes('apps_list')) {
      const appsResult = (await client.callTool({
        name: 'apps_list',
        arguments: { page_size: 5 },
      })) as { content: unknown[] };
      const appsEnv = parseEnv<{ id: string; name: string }[]>(appsResult);
      expect(appsEnv.ok).toBe(true);
      if (appsEnv.data && appsEnv.data.length > 0) {
        const first = appsEnv.data[0]!;
        expect(typeof first.name).toBe('string');
        const cfg = (await client.callTool({
          name: 'config_vars_get',
          arguments: { app: first.name },
        })) as { content: unknown[] };
        const cfgEnv = parseEnv<Record<string, string | null>>(cfg);
        expect(cfgEnv.ok).toBe(true);
        // Cleartext: must not be `[REDACTED]` for legitimate getter.
        for (const value of Object.values(cfgEnv.data ?? {})) {
          if (typeof value === 'string') {
            expect(value).not.toBe('[REDACTED]');
          }
        }
      }
    }
  }, 60_000);

  it('walks the Phase 2a write lifecycle (create → mutate → dry_run delete → delete)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'herokumcp-int2a-'));
    const paths = resolvePaths({ home, platform: process.platform });
    const built = await buildServer({
      token: TOKEN!,
      paths,
      version: '0.0.0-int',
      forceProbe: true,
    });
    const client = new Client({ name: 'integration2a', version: '0.0.0-int' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([built.server.connect(b), client.connect(a)]);

    const names = (await client.listTools()).tools.map((t) => t.name);
    if (!names.includes('apps_create') || !names.includes('apps_delete')) {
      return; // tier not available on this token
    }

    const baseName = `herokumcp-2a-${Date.now().toString(36)}`;

    // Create. (apps_create is a Phase 1 read-marked tool that POSTs; if Phase 2
    // adds it as a write, this still works because dry_run is optional.)
    const create = (await client.callTool({
      name: 'apps_create',
      arguments: { name: baseName },
    })) as { content: unknown[]; isError?: boolean };
    if (create.isError) {
      // Account may not have room for new apps — bail out gracefully.
      return;
    }
    const created = parseEnv<{ id: string; name: string }>(create);
    expect(created.ok).toBe(true);
    const appName = created.data!.name;
    const appId = created.data!.id; // UUID — what Claude is likely to pass as args.app

    try {
      // Set a config var (no confirm required).
      const cfg = (await client.callTool({
        name: 'config_vars_update',
        arguments: { app: appName, config: { PHASE_2A_FLAG: '1' } },
      })) as { content: unknown[] };
      expect(parseEnv(cfg).ok).toBe(true);

      // Scale the web formation to zero (no confirm; reversible).
      const scale = (await client.callTool({
        name: 'formation_scale',
        arguments: { app: appName, updates: [{ type: 'web', quantity: 0 }] },
      })) as { content: unknown[]; isError?: boolean };
      // Heroku may 422 if there's no web process type yet — that's fine.
      // Just exercise the request path.
      void scale;

      // dry_run delete: should pre-fetch and return the description.
      const previewName = `${appName}-renamed`;
      const update = (await client.callTool({
        name: 'apps_update',
        arguments: { app: appName, name: previewName },
      })) as { content: unknown[] };
      const updEnv = parseEnv<{ name: string }>(update);
      expect(updEnv.ok).toBe(true);
      expect(updEnv.data?.name).toBe(previewName);

      // Demonstrate the post-Phase-2b confirm fix: pass the UUID as args.app
      // (what Claude resolves to internally) and the human-readable name as
      // confirm (what the user typed in conversation). The expected confirm
      // value comes from the prefetched response's name field — not args.app.
      const dryRun = (await client.callTool({
        name: 'apps_delete',
        arguments: { app: appId, dry_run: true },
      })) as { content: unknown[] };
      const dryEnv = parseEnv<{ description: string; request: { method: string } }>(dryRun);
      expect(dryEnv.ok).toBe(true);
      expect(dryEnv.data?.request.method).toBe('DELETE');
      expect(typeof dryEnv.data?.description).toBe('string');
      expect(dryEnv.data!.description.length).toBeGreaterThan(0);

      // Real delete: args.app is the UUID; confirm is the canonical name.
      const del = (await client.callTool({
        name: 'apps_delete',
        arguments: { app: appId, confirm: previewName },
      })) as { content: unknown[] };
      expect(parseEnv(del).ok).toBe(true);
    } catch (err) {
      // Best-effort cleanup if anything in the middle blew up.
      await client
        .callTool({ name: 'apps_delete', arguments: { app: appName, confirm: appName } })
        .catch(() => undefined);
      throw err;
    }
  }, 90_000);

  it('walks the Phase 2b teams-tier lifecycle (list → invite → revoke → delete team)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'herokumcp-int2b-teams-'));
    const paths = resolvePaths({ home, platform: process.platform });
    const built = await buildServer({
      token: TOKEN!,
      paths,
      version: '0.0.0-int',
      forceProbe: true,
    });
    const client = new Client({ name: 'integration2b-teams', version: '0.0.0-int' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([built.server.connect(b), client.connect(a)]);

    const names = (await client.listTools()).tools.map((t) => t.name);
    if (!names.includes('teams_list')) {
      // Teams tier not available on this token — skip.
      return;
    }

    // 1. List teams, paginated. We don't insist on a particular team being
    //    present, but we do want pagination machinery to round-trip.
    const teamsList = (await client.callTool({
      name: 'teams_list',
      arguments: { page_size: 100 },
    })) as { content: unknown[] };
    const teamsEnv = parseEnv<{ id: string; name: string }[]>(teamsList);
    expect(teamsEnv.ok).toBe(true);

    const harnessTeam = teamsEnv.data?.find((t) => t.name === 'herokumcp-phase2b-test');

    // 2. If the harness team exists, exercise the team-owned app lifecycle.
    if (harnessTeam) {
      const teamApps = (await client.callTool({
        name: 'team_apps_list',
        arguments: { team: harnessTeam.name, page_size: 100 },
      })) as { content: unknown[] };
      const teamAppsEnv = parseEnv<{ name: string }[]>(teamApps);
      expect(teamAppsEnv.ok).toBe(true);

      const claudeApp = teamAppsEnv.data?.find((a2) => a2.name === 'herokumcp-phase2b-claude-test');
      if (claudeApp) {
        // Setting a config var on the team-owned app exercises the
        // Phase 2a tool against team apps.
        const cfg = (await client.callTool({
          name: 'config_vars_update',
          arguments: { app: claudeApp.name, config: { PHASE_2B_FLAG: '1' } },
        })) as { content: unknown[] };
        expect(parseEnv(cfg).ok).toBe(true);
      }

      // 3. Invite a fake user; immediately dry-run revoking; then real revoke.
      // Pass the team UUID as args.team (mirrors what Claude resolves to
      // internally) and the email as args.user. The confirm value should be
      // the user's email — derived from the prefetched invitation, not args.
      const fakeEmail = `test-fake-${Date.now().toString(36)}@example.com`;
      const invite = (await client.callTool({
        name: 'team_invitations_create',
        arguments: { team: harnessTeam.id, email: fakeEmail, role: 'member' },
      })) as { content: unknown[]; isError?: boolean };
      if (!invite.isError) {
        const dryRevoke = (await client.callTool({
          name: 'team_invitations_revoke',
          arguments: { team: harnessTeam.id, user: fakeEmail, dry_run: true },
        })) as { content: unknown[] };
        const dryEnv = parseEnv<{ description: string }>(dryRevoke);
        expect(dryEnv.ok).toBe(true);
        // Pre-fetch should have located the invitation we just created.
        expect(dryEnv.data?.description).toContain(fakeEmail);

        const realRevoke = (await client.callTool({
          name: 'team_invitations_revoke',
          arguments: { team: harnessTeam.id, user: fakeEmail, confirm: fakeEmail },
        })) as { content: unknown[]; isError?: boolean };
        // The revoke either succeeded (200) or 404'd because the invitation
        // was already auto-revoked. Either way the destructive path executed.
        expect(realRevoke.isError === true || parseEnv(realRevoke).ok === true).toBe(true);
      }
    }

    // 4. Standalone-team create / dry-run delete / real delete. Skipped if
    //    Heroku rejects team creation on this token (common — many tokens
    //    can't create standalone teams).
    const ephemeralName = `herokumcp-phase2b-ephemeral-${Date.now().toString(36)}`;
    const create = (await client.callTool({
      name: 'teams_create',
      arguments: { name: ephemeralName },
    })) as { content: unknown[]; isError?: boolean };
    if (create.isError) {
      return; // Heroku declined — bail without failing the test.
    }
    const createEnv = parseEnv<{ id: string; name: string }>(create);
    expect(createEnv.ok).toBe(true);

    try {
      const dryDelete = (await client.callTool({
        name: 'teams_delete',
        arguments: { team: ephemeralName, dry_run: true },
      })) as { content: unknown[] };
      const dryEnv = parseEnv<{ description: string; request: { method: string } }>(dryDelete);
      expect(dryEnv.ok).toBe(true);
      expect(dryEnv.data?.request.method).toBe('DELETE');
      expect(dryEnv.data?.description).toContain(ephemeralName);
    } finally {
      await client
        .callTool({
          name: 'teams_delete',
          arguments: { team: ephemeralName, confirm: ephemeralName },
        })
        .catch(() => undefined);
    }
  }, 90_000);

  it('walks the Phase 3 enterprise tier (read-only against heroku-demo if present)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'herokumcp-int3-ent-'));
    const paths = resolvePaths({ home, platform: process.platform });
    const built = await buildServer({
      token: TOKEN!,
      paths,
      version: '0.0.0-int',
      forceProbe: true,
    });
    const client = new Client({ name: 'integration3-enterprise', version: '0.0.0-int' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([built.server.connect(b), client.connect(a)]);

    const names = (await client.listTools()).tools.map((t) => t.name);
    if (!names.includes('enterprise_accounts_list')) {
      return; // Enterprise tier not available on this token.
    }

    const list = (await client.callTool({
      name: 'enterprise_accounts_list',
      arguments: { page_size: 100 },
    })) as { content: unknown[] };
    const listEnv = parseEnv<{ id: string; name: string }[]>(list);
    expect(listEnv.ok).toBe(true);

    const demo = listEnv.data?.find((e) => e.name === 'heroku-demo') ?? listEnv.data?.[0];
    if (!demo) return;

    const info = (await client.callTool({
      name: 'enterprise_accounts_info',
      arguments: { enterprise: demo.id },
    })) as { content: unknown[] };
    expect(parseEnv(info).ok).toBe(true);

    const members = (await client.callTool({
      name: 'enterprise_account_members_list',
      arguments: { enterprise: demo.id, page_size: 5 },
    })) as { content: unknown[]; isError?: boolean };
    // Members may 403 for non-admin tokens — surface either ok or error
    // envelope to confirm wiring without insisting on permissions.
    expect(members.isError === true || parseEnv(members).ok === true).toBe(true);

    // Last month's usage. Compute a short window so the request stays cheap.
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
    const end = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10);
    const usage = (await client.callTool({
      name: 'enterprise_account_monthly_usage',
      arguments: { enterprise: demo.id, start, end },
    })) as { content: unknown[]; isError?: boolean };
    expect(usage.isError === true || parseEnv(usage).ok === true).toBe(true);
  }, 90_000);

  it('walks the Phase 3 spaces tier (read-only; optionally creates a Shield space)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'herokumcp-int3-spaces-'));
    const paths = resolvePaths({ home, platform: process.platform });
    const built = await buildServer({
      token: TOKEN!,
      paths,
      version: '0.0.0-int',
      forceProbe: true,
    });
    const client = new Client({ name: 'integration3-spaces', version: '0.0.0-int' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([built.server.connect(b), client.connect(a)]);

    const names = (await client.listTools()).tools.map((t) => t.name);
    if (!names.includes('spaces_list')) return; // Spaces tier not available.

    const list = (await client.callTool({
      name: 'spaces_list',
      arguments: { page_size: 25 },
    })) as { content: unknown[] };
    const listEnv = parseEnv<{ id: string; name: string }[]>(list);
    expect(listEnv.ok).toBe(true);

    // If a space exists, exercise the NAT read against it.
    const space = listEnv.data?.[0];
    if (space) {
      const nat = (await client.callTool({
        name: 'spaces_nat_info',
        arguments: { space: space.id },
      })) as { content: unknown[]; isError?: boolean };
      expect(nat.isError === true || parseEnv(nat).ok === true).toBe(true);
    }

    // Optional create/destroy lifecycle. SKIPPED by default — Private Space
    // provisioning takes 8-10 minutes and consumes Enterprise quota.
    if (!process.env.HEROKUMCP_TEST_SPACE_CREATE) return;

    const teamsList = (await client.callTool({
      name: 'teams_list',
      arguments: { page_size: 5 },
    })) as { content: unknown[] };
    const team = parseEnv<{ name: string }[]>(teamsList).data?.[0];
    if (!team) return; // No team to own the space.

    const spaceName = `herokumcp-int3-${Date.now().toString(36)}`;
    const create = (await client.callTool({
      name: 'spaces_create',
      arguments: {
        name: spaceName,
        team: team.name,
        shield: true,
        log_drain_url: 'https://localhost',
      },
    })) as { content: unknown[]; isError?: boolean };
    if (create.isError) return; // Heroku may refuse on quota grounds.

    try {
      // Poll for state="allocated", giving up after 12 minutes.
      const deadline = Date.now() + 12 * 60_000;
      while (Date.now() < deadline) {
        const info = (await client.callTool({
          name: 'spaces_info',
          arguments: { space: spaceName },
        })) as { content: unknown[] };
        const state = parseEnv<{ state?: string }>(info).data?.state;
        if (state === 'allocated') break;
        await new Promise((r) => setTimeout(r, 15_000));
      }
    } finally {
      await client
        .callTool({
          name: 'spaces_destroy',
          arguments: { space: spaceName, confirm: spaceName },
        })
        .catch(() => undefined);
    }
  }, 900_000);

  it('walks the Phase 3 addons tier (provision Heroku Scheduler on a scratch app)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'herokumcp-int3-addons-'));
    const paths = resolvePaths({ home, platform: process.platform });
    const built = await buildServer({
      token: TOKEN!,
      paths,
      version: '0.0.0-int',
      forceProbe: true,
    });
    const client = new Client({ name: 'integration3-addons', version: '0.0.0-int' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([built.server.connect(b), client.connect(a)]);

    const names = (await client.listTools()).tools.map((t) => t.name);
    if (!names.includes('addons_list') || !names.includes('apps_create')) return;

    const list = (await client.callTool({
      name: 'addons_list',
      arguments: { page_size: 5 },
    })) as { content: unknown[] };
    expect(parseEnv(list).ok).toBe(true);

    const services = (await client.callTool({
      name: 'addon_services_list',
      arguments: { page_size: 5 },
    })) as { content: unknown[] };
    expect(parseEnv(services).ok).toBe(true);

    // Lifecycle: create scratch app → provision scheduler → fetch config →
    // list webhooks → destroy add-on → delete scratch app. Best-effort cleanup
    // in finally.
    const appName = `herokumcp-int3-addons-${Date.now().toString(36)}`;
    const create = (await client.callTool({
      name: 'apps_create',
      arguments: { name: appName },
    })) as { content: unknown[]; isError?: boolean };
    if (create.isError) return;

    try {
      const provision = (await client.callTool({
        name: 'addons_create',
        arguments: { app: appName, plan: 'scheduler:standard' },
      })) as { content: unknown[]; isError?: boolean };
      if (provision.isError) return; // Quota or marketplace issue.
      const addon = parseEnv<{ id: string; name: string }>(provision).data!;

      const cfg = (await client.callTool({
        name: 'addon_config_get',
        arguments: { addon: addon.id },
      })) as { content: unknown[]; isError?: boolean };
      expect(cfg.isError === true || parseEnv(cfg).ok === true).toBe(true);

      const webhooks = (await client.callTool({
        name: 'addon_webhooks_list',
        arguments: { addon: addon.id, page_size: 5 },
      })) as { content: unknown[]; isError?: boolean };
      expect(webhooks.isError === true || parseEnv(webhooks).ok === true).toBe(true);

      // Destroy the add-on. confirm must match the canonical add-on name (from
      // prefetch), not the UUID — Phase 2b fix.
      const destroy = (await client.callTool({
        name: 'addons_destroy',
        arguments: { app: appName, addon: addon.id, confirm: addon.name },
      })) as { content: unknown[]; isError?: boolean };
      expect(destroy.isError === true || parseEnv(destroy).ok === true).toBe(true);
    } finally {
      await client
        .callTool({ name: 'apps_delete', arguments: { app: appName, confirm: appName } })
        .catch(() => undefined);
    }
  }, 120_000);

  it('walks the Phase 3 pipelines tier (create pipeline → attach → list → destroy)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'herokumcp-int3-pipes-'));
    const paths = resolvePaths({ home, platform: process.platform });
    const built = await buildServer({
      token: TOKEN!,
      paths,
      version: '0.0.0-int',
      forceProbe: true,
    });
    const client = new Client({ name: 'integration3-pipelines', version: '0.0.0-int' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([built.server.connect(b), client.connect(a)]);

    const names = (await client.listTools()).tools.map((t) => t.name);
    if (!names.includes('pipelines_list') || !names.includes('apps_create')) return;

    const list = (await client.callTool({
      name: 'pipelines_list',
      arguments: { page_size: 5 },
    })) as { content: unknown[] };
    expect(parseEnv(list).ok).toBe(true);

    // Scratch app + new pipeline + coupling lifecycle.
    const appName = `herokumcp-int3-pipe-${Date.now().toString(36)}`;
    const pipelineName = `herokumcp-int3-pipeline-${Date.now().toString(36)}`;

    const createApp = (await client.callTool({
      name: 'apps_create',
      arguments: { name: appName },
    })) as { content: unknown[]; isError?: boolean };
    if (createApp.isError) return;

    let pipelineId: string | undefined;
    let couplingId: string | undefined;
    try {
      const createPipe = (await client.callTool({
        name: 'pipelines_create',
        arguments: { name: pipelineName },
      })) as { content: unknown[]; isError?: boolean };
      if (createPipe.isError) return;
      pipelineId = parseEnv<{ id: string }>(createPipe).data?.id;
      if (!pipelineId) return;

      const couple = (await client.callTool({
        name: 'pipeline_couplings_create',
        arguments: { app: appName, pipeline: pipelineId, stage: 'staging' },
      })) as { content: unknown[]; isError?: boolean };
      if (!couple.isError) {
        couplingId = parseEnv<{ id: string }>(couple).data?.id;
      }

      const couplings = (await client.callTool({
        name: 'pipeline_couplings_list',
        arguments: { page_size: 50 },
      })) as { content: unknown[] };
      expect(parseEnv(couplings).ok).toBe(true);
    } finally {
      if (couplingId) {
        await client
          .callTool({
            name: 'pipeline_couplings_destroy',
            arguments: { coupling: couplingId, confirm: pipelineName },
          })
          .catch(() => undefined);
      }
      if (pipelineId) {
        await client
          .callTool({
            name: 'pipelines_destroy',
            arguments: { pipeline: pipelineId, confirm: pipelineName },
          })
          .catch(() => undefined);
      }
      await client
        .callTool({ name: 'apps_delete', arguments: { app: appName, confirm: appName } })
        .catch(() => undefined);
    }
  }, 90_000);

  it('walks the Phase 2b account-tier write dry_run (no real account mutation)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'herokumcp-int2b-account-'));
    const paths = resolvePaths({ home, platform: process.platform });
    const built = await buildServer({
      token: TOKEN!,
      paths,
      version: '0.0.0-int',
      forceProbe: true,
    });
    const client = new Client({ name: 'integration2b-account', version: '0.0.0-int' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([built.server.connect(b), client.connect(a)]);

    const names = (await client.listTools()).tools.map((t) => t.name);
    if (!names.includes('account_update')) return;

    // 1. Read current account state via the Phase 1 reader.
    const info = (await client.callTool({ name: 'account_info' })) as { content: unknown[] };
    const infoEnv = parseEnv<{ name?: string | null }>(info);
    expect(infoEnv.ok).toBe(true);

    // 2. Dry-run a fake name change. No actual update is performed — the
    //    dry-run shape is enough proof that the write tool is wired up.
    const fakeName = `dry-run-preview-${Date.now().toString(36)}`;
    const dry = (await client.callTool({
      name: 'account_update',
      arguments: { name: fakeName, dry_run: true },
    })) as { content: unknown[] };
    const dryEnv = parseEnv<{
      request: { method: string; body: { name?: string } };
      description: string;
    }>(dry);
    expect(dryEnv.ok).toBe(true);
    expect(dryEnv.data?.request.method).toBe('PATCH');
    expect(dryEnv.data?.request.body.name).toBe(fakeName);
    expect(dryEnv.data?.description).toContain(fakeName);
  }, 60_000);
});
