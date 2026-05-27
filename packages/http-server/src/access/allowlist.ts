/**
 * Access control evaluator.
 *
 * Inputs: the authenticated identity (email + Heroku team memberships) and the
 * deployment's configured allowlists.
 *
 * Output: an allow/deny verdict with a structured `reason` we can surface on
 * the denial page and write to the audit log.
 */

export interface AllowlistConfig {
  allowedEmails: string[] | null;
  allowedTeams: string[] | null;
}

export interface AccessIdentity {
  email: string;
  herokuId: string;
  teams: string[];
}

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; reason: 'email_not_allowed' | 'team_not_allowed' | 'no_match' };

/** Evaluate `identity` against `cfg`.
 *
 *   - Both lists unset → allow.
 *   - Only emails set   → identity.email must match.
 *   - Only teams set    → identity must be in ≥1 allowed team.
 *   - Both set          → BOTH must match (email AND ≥1 team).
 */
export function evaluateAccess(identity: AccessIdentity, cfg: AllowlistConfig): AccessDecision {
  const hasEmails = (cfg.allowedEmails?.length ?? 0) > 0;
  const hasTeams = (cfg.allowedTeams?.length ?? 0) > 0;
  if (!hasEmails && !hasTeams) return { allowed: true };

  const emailLower = identity.email.toLowerCase();
  const emailOk = !hasEmails || (cfg.allowedEmails ?? []).includes(emailLower);
  const teamOk =
    !hasTeams ||
    identity.teams.some((t) =>
      (cfg.allowedTeams ?? []).some((allowed) => allowed.toLowerCase() === t.toLowerCase()),
    );

  if (hasEmails && hasTeams) {
    if (emailOk && teamOk) return { allowed: true };
    if (!emailOk && !teamOk) return { allowed: false, reason: 'no_match' };
    return { allowed: false, reason: emailOk ? 'team_not_allowed' : 'email_not_allowed' };
  }
  if (hasEmails) {
    return emailOk ? { allowed: true } : { allowed: false, reason: 'email_not_allowed' };
  }
  return teamOk ? { allowed: true } : { allowed: false, reason: 'team_not_allowed' };
}

/** Privacy-mask an email for the denial page: keep first char and domain,
 *  replace rest of local part with `***`. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length === 1) return `${local}***${domain}`;
  return `${local[0]}***${domain}`;
}

/** Test whether `email` belongs to the admin list (set in MCP_ADMIN_EMAILS). */
export function isAdminEmail(email: string, adminEmails: string[]): boolean {
  if (adminEmails.length === 0) return false;
  const e = email.toLowerCase();
  return adminEmails.some((a) => a.toLowerCase() === e);
}
