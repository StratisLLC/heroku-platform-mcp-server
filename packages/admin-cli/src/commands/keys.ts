/**
 * Master-key utilities.
 *
 * `gen`         — print a fresh base64-encoded 32B key (for env var injection).
 * `fingerprint` — print the SHA-256 fingerprint of an existing key.
 * `rotate-master` — stub for Phase 10; refuses with an explanatory message.
 */

import type { Command } from 'commander';
import { generateMasterKey, loadMasterKeyFromBase64, masterKeyFingerprint } from '@heroku-mcp/core';

export function registerKeysCommands(parent: Command): void {
  const keys = parent.command('keys').description('Master-key utilities.');

  keys
    .command('gen')
    .description('Print a fresh 32-byte master key (base64). Set HEROKUMCP_MASTER_KEY=<output>.')
    .action(() => {
      const k = generateMasterKey();
      process.stdout.write(`${Buffer.from(k).toString('base64')}\n`);
    });

  keys
    .command('fingerprint')
    .description('Print the SHA-256 fingerprint of HEROKUMCP_MASTER_KEY (or --key).')
    .option('--key <b64>', 'Master key as base64 (defaults to env).')
    .action((opts: { key?: string }) => {
      const raw = opts.key ?? process.env.HEROKUMCP_MASTER_KEY;
      if (!raw) {
        process.stderr.write('error: HEROKUMCP_MASTER_KEY not set, and no --key passed.\n');
        process.exit(2);
      }
      try {
        const k = loadMasterKeyFromBase64(raw);
        process.stdout.write(`${masterKeyFingerprint(k)}\n`);
      } catch (err) {
        process.stderr.write(`bad key: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  keys
    .command('rotate-master')
    .description('Rotate the master KEK (deferred to Phase 10).')
    .action(() => {
      process.stderr.write(
        'rotate-master is not implemented yet. Phase 10 will ship this safely. For now, replacing the master key invalidates all stored tokens — users must sign in again.\n',
      );
      process.exit(2);
    });
}
