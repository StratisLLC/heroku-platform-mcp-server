/**
 * Code Mode tool catalog (Phase 9).
 *
 * Builds a searchable, token-lean index of the tools registered on a session's
 * MCP server, plus the dispatch map `execute` uses to invoke them. Both are
 * derived from the SAME fully-built per-session McpServer that `/mcp` would
 * connect to a transport — so the catalog reflects exactly the tools the user
 * is authorised for (capability probes already gated registration), and every
 * dispatch target is the same audit-wrapped handler a direct `/mcp` call hits.
 *
 * Detail level is "Standard" (Phase 9 decision): name + description + a
 * parameter list of `{ name, type, required }` only. No parameter descriptions,
 * no nested JSON Schema. That projection is the token optimisation.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Tool categories surfaced for search filtering. Derived from the tool-name
 *  prefix, which NAMING.md enforces per product tier (`pg_*`, `kv_*`,
 *  `kafka_*`, everything else Platform). */
export type ToolCategory = 'platform' | 'postgres' | 'key-value' | 'kafka';

/** One projected parameter: type + requiredness, no description. */
export interface ToolParameter {
  name: string;
  /** One of 'string' | 'number' | 'boolean' | 'array' | 'object'. */
  type: string;
  required: boolean;
}

/** A Standard-detail catalog entry. */
export interface ToolIndexEntry {
  name: string;
  description: string;
  parameters: ToolParameter[];
  category: ToolCategory;
}

/**
 * A dispatch target: the normalised Zod object schema (or undefined for
 * no-input tools) plus the registered, audit-wrapped handler. `execute`
 * validates args against `inputSchema` and then invokes `handler` exactly the
 * way the MCP SDK's CallTool path does.
 */
export interface DispatchTarget {
  /** Normalised ZodObject (has `.shape`), or undefined for no-input tools. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (...args: any[]) => unknown;
}

/** The minimal shape we read off each MCP-SDK `RegisteredTool`. */
interface RawRegisteredTool {
  description?: string;
  inputSchema?: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (...args: any[]) => unknown;
  enabled: boolean;
}

/**
 * Read the registered tools off a built McpServer.
 *
 * This is the single point in Code Mode that couples to an MCP-SDK internal
 * (`_registeredTools`). The codebase already monkey-patches `registerTool`
 * extensively (see mcp/setup.ts, mcp/audit-wrapper.ts), so reading the
 * companion private map here is consistent house style. Encapsulated in one
 * documented function so an SDK upgrade has a single place to fix.
 */
export function collectRegisteredTools(server: McpServer): Map<string, RawRegisteredTool> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
  const registry = (server as any)._registeredTools as
    | Record<string, RawRegisteredTool>
    | undefined;
  const out = new Map<string, RawRegisteredTool>();
  if (!registry) return out;
  for (const [name, tool] of Object.entries(registry)) {
    if (tool && tool.enabled !== false) out.set(name, tool);
  }
  return out;
}

/** Map a tool name to its product category by prefix (NAMING.md). */
export function categoryOf(name: string): ToolCategory {
  if (name.startsWith('pg_')) return 'postgres';
  if (name.startsWith('kv_')) return 'key-value';
  if (name.startsWith('kafka_')) return 'kafka';
  return 'platform';
}

const WRAPPERS = new Set(['ZodOptional', 'ZodDefault', 'ZodNullable']);

// The Zod-internal introspection below walks `_def` structurally — inherently
// `any`-typed. Disabled as a region (house style; cf. mcp/setup.ts).
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */

/** Unwrap optional/default/nullable wrappers to the underlying Zod type. */
function unwrap(t: any): any {
  let cur = t;
  while (cur?._def && WRAPPERS.has(cur._def.typeName)) {
    cur = cur._def.innerType;
  }
  return cur;
}

/** Project a Zod field to one of the Standard scalar type names. */
function fieldType(field: any): string {
  const inner = unwrap(field);
  const tn: string | undefined = inner?._def?.typeName;
  switch (tn) {
    case 'ZodString':
    case 'ZodEnum':
    case 'ZodNativeEnum':
      return 'string';
    case 'ZodNumber':
    case 'ZodBigInt':
      return 'number';
    case 'ZodBoolean':
      return 'boolean';
    case 'ZodArray':
    case 'ZodTuple':
      return 'array';
    case 'ZodObject':
    case 'ZodRecord':
      return 'object';
    case 'ZodLiteral': {
      const v = inner._def.value as unknown;
      const t = typeof v;
      return t === 'number' || t === 'boolean' ? t : 'string';
    }
    default:
      // Unions/intersections/unknowns: fall back to the broadest useful hint.
      return 'object';
  }
}

/**
 * Project a registered tool's normalised input schema into a Standard-detail
 * parameter list. Returns [] for no-input tools.
 */
export function projectParameters(inputSchema: any): ToolParameter[] {
  const shape = inputSchema?.shape as Record<string, unknown> | undefined;
  if (!shape) return [];
  const params: ToolParameter[] = [];
  for (const [name, field] of Object.entries(shape)) {
    params.push({
      name,
      type: fieldType(field),
      required:
        typeof (field as any)?.isOptional === 'function' ? !(field as any).isOptional() : true,
    });
  }
  return params;
}
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */

/**
 * The static, per-session tool catalog. Built once at session creation from the
 * fully-built MCP server; the registry doesn't change for the session's
 * lifetime, so the index never needs to update (Phase 9 decision: static).
 */
export class ToolCatalog {
  private readonly entries: ToolIndexEntry[] = [];
  private readonly byName = new Map<string, ToolIndexEntry>();

  constructor(
    tools: Iterable<{ name: string; description?: string | undefined; inputSchema?: unknown }>,
  ) {
    for (const tool of tools) {
      const entry: ToolIndexEntry = {
        name: tool.name,
        description: tool.description ?? '',
        parameters: projectParameters(tool.inputSchema),
        category: categoryOf(tool.name),
      };
      this.entries.push(entry);
      this.byName.set(entry.name, entry);
    }
    // Deterministic base order so equal-score results are stable.
    this.entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Build a catalog directly from a built McpServer. */
  static fromServer(server: McpServer): ToolCatalog {
    const collected = collectRegisteredTools(server);
    const tools = [...collected.entries()].map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return new ToolCatalog(tools);
  }

  /**
   * Substring search against name + description, case-insensitive. Ranked:
   *   1. exact name match              (1000)
   *   2. name starts with query        (500)
   *   3. name contains query           (200)
   *   4. description contains query    (50)
   * Optional `category` filter; `limit` caps results (default 20).
   */
  search(query: string, options?: { category?: ToolCategory; limit?: number }): ToolIndexEntry[] {
    const q = query.toLowerCase().trim();
    if (!q) return [];
    const limit = options?.limit ?? 20;
    const results: { entry: ToolIndexEntry; score: number; idx: number }[] = [];
    let idx = 0;
    for (const entry of this.entries) {
      idx += 1;
      if (options?.category && entry.category !== options.category) continue;
      const nameLower = entry.name.toLowerCase();
      const descLower = entry.description.toLowerCase();
      let score = 0;
      if (nameLower === q) score = 1000;
      else if (nameLower.startsWith(q)) score = 500;
      else if (nameLower.includes(q)) score = 200;
      else if (descLower.includes(q)) score = 50;
      if (score > 0) results.push({ entry, score, idx });
    }
    // Higher score first; ties broken by the deterministic base order.
    results.sort((a, b) => b.score - a.score || a.idx - b.idx);
    return results.slice(0, limit).map((r) => r.entry);
  }

  /** Exact lookup by tool name. */
  get(name: string): ToolIndexEntry | undefined {
    return this.byName.get(name);
  }

  /** Total number of indexed tools. */
  size(): number {
    return this.entries.length;
  }

  /** All entries (deterministic order). Used by the token benchmark. */
  all(): readonly ToolIndexEntry[] {
    return this.entries;
  }
}
