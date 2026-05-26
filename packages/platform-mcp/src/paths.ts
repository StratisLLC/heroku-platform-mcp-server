/**
 * Filesystem path resolution for the platform MCP (ARCHITECTURE.md §14, NAMING.md §2).
 *
 * Everything the server writes lives under `$HEROKUMCP_HOME`, which defaults
 * per-OS:
 *   - macOS: `~/Library/Application Support/herokumcp`
 *   - Windows: `%APPDATA%\herokumcp`
 *   - Linux: `$XDG_CONFIG_HOME/herokumcp` (else `~/.config/herokumcp`)
 *
 * Resolution lives here rather than in the entrypoint so unit tests can build
 * scratch directories and exercise the path layout without touching `process.env`.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Layout of paths under `$HEROKUMCP_HOME`. */
export interface ResolvedPaths {
  /** Root directory; everything else nests under this. */
  home: string;
  /** Directory for capability probe result files. */
  capabilitiesDir: string;
  /** Path to a single capability result file for a token fingerprint. */
  capabilityFile: (fingerprint: string) => string;
  /** Directory the audit logger writes JSONL files into. */
  auditDir: string;
  /** Path to the cached Heroku JSON schema. */
  schemaCachePath: string;
}

/** Inputs to {@link resolvePaths}. Both fields default from process state but
 *  may be overridden by tests or by callers building paths for a different
 *  installation. */
export interface ResolvePathsInput {
  /** Explicit override for `$HEROKUMCP_HOME`. */
  home?: string | undefined;
  /** Platform string (defaults to `process.platform`). */
  platform?: NodeJS.Platform;
  /** Snapshot of relevant environment variables. */
  env?: NodeJS.ProcessEnv;
  /** Override for the user's home directory (defaults to {@link homedir}). */
  homedirFn?: () => string;
}

/** Resolve the on-disk layout the server will read and write. */
export function resolvePaths(input: ResolvePathsInput = {}): ResolvedPaths {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const home = input.home ?? env.HEROKUMCP_HOME ?? defaultHome(platform, env, input.homedirFn);
  const capabilitiesDir = join(home, 'capabilities');
  const auditDir = join(home, 'audit');
  const schemaCachePath = join(home, 'schema-cache.json');

  return {
    home,
    capabilitiesDir,
    capabilityFile: (fingerprint) => join(capabilitiesDir, `${fingerprint}.json`),
    auditDir,
    schemaCachePath,
  };
}

function defaultHome(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homedirFn?: () => string,
): string {
  const home = homedirFn ? homedirFn() : homedir();
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'herokumcp');
  }
  if (platform === 'win32') {
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return join(appData, 'herokumcp');
  }
  const xdg = env.XDG_CONFIG_HOME ?? join(home, '.config');
  return join(xdg, 'herokumcp');
}
