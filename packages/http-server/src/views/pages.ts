/**
 * Every server-rendered page. Each export returns a full HTML document string.
 */

import { html, layout, raw, type SafeHtml } from './layout.js';
import type { AuditEntryRow } from '../db/repos/audit-log.js';
import type { ConnectionTokenRow } from '../db/repos/connection-tokens.js';
import type { OAuthClientRow } from '../db/repos/oauth-clients.js';
import type { UserRow } from '../db/repos/users.js';

export interface ViewerCtx {
  signedIn: boolean;
  admin: boolean;
  currentPath: string;
  publicUrl?: string;
}

export function renderLanding(ctx: ViewerCtx, signedInEmail?: string): string {
  const greeting = signedInEmail
    ? html`<p>Signed in as <code>${signedInEmail}</code>. Visit <a href="/me">/me</a>.</p>`
    : html`<p>Sign in with your Heroku account to get a personal MCP connection token.</p>`;
  return layout(
    { title: 'Welcome', signedIn: ctx.signedIn, admin: ctx.admin, currentPath: ctx.currentPath },
    html`
      <div class="card">
        <h2>Heroku MCP — hosted</h2>
        <p>
          This is a self-hosted Model Context Protocol server that exposes the Heroku Platform API
          to MCP-aware AI clients (Claude Desktop, Claude Code) running on your laptop.
        </p>
        ${greeting}
        <p style="margin-top:14px">
          ${ctx.signedIn
            ? html`<a class="btn btn-primary" href="/me">My account</a>`
            : html`<a class="btn btn-primary" href="/sign-in">Sign in with Heroku</a>`}
        </p>
      </div>
      <div class="card">
        <h2>How it works</h2>
        <ol>
          <li>Sign in with your Heroku account (OAuth).</li>
          <li>The server stores your encrypted OAuth tokens.</li>
          <li>You get a connection token starting with <code>hmcp_</code>.</li>
          <li>
            Paste it into your Claude Desktop config; Claude talks to this server, which talks to
            Heroku as you.
          </li>
        </ol>
      </div>
    `,
  );
}

export function renderSignInRedirecting(ctx: ViewerCtx, redirectUrl: string): string {
  return layout(
    {
      title: 'Sign in',
      signedIn: ctx.signedIn,
      admin: ctx.admin,
      currentPath: ctx.currentPath,
    },
    html`
      <div class="card">
        <h2>Redirecting to Heroku…</h2>
        <p>If you are not redirected, <a href="${redirectUrl}">click here</a>.</p>
      </div>
    `,
  );
}

export interface AccessDeniedView {
  email: string;
  herokuId: string;
  teams: string[];
  reason: string;
  allowedEmailsMasked: string[] | null;
  allowedTeams: string[] | null;
  adminContact: string;
}

export function renderAccessDenied(ctx: ViewerCtx, v: AccessDeniedView): string {
  const teamsLine = v.allowedTeams
    ? html`<li>Members of: ${v.allowedTeams.map((t) => html`<code>${t}</code> `)}</li>`
    : null;
  const emailsLine = v.allowedEmailsMasked
    ? html`<li>Email addresses: ${v.allowedEmailsMasked.map((e) => html`<code>${e}</code> `)}</li>`
    : null;
  return layout(
    {
      title: 'Access denied',
      signedIn: false,
      admin: false,
      currentPath: ctx.currentPath,
    },
    html`
      <div class="error-panel">
        <h2 style="margin-top:0">Access denied</h2>
        <p>This MCP deployment is restricted to:</p>
        <ul>
          ${teamsLine}${emailsLine}
        </ul>
        <div class="deny-id">
          <strong>Your sign-in identity:</strong>
          <dl class="kv">
            <dt>Email</dt>
            <dd><code>${v.email}</code></dd>
            <dt>Heroku ID</dt>
            <dd><code>${v.herokuId}</code></dd>
            <dt>Teams</dt>
            <dd>
              ${v.teams.length === 0
                ? html`<em>none</em>`
                : v.teams.map((t) => html`<code>${t}</code> `)}
            </dd>
          </dl>
        </div>
        <p><strong>Reason:</strong> ${v.reason}</p>
        <p>If you believe you should have access, contact: <code>${v.adminContact}</code>.</p>
      </div>
    `,
  );
}

export interface MePageView {
  user: UserRow;
  publicUrl: string;
  /** Plaintext token. Only set on first display after sign-in or token reset. */
  newToken?: string | null;
  tokens: ConnectionTokenRow[];
  /** OAuth-DCR clients (Claude Desktop, etc.) bound to this user. */
  clients?: OAuthClientRow[];
}

export function renderMe(ctx: ViewerCtx, v: MePageView): string {
  const baseUrl = ctx.publicUrl ?? v.publicUrl;
  const newTokenBlock = v.newToken
    ? html`
        <div class="success-panel">
          <h2 style="margin-top:0">Your connection token</h2>
          <p>
            Copy this now — it is shown <strong>once only</strong>. We store a hash, not the
            plaintext, so we cannot show it again.
          </p>
          <div class="token-box">
            <button class="copy" data-target="#token-plain">Copy</button>
            <span id="token-plain">${v.newToken}</span>
          </div>
          <h3 style="margin-top:18px;font-size:14px">Claude Desktop config snippet</h3>
          <div class="token-box">
            <button class="copy" data-target="#claude-snippet">Copy</button>
            <span id="claude-snippet">${claudeDesktopSnippet(baseUrl, v.newToken)}</span>
          </div>
        </div>
      `
    : null;

  return layout(
    {
      title: 'My account',
      signedIn: ctx.signedIn,
      admin: ctx.admin,
      currentPath: ctx.currentPath,
    },
    html`
      ${newTokenBlock}
      <div class="card">
        <h2>Account</h2>
        <dl class="kv">
          <dt>Email</dt><dd><code>${v.user.email}</code></dd>
          <dt>Heroku ID</dt><dd><code>${v.user.herokuId}</code></dd>
          <dt>Default team</dt><dd>${v.user.defaultTeam ?? html`<em>none</em>`}</dd>
          <dt>Signed in</dt><dd>${v.user.signedInAt.toISOString()}</dd>
        </dl>
        <p style="margin-top:18px">
          <form class="inline" method="post" action="/me/sign-out-everywhere">
            <button class="btn btn-danger" type="submit"
              onclick="return confirm('Revoke ALL of your connection tokens? Every Claude client you use will need a new token.')">
              Sign out everywhere (revoke all tokens)
            </button>
          </form>
        </p>
      </div>
      <div class="card">
        <h2>Active connection tokens</h2>
        ${
          v.tokens.length === 0
            ? html`<p class="muted">No active tokens.</p>`
            : renderTokenTable(v.tokens, '/me/tokens')
        }
      </div>
    `,
  );
}

export interface AuditPageView {
  rows: AuditEntryRow[];
  total: number;
  page: number;
  perPage: number;
  filters: AuditFilters;
  exportHref: string;
  selfPruneHref?: string;
  baseHref: string;
}

export interface AuditFilters {
  tool?: string;
  status?: 'ok' | 'error' | 'rejected';
  since?: string;
  until?: string;
}

export function renderAudit(ctx: ViewerCtx, v: AuditPageView, title = 'My audit log'): string {
  const hasNext = v.page * v.perPage < v.total;
  const hasPrev = v.page > 1;
  return layout(
    { title, signedIn: ctx.signedIn, admin: ctx.admin, currentPath: ctx.currentPath },
    html`
      <div class="card">
        <h2>${title}</h2>
        <form class="filters" method="get" action="${v.baseHref}">
          <div>
            <label>Tool</label>
            <input name="tool" value="${v.filters.tool ?? ''}" placeholder="apps_list" />
          </div>
          <div>
            <label>Status</label>
            <select name="status">
              <option value="">all</option>
              <option value="ok" ${v.filters.status === 'ok' ? 'selected' : ''}>ok</option>
              <option value="error" ${v.filters.status === 'error' ? 'selected' : ''}>error</option>
              <option value="rejected" ${v.filters.status === 'rejected' ? 'selected' : ''}>
                rejected
              </option>
            </select>
          </div>
          <div>
            <label>Since (ISO)</label>
            <input name="since" value="${v.filters.since ?? ''}" placeholder="2026-05-01" />
          </div>
          <div>
            <label>Until (ISO)</label>
            <input name="until" value="${v.filters.until ?? ''}" placeholder="2026-06-01" />
          </div>
          <div>
            <button class="btn btn-small" type="submit">Filter</button>
            <a class="btn btn-small" href="${v.exportHref}">Export CSV</a>
          </div>
        </form>
        ${v.selfPruneHref
          ? html`<form
              method="post"
              action="${v.selfPruneHref}"
              class="inline"
              style="margin-bottom:10px"
            >
              <label class="muted">
                Delete your entries older than
                <input type="number" name="days" value="30" min="1" max="3650" style="width:60px" />
                days
              </label>
              <button
                class="btn btn-small"
                type="submit"
                onclick="return confirm('Delete your own audit entries older than this cutoff?')"
              >
                Prune
              </button>
            </form>`
          : null}
        <table>
          <thead>
            <tr>
              <th>Occurred</th>
              <th>Category</th>
              <th>Event</th>
              <th>Status</th>
              <th>Duration</th>
              <th>Client</th>
              <th>Request id</th>
            </tr>
          </thead>
          <tbody>
            ${v.rows.length === 0
              ? html`<tr>
                  <td colspan="7" class="muted">No entries match.</td>
                </tr>`
              : v.rows.map(
                  (r) => html`
                    <tr>
                      <td>${r.occurredAt.toISOString()}</td>
                      <td>${r.category}</td>
                      <td><code>${r.eventName}</code></td>
                      <td><span class="badge badge-${r.status}">${r.status}</span></td>
                      <td>${r.durationMs ?? ''}</td>
                      <td>${r.clientName ?? ''}${r.clientVersion ? ` ${r.clientVersion}` : ''}</td>
                      <td><code>${r.requestId ?? ''}</code></td>
                    </tr>
                  `,
                )}
          </tbody>
        </table>
        <div class="pagination">
          <span class="muted">${v.total} entries · page ${v.page}</span>
          ${hasPrev
            ? html`<a class="btn btn-small" href="${pagedHref(v.baseHref, v.filters, v.page - 1)}"
                >‹ Prev</a
              >`
            : null}
          ${hasNext
            ? html`<a class="btn btn-small" href="${pagedHref(v.baseHref, v.filters, v.page + 1)}"
                >Next ›</a
              >`
            : null}
        </div>
      </div>
    `,
  );
}

export interface AdminUsersView {
  rows: {
    user: UserRow;
    activeTokenCount: number;
  }[];
}

export function renderAdminUsers(ctx: ViewerCtx, v: AdminUsersView): string {
  return layout(
    { title: 'Users', signedIn: true, admin: true, currentPath: ctx.currentPath },
    html`
      <div class="card">
        <h2>Users (${v.rows.length})</h2>
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Heroku ID</th>
              <th>Signed in</th>
              <th>Last seen</th>
              <th>Active tokens</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${v.rows.length === 0
              ? html`<tr>
                  <td colspan="6" class="muted">No users yet.</td>
                </tr>`
              : v.rows.map(
                  ({ user, activeTokenCount }) => html`
                    <tr>
                      <td><code>${user.email}</code></td>
                      <td><code>${user.herokuId}</code></td>
                      <td>${user.signedInAt.toISOString()}</td>
                      <td>${user.lastSeenAt.toISOString()}</td>
                      <td>${activeTokenCount}</td>
                      <td>
                        <form
                          class="inline"
                          method="post"
                          action="/admin/users/${user.id}/revoke-all"
                        >
                          <button
                            class="btn btn-small btn-danger"
                            type="submit"
                            onclick="return confirm('Revoke all tokens for ${user.email}?')"
                          >
                            Revoke all tokens
                          </button>
                        </form>
                      </td>
                    </tr>
                  `,
                )}
          </tbody>
        </table>
      </div>
    `,
  );
}

export interface AdminTokensView {
  rows: {
    token: ConnectionTokenRow;
    userEmail: string;
  }[];
}

export function renderAdminTokens(ctx: ViewerCtx, v: AdminTokensView): string {
  return layout(
    { title: 'Tokens', signedIn: true, admin: true, currentPath: ctx.currentPath },
    html`
      <div class="card">
        <h2>Connection tokens</h2>
        <p class="muted">Showing the most recently issued tokens, including revoked ones.</p>
        <table>
          <thead>
            <tr>
              <th>Token id</th>
              <th>User</th>
              <th>Label</th>
              <th>Issued</th>
              <th>Last used</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${v.rows.map(
              ({ token, userEmail }) => html`
                <tr>
                  <td><code>${token.id.slice(0, 8)}…</code></td>
                  <td><code>${userEmail}</code></td>
                  <td>${token.label ?? ''}</td>
                  <td>${token.issuedAt.toISOString()}</td>
                  <td>${token.lastUsedAt ? token.lastUsedAt.toISOString() : ''}</td>
                  <td>
                    ${token.revokedAt
                      ? html`<span class="badge badge-rejected">revoked</span>`
                      : html`<span class="badge badge-ok">active</span>`}
                  </td>
                  <td>
                    ${token.revokedAt
                      ? null
                      : html`<form
                          class="inline"
                          method="post"
                          action="/admin/tokens/${token.id}/revoke"
                        >
                          <button
                            class="btn btn-small btn-danger"
                            type="submit"
                            onclick="return confirm('Revoke this token?')"
                          >
                            Revoke
                          </button>
                        </form>`}
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    `,
  );
}

export interface AdminStatusView {
  herokuApiReachable: boolean;
  dbReachable: boolean;
  activeTokens: number;
  recentErrors: number;
  masterKeyFingerprint: string;
  appliedMigrations: string[];
}

export function renderAdminStatus(ctx: ViewerCtx, v: AdminStatusView): string {
  return layout(
    { title: 'Status', signedIn: true, admin: true, currentPath: ctx.currentPath },
    html`
      <div class="card">
        <h2>Deployment status</h2>
        <dl class="kv">
          <dt>Heroku API</dt>
          <dd>
            ${v.herokuApiReachable
              ? html`<span class="badge badge-ok">reachable</span>`
              : html`<span class="badge badge-error">unreachable</span>`}
          </dd>
          <dt>Postgres</dt>
          <dd>
            ${v.dbReachable
              ? html`<span class="badge badge-ok">reachable</span>`
              : html`<span class="badge badge-error">unreachable</span>`}
          </dd>
          <dt>Active connection tokens</dt>
          <dd>${v.activeTokens}</dd>
          <dt>Errors in last 24h</dt>
          <dd>${v.recentErrors}</dd>
          <dt>Master key fingerprint</dt>
          <dd>
            <code>${v.masterKeyFingerprint}</code> (SHA-256 of the key, first 8 chars — never the
            key itself)
          </dd>
          <dt>Applied migrations</dt>
          <dd>
            ${v.appliedMigrations.length === 0
              ? html`<em>none</em>`
              : v.appliedMigrations.map((f) => html`<code>${f}</code> `)}
          </dd>
        </dl>
      </div>
      <div class="card">
        <h2>Important</h2>
        <p>
          If the master key (<code>HEROKUMCP_MASTER_KEY</code>) is lost or replaced incorrectly, all
          stored Heroku tokens become unreadable and every user must sign in again. There is no
          recovery path — the encryption is intentionally one-way without the key.
        </p>
      </div>
    `,
  );
}

export interface AdminConfigView {
  env: Record<string, string | undefined>;
}

export function renderAdminConfig(ctx: ViewerCtx, v: AdminConfigView): string {
  const rows = Object.entries(v.env).map(
    ([k, value]) => html`
      <tr>
        <td><code>${k}</code></td>
        <td>
          ${value === undefined ? html`<em class="muted">unset</em>` : html`<code>${value}</code>`}
        </td>
      </tr>
    `,
  );
  return layout(
    { title: 'Config', signedIn: true, admin: true, currentPath: ctx.currentPath },
    html`
      <div class="card">
        <h2>Effective configuration</h2>
        <p class="muted">Secrets are masked. Set/change via <code>heroku config:set</code>.</p>
        <table>
          <thead>
            <tr>
              <th>Variable</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    `,
  );
}

export function renderSimpleError(ctx: ViewerCtx, title: string, body: string): string {
  return layout(
    { title, signedIn: ctx.signedIn, admin: ctx.admin, currentPath: ctx.currentPath },
    html`
      <div class="error-panel">
        <h2 style="margin-top:0">${title}</h2>
        <p>${body}</p>
        <p><a class="btn" href="/">Back to home</a></p>
      </div>
    `,
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function renderTokenTable(rows: ConnectionTokenRow[], _basePath: string): SafeHtml {
  return html`
    <table>
      <thead>
        <tr>
          <th>Token id</th>
          <th>Label</th>
          <th>Issued</th>
          <th>Last used</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(
          (r) => html`
            <tr>
              <td><code>${r.id.slice(0, 8)}…</code></td>
              <td>${r.label ?? html`<em>—</em>`}</td>
              <td>${r.issuedAt.toISOString()}</td>
              <td>${r.lastUsedAt ? r.lastUsedAt.toISOString() : html`<em>never</em>`}</td>
              <td>
                <form class="inline" method="post" action="/me/tokens/${r.id}/revoke">
                  <button
                    class="btn btn-small btn-danger"
                    type="submit"
                    onclick="return confirm('Revoke this token?')"
                  >
                    Revoke
                  </button>
                </form>
              </td>
            </tr>
          `,
        )}
      </tbody>
    </table>
  `;
}

function pagedHref(base: string, f: AuditFilters, page: number): string {
  const u = new URL(base, 'http://x');
  if (f.tool !== undefined) u.searchParams.set('tool', f.tool);
  if (f.status !== undefined) u.searchParams.set('status', f.status);
  if (f.since !== undefined) u.searchParams.set('since', f.since);
  if (f.until !== undefined) u.searchParams.set('until', f.until);
  u.searchParams.set('page', String(page));
  return `${u.pathname}?${u.searchParams.toString()}`;
}

function claudeDesktopSnippet(baseUrl: string, token: string): string {
  const snippet = {
    mcpServers: {
      'heroku-platform': {
        url: `${baseUrl.replace(/\/$/, '')}/mcp`,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  };
  return JSON.stringify(snippet, null, 2);
}

export { raw };
