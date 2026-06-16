/**
 * Library entry for `@heroku-mcp/admin-cli`. The CLI binary lives in `bin.ts`.
 */

import { Command } from 'commander';
import { registerUsersCommands } from './commands/users.js';
import { registerTokensCommands } from './commands/tokens.js';
import { registerAuditCommands } from './commands/audit.js';
import { registerStatusCommand } from './commands/status.js';
import { registerDbCommands } from './commands/db.js';
import { registerKeysCommands } from './commands/keys.js';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('herokumcp-admin')
    .description(
      'Admin CLI for the hosted Heroku MCP server. Operates against the same Postgres the HTTP server uses.',
    )
    .version('0.0.0');

  registerUsersCommands(program);
  registerTokensCommands(program);
  registerAuditCommands(program);
  registerStatusCommand(program);
  registerDbCommands(program);
  registerKeysCommands(program);
  return program;
}
