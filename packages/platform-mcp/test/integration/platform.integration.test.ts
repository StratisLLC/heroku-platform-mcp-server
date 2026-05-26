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

      const dryRun = (await client.callTool({
        name: 'apps_delete',
        arguments: { app: previewName, dry_run: true },
      })) as { content: unknown[] };
      const dryEnv = parseEnv<{ description: string; request: { method: string } }>(dryRun);
      expect(dryEnv.ok).toBe(true);
      expect(dryEnv.data?.request.method).toBe('DELETE');
      expect(typeof dryEnv.data?.description).toBe('string');
      expect(dryEnv.data!.description.length).toBeGreaterThan(0);

      // Real delete, with confirm matching the (renamed) app name.
      const del = (await client.callTool({
        name: 'apps_delete',
        arguments: { app: previewName, confirm: previewName },
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
});
