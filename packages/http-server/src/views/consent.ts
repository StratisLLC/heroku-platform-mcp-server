/**
 * OAuth consent screen. Rendered by /oauth/authorize when the signed-in user
 * is not in the deployment's allowlist (see D2 — allowlisted users skip
 * consent because the operator has already pre-authorized them).
 */

import { html, layout } from './layout.js';
import type { ViewerCtx } from './pages.js';

export interface ConsentView {
  clientName: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string | null;
  scope: string | null;
  userEmail: string;
}

export function renderConsent(ctx: ViewerCtx, v: ConsentView): string {
  return layout(
    {
      title: 'Authorize application',
      signedIn: ctx.signedIn,
      admin: ctx.admin,
      currentPath: ctx.currentPath,
    },
    html`
      <div class="card">
        <h2>Authorize application</h2>
        <p>
          The application
          <strong style="color:var(--sfdc-brand-darker)">${v.clientName}</strong> wants to access
          your Heroku account through this MCP server, signed in as <code>${v.userEmail}</code>.
        </p>
        <p class="muted">
          You can revoke this access at any time from your <a href="/me">account page</a>.
        </p>
        <form method="post" action="/oauth/consent" class="inline">
          <input type="hidden" name="client_id" value="${v.clientId}" />
          <input type="hidden" name="redirect_uri" value="${v.redirectUri}" />
          <input type="hidden" name="code_challenge" value="${v.codeChallenge}" />
          <input type="hidden" name="code_challenge_method" value="${v.codeChallengeMethod}" />
          ${v.state !== null ? html`<input type="hidden" name="state" value="${v.state}" />` : null}
          ${v.scope !== null ? html`<input type="hidden" name="scope" value="${v.scope}" />` : null}
          <button class="btn btn-primary" type="submit" name="decision" value="allow">Allow</button>
          <button class="btn" type="submit" name="decision" value="deny">Deny</button>
        </form>
      </div>
    `,
  );
}
