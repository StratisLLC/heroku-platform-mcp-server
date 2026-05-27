/**
 * Environment-variable loading + validation.
 *
 * Every var the hosted server reads is parsed here, in one place. We refuse to
 * start if a required var is missing or malformed; the operator should see a
 * clear "I'm missing X" message rather than a confusing failure deep in the
 * sign-in flow.
 *
 * Required:
 *   HEROKUMCP_MASTER_KEY            base64 32B AES-256 KEK
 *   HEROKUMCP_OAUTH_CLIENT_ID       Heroku OAuth client id
 *   HEROKUMCP_OAUTH_CLIENT_SECRET   Heroku OAuth client secret
 *   HEROKUMCP_ADMIN_CONTACT         email/URL shown on access-denied pages
 *   DATABASE_URL                    Postgres connection string
 *
 * Optional:
 *   PORT                            HTTP port (default 3000)
 *   HEROKUMCP_PUBLIC_URL            external base URL (default derived from request)
 *   HEROKUMCP_OAUTH_SCOPE           OAuth scope (default "write-protected")
 *   MCP_ALLOWED_EMAILS              comma-separated allowlist
 *   MCP_ALLOWED_TEAMS               comma-separated team-name allowlist
 *   MCP_ADMIN_EMAILS                comma-separated admin allowlist
 *   HEROKUMCP_AUDIT_RETENTION_DAYS  integer; if set, daily prune runs
 *   HEROKUMCP_LOG_LEVEL             debug|info|warn|error (default info)
 *   NODE_ENV                        production switches Secure cookies on
 */

import { z } from 'zod';
import { loadMasterKeyFromBase64 } from '@heroku-mcp/core';

const Env = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.string().optional(),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  HEROKUMCP_MASTER_KEY: z.string().min(1, 'HEROKUMCP_MASTER_KEY is required'),
  HEROKUMCP_OAUTH_CLIENT_ID: z.string().min(1, 'HEROKUMCP_OAUTH_CLIENT_ID is required'),
  HEROKUMCP_OAUTH_CLIENT_SECRET: z.string().min(1, 'HEROKUMCP_OAUTH_CLIENT_SECRET is required'),
  HEROKUMCP_ADMIN_CONTACT: z.string().min(1, 'HEROKUMCP_ADMIN_CONTACT is required'),
  HEROKUMCP_OAUTH_SCOPE: z.string().default('write-protected'),
  HEROKUMCP_PUBLIC_URL: z.string().optional(),
  MCP_ALLOWED_EMAILS: z.string().optional(),
  MCP_ALLOWED_TEAMS: z.string().optional(),
  MCP_ADMIN_EMAILS: z.string().optional(),
  HEROKUMCP_AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().optional(),
  HEROKUMCP_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  HEROKUMCP_DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  HEROKUMCP_DB_SSL: z.enum(['require', 'no-verify', 'off']).default('require'),
});

type EnvOutput = z.output<typeof Env>;

export interface Config {
  port: number;
  isProduction: boolean;
  publicUrl: string | undefined;
  databaseUrl: string;
  dbPoolMax: number;
  dbSsl: 'require' | 'no-verify' | 'off';
  masterKey: Uint8Array;
  oauth: {
    clientId: string;
    clientSecret: string;
    scope: string;
    authorizeUrl: string;
    tokenUrl: string;
  };
  herokuApiBaseUrl: string;
  adminContact: string;
  allowedEmails: string[] | null;
  allowedTeams: string[] | null;
  adminEmails: string[];
  auditRetentionDays: number | null;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  rawEnvForAdmin: Record<string, string | undefined>;
}

/** Hostnames Heroku publishes. We pin them rather than allow override so the
 *  OAuth flow can't be diverted by a misconfigured env var. */
export const HEROKU_AUTH_ORIGIN = 'https://id.heroku.com';
export const HEROKU_API_ORIGIN = 'https://api.heroku.com';

/** Load + validate the environment. Throws with a multi-line message that
 *  enumerates every problem, so the operator can fix them all at once. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  const e = parsed.data;

  const masterKey = loadMasterKeyFromBase64(e.HEROKUMCP_MASTER_KEY);

  const allowedEmails = parseCommaList(e.MCP_ALLOWED_EMAILS)?.map(normalizeEmail) ?? null;
  const allowedTeams = parseCommaList(e.MCP_ALLOWED_TEAMS) ?? null;
  const adminEmails = (parseCommaList(e.MCP_ADMIN_EMAILS) ?? []).map(normalizeEmail);

  const cfg: Config = {
    port: e.PORT,
    isProduction: (e.NODE_ENV ?? '').toLowerCase() === 'production',
    publicUrl: trimSlash(e.HEROKUMCP_PUBLIC_URL),
    databaseUrl: e.DATABASE_URL,
    dbPoolMax: e.HEROKUMCP_DB_POOL_MAX,
    dbSsl: e.HEROKUMCP_DB_SSL,
    masterKey,
    oauth: {
      clientId: e.HEROKUMCP_OAUTH_CLIENT_ID,
      clientSecret: e.HEROKUMCP_OAUTH_CLIENT_SECRET,
      scope: e.HEROKUMCP_OAUTH_SCOPE,
      authorizeUrl: `${HEROKU_AUTH_ORIGIN}/oauth/authorize`,
      tokenUrl: `${HEROKU_AUTH_ORIGIN}/oauth/token`,
    },
    herokuApiBaseUrl: HEROKU_API_ORIGIN,
    adminContact: e.HEROKUMCP_ADMIN_CONTACT,
    allowedEmails,
    allowedTeams,
    adminEmails,
    auditRetentionDays: e.HEROKUMCP_AUDIT_RETENTION_DAYS ?? null,
    logLevel: e.HEROKUMCP_LOG_LEVEL,
    rawEnvForAdmin: snapshotForAdmin(env),
  };
  return cfg;
}

function parseCommaList(s: string | undefined): string[] | undefined {
  if (s === undefined) return undefined;
  const parts = s
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length === 0 ? undefined : parts;
}

function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

function trimSlash(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/** Capture a sanitized snapshot of relevant env vars for /admin/config. Secrets
 *  are replaced with "***". The set is intentionally narrow — we don't expose
 *  random env vars Heroku injects (DATABASE_URL is masked likewise). */
function snapshotForAdmin(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const wanted = [
    'PORT',
    'NODE_ENV',
    'DATABASE_URL',
    'HEROKUMCP_MASTER_KEY',
    'HEROKUMCP_OAUTH_CLIENT_ID',
    'HEROKUMCP_OAUTH_CLIENT_SECRET',
    'HEROKUMCP_OAUTH_SCOPE',
    'HEROKUMCP_PUBLIC_URL',
    'HEROKUMCP_ADMIN_CONTACT',
    'HEROKUMCP_AUDIT_RETENTION_DAYS',
    'HEROKUMCP_LOG_LEVEL',
    'HEROKUMCP_DB_POOL_MAX',
    'HEROKUMCP_DB_SSL',
    'MCP_ALLOWED_EMAILS',
    'MCP_ALLOWED_TEAMS',
    'MCP_ADMIN_EMAILS',
  ];
  const secret = new Set(['HEROKUMCP_MASTER_KEY', 'HEROKUMCP_OAUTH_CLIENT_SECRET', 'DATABASE_URL']);
  const out: Record<string, string | undefined> = {};
  for (const k of wanted) {
    const v = env[k];
    if (v === undefined) {
      out[k] = undefined;
    } else {
      out[k] = secret.has(k) ? '***' : v;
    }
  }
  return out;
}

export type { EnvOutput };
