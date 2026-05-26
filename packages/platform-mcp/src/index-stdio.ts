/**
 * CLI entry point. Wires `buildServer()` to a stdio MCP transport.
 *
 * Why the high-level `McpServer` rather than the lower-level `Server` class:
 * `McpServer.registerTool(name, config, callback)` does JSON Schema generation
 * from Zod shapes, input validation, and content-shape normalisation for us,
 * and exposes `sendToolListChanged()` for the refresh notification we need
 * after re-probing. The lower-level `Server` would force us to reimplement
 * those for marginal flexibility; we'll switch only if Phase 2's destructive-
 * write idiom needs something the high-level API can't express.
 *
 * Token resolution order:
 *   1. `--token <value>` CLI flag
 *   2. `HEROKUMCP_TOKEN` env var
 *
 * On token failure the process exits with code 2 and a redacted message on
 * stderr (per ARCHITECTURE.md §9). No tokens are ever written to stdout —
 * stdout belongs to the MCP transport.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { scrubString } from '@heroku-mcp/core';
import { buildServer } from './server.js';

interface ParsedArgs {
  token?: string;
  help?: boolean;
  version?: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--token') {
      const next = argv[i + 1];
      if (next === undefined) continue;
      out.token = next;
      i += 1;
    } else if (arg?.startsWith('--token=')) {
      out.token = arg.slice('--token='.length);
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--version' || arg === '-v') {
      out.version = true;
    }
  }
  return out;
}

const HELP = `herokumcp-platform — Heroku Platform MCP server (stdio)

Usage:
  herokumcp-platform [--token <HRKU-...>] [--help] [--version]

Token resolution (first wins):
  --token <value>
  HEROKUMCP_TOKEN environment variable

Environment:
  HEROKUMCP_HOME        config + cache directory (default per OS, see README)
  HEROKUMCP_TOKEN       bearer token, alternative to --token

Exit codes:
  0  clean shutdown
  1  unexpected error
  2  invalid/missing token

Connect to this binary via MCP over stdio (stdin/stdout). All logs go to stderr.
`;

async function readPackageVersion(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // tsup emits dist/index-stdio.js; package.json is one directory up.
    const text = await readFile(join(here, '..', 'package.json'), { encoding: 'utf8' });
    const parsed = JSON.parse(text) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function logError(message: string): void {
  // Stdout is owned by the MCP transport; everything user-visible goes to stderr.
  process.stderr.write(`${scrubString(message)}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const version = await readPackageVersion();

  if (args.help) {
    process.stderr.write(HELP);
    process.exit(0);
  }
  if (args.version) {
    process.stderr.write(`${version}\n`);
    process.exit(0);
  }

  const token = args.token ?? process.env.HEROKUMCP_TOKEN;
  if (!token) {
    logError(
      'No Heroku token provided. Set HEROKUMCP_TOKEN or pass --token. See `herokumcp-platform --help`.',
    );
    process.exit(2);
  }
  if (!/^HRKU-/i.test(token)) {
    logError(
      'Token does not look like a Heroku API token (expected prefix "HRKU-"). Refusing to start; if your token is unusual, double-check it is correct.',
    );
    process.exit(2);
  }

  let built;
  try {
    built = await buildServer({ token, version });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`Startup failed: ${message}`);
    process.exit(1);
  }

  const { server, registration, capabilities } = built;
  // Single line on stderr so an operator restarting Claude Desktop can see
  // immediately what lit up; redacted in case any tier name contained user data
  // (it doesn't today, but the redactor is cheap and defensive).
  const tiers = Object.entries(capabilities.tiers)
    .map(([name, value]) => {
      if (name === 'data') return null;
      const tier = value as { available?: boolean };
      return tier.available ? name : null;
    })
    .filter((s): s is string => s !== null);
  logError(
    `[herokumcp-platform v${version}] ready. Tiers available: [${tiers.join(', ') || 'none'}]. ` +
      `Tools registered: diagnostic=${registration.diagnostic ? 'yes' : 'no'}, ` +
      `account=${registration.account ? 'yes' : 'no'}, apps=${registration.apps ? 'yes' : 'no'}` +
      (registration.diagnosticOnly ? ' (diagnostic-only mode)' : ''),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = (signal: string): void => {
    logError(`Received ${signal}, shutting down.`);
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logError(`Fatal: ${message}`);
  process.exit(1);
});
