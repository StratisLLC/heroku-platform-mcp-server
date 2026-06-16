/**
 * Code Mode meta-tools (Phase 9): `search`, `execute`, `auth_status`.
 *
 * These three are the ONLY tools advertised on `/mcp-codemode`. They form a
 * discovery layer over the full tool catalog:
 *   - `search`      — find tools by substring match (Standard detail).
 *   - `execute`     — invoke a tool by name through the SAME audit-wrapped,
 *                     confirm-guarded, validated handler a direct `/mcp` call
 *                     hits. Not a new execution path.
 *   - `auth_status` — session identity + access scope.
 *
 * The handlers close over a {@link CodemodeContext} built per session.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HerokuClient, CapabilityResult, ToolResult } from '@heroku-mcp/core';
import { envelopeFromLocal, toolContent } from '@heroku-mcp/core';
import type { ToolErrorEnvelope } from '@heroku-mcp/core';
import type { ToolCatalog } from './index.js';
import { type DispatchTarget, type ToolIndexEntry, type ToolCategory } from './index.js';

/** Per-session context the meta-tools close over. */
export interface CodemodeContext {
  /** Searchable index of the session's authorised tools. */
  catalog: ToolCatalog;
  /** name → { inputSchema, audit-wrapped handler } for `execute`. */
  dispatch: Map<string, DispatchTarget>;
  /** Authenticated identity for `auth_status`. */
  identity: { email: string };
  /** Live Heroku client for `auth_status` teams/orgs lookups. */
  client: HerokuClient;
  /** Capability snapshot → access "scopes" for `auth_status`. */
  getCapabilities: () => CapabilityResult;
}

const CATEGORIES = ['platform', 'postgres', 'key-value', 'kafka'] as const;

/** A Standard-detail search hit as serialised to the model. */
function formatEntry(e: ToolIndexEntry): {
  name: string;
  category: ToolCategory;
  description: string;
  parameters: { name: string; type: string; required: boolean }[];
} {
  return {
    name: e.name,
    category: e.category,
    description: e.description,
    parameters: e.parameters,
  };
}

/** Wrap an envelope as a successful CallToolResult. */
function okResult(data: unknown): ToolResult {
  return { content: toolContent(envelopeFromLocal(data)) };
}

/** Wrap a typed error envelope as an `isError` CallToolResult. */
function errResult(error: ToolErrorEnvelope['error']): ToolResult {
  const env: ToolErrorEnvelope = { ok: false, error };
  return { content: toolContent(env), isError: true };
}

/**
 * Build the dispatch map (`execute` target table) from a built MCP server's
 * registered tools. Each handler is the audit-wrapped one a direct call hits.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
export function buildDispatchMap(
  collected: Iterable<[string, { inputSchema?: any; handler: (...args: any[]) => unknown }]>,
): Map<string, DispatchTarget> {
  const map = new Map<string, DispatchTarget>();
  for (const [name, t] of collected) {
    map.set(name, { inputSchema: t.inputSchema, handler: t.handler });
  }
  return map;
}

/**
 * Dispatch a single tool exactly as the MCP SDK's CallTool path would:
 * validate args against the tool's input schema, then invoke the registered
 * handler. Mirrors `McpServer.validateToolInput` + `executeToolHandler`
 * (sdk/server/mcp.js) so audit, confirm, dry-run and envelopes are identical
 * to a direct `/mcp` invocation.
 */
async function dispatchTool(
  target: DispatchTarget,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // A fresh abort signal mirrors the per-request `extra` the SDK passes; no
  // tool handler in this codebase reads `extra`, but we provide a faithful one.
  const extra = { signal: new AbortController().signal };

  if (target.inputSchema) {
    const parsed = await target.inputSchema.safeParseAsync(args);
    if (!parsed.success) {
      const issues = parsed.error?.issues ?? [];
      return errResult({
        kind: 'invalid_params',
        message: `Invalid arguments for tool "${name}". Use search() to inspect its parameters.`,
        details: {
          fields: issues.map((i: { path?: unknown[]; message?: string }) => ({
            path: Array.isArray(i.path) ? i.path.join('.') : '',
            message: i.message ?? 'invalid',
          })),
        },
      });
    }
    return (await target.handler(parsed.data, extra)) as ToolResult;
  }
  // No-input tool: the SDK calls handler(extra).
  return (await target.handler(extra)) as ToolResult;
}
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */

/**
 * Register `search`, `execute` and `auth_status` onto the given (meta) MCP
 * server. This server is deliberately NOT audit-wrapped: `execute` delegates
 * to the full server's already-audited handler, so the real tool name + args
 * land in the audit log — adding a second "execute" row would diverge from
 * direct-invocation behaviour.
 */
export function registerCodemodeMetaTools(server: McpServer, ctx: CodemodeContext): void {
  server.registerTool(
    'search',
    {
      title: 'Search tools',
      description:
        'Search the Heroku tool catalog by substring match against tool name and description (case-insensitive). Returns matching tools with their parameter lists (name, type, required). Use this to discover what tools exist, then call execute() to run one.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe('Substring to match against tool name and description (case-insensitive).'),
        category: z
          .enum(CATEGORIES)
          .optional()
          .describe('Restrict to one tool category. Omit to search all categories.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .describe('Maximum results to return (default 20).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ query, category, limit }) => {
      const opts: { category?: ToolCategory; limit?: number } = {};
      if (category !== undefined) opts.category = category;
      if (limit !== undefined) opts.limit = limit;
      const results = ctx.catalog.search(query, opts);
      return okResult({
        query,
        ...(category !== undefined ? { category } : {}),
        total: results.length,
        catalog_size: ctx.catalog.size(),
        results: results.map(formatEntry),
      });
    },
  );

  server.registerTool(
    'execute',
    {
      title: 'Execute a tool',
      description:
        "Invoke a tool by name with arguments. The args object must match the tool's parameter schema (use search() to discover names and parameters). Runs through the same auth, audit, confirmation and validation pipeline as a direct tool call — destructive tools still require their confirm value, dry_run still works.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe('Exact tool name as returned by search() (e.g. "apps_info", "pg_info").'),
        args: z
          .record(z.unknown())
          .default({})
          .describe(
            "Arguments object matching the tool's parameter schema. Use {} for no-arg tools.",
          ),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ name, args }) => {
      const target = ctx.dispatch.get(name);
      if (!target) {
        return errResult({
          kind: 'not_found',
          message: `Unknown tool "${name}". Use search() to find available tools.`,
        });
      }
      return dispatchTool(target, name, args ?? {});
    },
  );

  server.registerTool(
    'auth_status',
    {
      title: 'Authentication status',
      description:
        "Get the current session's authentication state, identity, and access scope (email, capability scopes, Heroku teams, and enterprise orgs). Use this to know what's available before searching for tools.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const scopes = summarizeScopes(ctx.getCapabilities());
      const [teams, orgs] = await Promise.all([listTeams(ctx.client), listOrgs(ctx.client)]);
      return okResult({
        authenticated: true,
        email: ctx.identity.email,
        scopes,
        teams,
        orgs,
      });
    },
  );
}

/** Project the capability matrix into a flat list of available access scopes.
 *  These are tool-access tiers we can prove from the probe pass — not OAuth
 *  scopes (which this server does not persist; see Phase 0 gate §4). */
export function summarizeScopes(caps: CapabilityResult): string[] {
  const out: string[] = [];
  for (const [tier, value] of Object.entries(caps.tiers)) {
    if (isTierResult(value)) {
      if (value.available) out.push(tier);
    } else {
      // Nested group (e.g. `data.postgres`, `data.kafka`).
      for (const [sub, res] of Object.entries(value)) {
        if (isTierResult(res) && res.available) out.push(`${tier}.${sub}`);
      }
    }
  }
  return out.sort();
}

function isTierResult(v: unknown): v is { available: boolean } {
  return typeof v === 'object' && v !== null && 'available' in v;
}

interface HerokuNamed {
  id?: unknown;
  name?: unknown;
}

/** GET /teams → [{id, name}]. Empty on any failure (no team access etc.). */
async function listTeams(client: HerokuClient): Promise<{ id: string; name: string }[]> {
  try {
    const res = await client.get<HerokuNamed[]>('/teams', {
      tool: 'auth_status',
      headers: { Range: 'id ..; max=1000' },
    });
    return (res.body ?? []).map(projectNamed);
  } catch {
    return [];
  }
}

/** GET /enterprise-accounts → [{id, name}]. Empty on 403 / no enterprise. */
async function listOrgs(client: HerokuClient): Promise<{ id: string; name: string }[]> {
  try {
    const res = await client.get<HerokuNamed[]>('/enterprise-accounts', {
      tool: 'auth_status',
      headers: { Range: 'id ..; max=1000' },
    });
    return (res.body ?? []).map(projectNamed);
  } catch {
    return [];
  }
}

function projectNamed(r: HerokuNamed): { id: string; name: string } {
  return {
    id: typeof r.id === 'string' ? r.id : '',
    name: typeof r.name === 'string' ? r.name : '',
  };
}
