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
import { registerAccountWriteTools } from './account-writes.js';
import { registerAppsTools } from './apps.js';
import { registerAppsWriteTools } from './apps-writes.js';
import { registerCollabWriteTools } from './collab-writes.js';
import { registerConfigWriteTools } from './config-writes.js';
import { registerDiagnosticTools } from './diagnostics.js';
import { registerDomainsWriteTools } from './domains-writes.js';
import { registerFormationWriteTools } from './formation-writes.js';
import { registerLogsWriteTools } from './logs-writes.js';
import { registerReleasesWriteTools } from './releases-writes.js';
import { registerReviewAppsWriteTools } from './review-apps-writes.js';
import { registerTeamsTools } from './teams.js';
import { registerTeamsWriteTools } from './teams-writes.js';
import { registerWebhooksWriteTools } from './webhooks-writes.js';

/** Register every tool the current capability matrix authorises. */
export function registerAllTools(server: McpServer, ctx: ToolContext): RegistrationSummary {
  const capabilities: CapabilityResult = ctx.getCapabilities();

  registerDiagnosticTools(server, ctx);

  const summary: RegistrationSummary = {
    diagnostic: true,
    account: false,
    accountWrites: false,
    apps: false,
    appsWrites: false,
    teams: false,
    teamsWrites: false,
    diagnosticOnly: isDiagnosticOnly(capabilities),
  };

  // In diagnostic-only mode, suppress all tier tools — only the diagnostic
  // set is safe to run.
  if (summary.diagnosticOnly) return summary;

  if (tierAvailable(capabilities, 'account')) {
    registerAccountTools(server, ctx);
    // Phase 2b — account-tier writes. Gated on the same probe as reads; a
    // call may still 403 on specific endpoints (e.g. SSO-mandated accounts),
    // which is surfaced as a typical ForbiddenError envelope.
    registerAccountWriteTools(server, ctx);
    summary.account = true;
    summary.accountWrites = true;
  }
  if (tierAvailable(capabilities, 'apps')) {
    registerAppsTools(server, ctx);
    // Phase 2a — apps-tier writes.
    registerAppsWriteTools(server, ctx);
    registerConfigWriteTools(server, ctx);
    registerFormationWriteTools(server, ctx);
    registerReleasesWriteTools(server, ctx);
    registerDomainsWriteTools(server, ctx);
    registerLogsWriteTools(server, ctx);
    registerWebhooksWriteTools(server, ctx);
    registerCollabWriteTools(server, ctx);
    registerReviewAppsWriteTools(server, ctx);
    summary.apps = true;
    summary.appsWrites = true;
  }
  if (tierAvailable(capabilities, 'teams')) {
    // Phase 2b — teams tier reads and writes light up together. An empty
    // /teams response (200 []) still satisfies the probe per Phase 2b
    // Decision 7; individual team tools 404 cleanly if a nonexistent team is
    // supplied.
    registerTeamsTools(server, ctx);
    registerTeamsWriteTools(server, ctx);
    summary.teams = true;
    summary.teamsWrites = true;
  }
  return summary;
}

export interface RegistrationSummary {
  diagnostic: boolean;
  account: boolean;
  /** True iff Phase 2b account-tier write tools were registered. */
  accountWrites: boolean;
  apps: boolean;
  /** True iff Phase 2a apps-tier write tools were registered. */
  appsWrites: boolean;
  /** True iff Phase 2b teams-tier read tools were registered. */
  teams: boolean;
  /** True iff Phase 2b teams-tier write tools were registered. */
  teamsWrites: boolean;
  /** True iff the account tier reported delinquent or suspended — only
   *  diagnostic tools were registered. */
  diagnosticOnly: boolean;
}
