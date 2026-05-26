/**
 * Tool registration coordinator.
 *
 * Diagnostic tools are always exposed. Tier-gated tools are registered only
 * when the capability probe matrix says the caller's token can reach the
 * relevant endpoints. `tools/list` therefore reflects what will actually work
 * — see ARCHITECTURE.md §5.4.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CapabilityResult } from '@heroku-mcp/core';
import { isDiagnosticOnly, tierAvailable } from '../capabilities.js';
import type { ToolContext } from '../context.js';
import { registerAccountTools } from './account.js';
import { registerAppsTools } from './apps.js';
import { registerDiagnosticTools } from './diagnostics.js';

/** Register every tool the current capability matrix authorises. */
export function registerAllTools(server: McpServer, ctx: ToolContext): RegistrationSummary {
  const capabilities: CapabilityResult = ctx.getCapabilities();

  registerDiagnosticTools(server, ctx);

  const summary: RegistrationSummary = {
    diagnostic: true,
    account: false,
    apps: false,
    diagnosticOnly: isDiagnosticOnly(capabilities),
  };

  // In diagnostic-only mode, suppress all tier tools — only the diagnostic
  // set is safe to run.
  if (summary.diagnosticOnly) return summary;

  if (tierAvailable(capabilities, 'account')) {
    registerAccountTools(server, ctx);
    summary.account = true;
  }
  if (tierAvailable(capabilities, 'apps')) {
    registerAppsTools(server, ctx);
    summary.apps = true;
  }
  return summary;
}

export interface RegistrationSummary {
  diagnostic: boolean;
  account: boolean;
  apps: boolean;
  /** True iff the account tier reported delinquent or suspended — only
   *  diagnostic tools were registered. */
  diagnosticOnly: boolean;
}
