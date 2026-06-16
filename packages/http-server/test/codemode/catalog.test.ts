/**
 * Tier 1 unit tests — ToolCatalog index, schema projection, categorisation.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ToolCatalog,
  categoryOf,
  collectRegisteredTools,
  projectParameters,
} from '../../src/codemode/index.js';

const entries = [
  { name: 'apps_info', description: 'Return one app by id or name.' },
  { name: 'apps_list', description: 'List Heroku apps the user can access.' },
  { name: 'pg_info', description: 'Show Postgres database status and config.' },
  { name: 'kv_info', description: 'Show key-value store info.' },
  { name: 'kafka_info', description: 'Show Kafka cluster info.' },
  {
    name: 'config_vars_get',
    description: 'Return the config vars for an app, including database URLs.',
  },
];

function catalog(): ToolCatalog {
  return new ToolCatalog(entries);
}

describe('categoryOf', () => {
  it('maps by name prefix', () => {
    expect(categoryOf('pg_info')).toBe('postgres');
    expect(categoryOf('kv_list')).toBe('key-value');
    expect(categoryOf('kafka_topics_list')).toBe('kafka');
    expect(categoryOf('apps_info')).toBe('platform');
    expect(categoryOf('account_info')).toBe('platform');
  });
});

describe('ToolCatalog.search', () => {
  it('returns [] for an empty query', () => {
    expect(catalog().search('')).toEqual([]);
    expect(catalog().search('   ')).toEqual([]);
  });

  it('ranks exact name > prefix > name-contains > description-contains', () => {
    const c = new ToolCatalog([
      { name: 'app', description: 'x' },
      { name: 'apps_list', description: 'y' },
      { name: 'team_apps_list', description: 'z' },
      { name: 'config_vars_get', description: 'manage an app config' },
    ]);
    const names = c.search('app').map((e) => e.name);
    // exact 'app' first, then prefix 'apps_list', then contains 'team_apps_list',
    // then description-only 'config_vars_get'.
    expect(names).toEqual(['app', 'apps_list', 'team_apps_list', 'config_vars_get']);
  });

  it('is case-insensitive over name and description', () => {
    expect(
      catalog()
        .search('POSTGRES')
        .map((e) => e.name),
    ).toContain('pg_info');
    expect(
      catalog()
        .search('KAFKA')
        .map((e) => e.name),
    ).toContain('kafka_info');
  });

  it('matches description substrings', () => {
    // "database" only appears in descriptions.
    const names = catalog()
      .search('database')
      .map((e) => e.name);
    expect(names).toContain('pg_info');
    expect(names).toContain('config_vars_get');
  });

  it('filters by category', () => {
    const res = catalog().search('info', { category: 'postgres' });
    expect(res.map((e) => e.name)).toEqual(['pg_info']);
  });

  it('honours the limit', () => {
    const res = catalog().search('info', { limit: 2 });
    expect(res).toHaveLength(2);
  });

  it('produces deterministic ordering for equal scores', () => {
    const a = catalog()
      .search('info')
      .map((e) => e.name);
    const b = catalog()
      .search('info')
      .map((e) => e.name);
    expect(a).toEqual(b);
  });
});

describe('ToolCatalog.get / size', () => {
  it('looks up by exact name', () => {
    expect(catalog().get('pg_info')?.category).toBe('postgres');
  });
  it('returns undefined for a missing tool', () => {
    expect(catalog().get('nope')).toBeUndefined();
  });
  it('reports size', () => {
    expect(catalog().size()).toBe(entries.length);
  });
});

describe('projectParameters (Standard detail)', () => {
  it('projects name + type + required only, never descriptions', () => {
    const schema = z.object({
      app: z.string().describe('App id or name. Prefer UUID.'),
      page_size: z.number().int().optional().describe('Items per page.'),
      flag: z.boolean().optional(),
      tags: z.array(z.string()),
      filter: z.object({ id: z.array(z.string()) }),
      size: z.string().default('standard-1x'),
      kind: z.enum(['a', 'b']).optional(),
    });
    const params = projectParameters(schema);
    const byName = Object.fromEntries(params.map((p) => [p.name, p]));

    expect(byName.app).toEqual({ name: 'app', type: 'string', required: true });
    expect(byName.page_size).toEqual({ name: 'page_size', type: 'number', required: false });
    expect(byName.flag).toEqual({ name: 'flag', type: 'boolean', required: false });
    expect(byName.tags).toEqual({ name: 'tags', type: 'array', required: true });
    expect(byName.filter).toEqual({ name: 'filter', type: 'object', required: true });
    // ZodDefault is optional input (caller may omit).
    expect(byName.size).toEqual({ name: 'size', type: 'string', required: false });
    expect(byName.kind).toEqual({ name: 'kind', type: 'string', required: false });

    // No projected parameter leaks a description field.
    for (const p of params) {
      expect(Object.keys(p).sort()).toEqual(['name', 'required', 'type']);
    }
  });

  it('returns [] for no-input tools', () => {
    expect(projectParameters(undefined)).toEqual([]);
  });
});

describe('ToolCatalog.fromServer / collectRegisteredTools', () => {
  it('indexes the registered tools off a built McpServer', () => {
    const server = new McpServer({ name: 't', version: '0' }, { capabilities: { tools: {} } });
    server.registerTool(
      'apps_info',
      { description: 'app info', inputSchema: { app: z.string() } },
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    );
    server.registerTool('account_info', { description: 'account info' }, async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));

    const collected = collectRegisteredTools(server);
    expect(collected.has('apps_info')).toBe(true);
    expect(collected.has('account_info')).toBe(true);

    const c = ToolCatalog.fromServer(server);
    expect(c.size()).toBe(2);
    expect(c.get('apps_info')?.parameters).toEqual([
      { name: 'app', type: 'string', required: true },
    ]);
    expect(c.get('account_info')?.parameters).toEqual([]);
  });
});
