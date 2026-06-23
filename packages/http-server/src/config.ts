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
 *   HEROKUMCP_PUBLIC_URL            external base URL, e.g. https://herokumcp.example.com
 *                                   When unset we learn it lazily from the first
 *                                   inbound request's Host header (see PublicUrlResolver).
 *   PORT                            HTTP port (default 3000)
 *   HEROKUMCP_OAUTH_SCOPE           OAuth scope (default "write-protected")
 *   MCP_ALLOWED_EMAILS              comma-separated allowlist
 *   MCP_ALLOWED_TEAMS               comma-separated team-name allowlist
 *   MCP_ADMIN_EMAILS                comma-separated admin allowlist
 *   HEROKUMCP_AUDIT_RETENTION_DAYS  integer; if set, daily prune runs
 *   HEROKUMCP_LOG_LEVEL             debug|info|warn|error (default info)
 *   NODE_ENV                        production switches Secure cookies on
 */

import { z } from 'zod';
import { loadMasterKey } from '@heroku-mcp/core';
import { PublicUrlResolver } from './public-url.js';

const Env = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.string().optional(),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  HEROKUMCP_MASTER_KEY: z.string().min(1, 'HEROKUMCP_MASTER_KEY is required'),
  HEROKUMCP_OAUTH_CLIENT_ID: z.string().min(1, 'HEROKUMCP_OAUTH_CLIENT_ID is required'),
  HEROKUMCP_OAUTH_CLIENT_SECRET: z.string().min(1, 'HEROKUMCP_OAUTH_CLIENT_SECRET is required'),
  HEROKUMCP_ADMIN_CONTACT: z.string().min(1, 'HEROKUMCP_ADMIN_CONTACT is required'),
  // Must include `identity` — `GET /account` (the required `account.self`
  // probe and `resolveUserAccessToken`'s identity fetch) needs it. A bare
  // `write-protected` default silently breaks first sign-in, so default to the
  // working least-privilege value. (Use `global` for usage/billing access; see
  // the scope normalisation in oauth/heroku.ts.)
  HEROKUMCP_OAUTH_SCOPE: z.string().default('identity,write-protected'),
  // Optional: an explicit operator override. When unset, the public URL is
  // resolved lazily from the first inbound request's Host header (see
  // PublicUrlResolver), so the server boots fine without it. When present it
  // must carry a scheme.
  HEROKUMCP_PUBLIC_URL: z
    .string()
    .min(1)
    .refine((s) => /^https?:\/\//.test(s), {
      message: 'HEROKUMCP_PUBLIC_URL must start with http:// or https://',
    })
    .optional(),
  // Injected by Heroku Dyno Metadata (Heroku Labs, opt-in). Kept in the schema
  // for compatibility, but no longer used to derive the public URL — that's now
  // resolved lazily from request headers, which works even on Button deploys
  // where dyno metadata isn't available.
  HEROKU_APP_DEFAULT_DOMAIN_NAME: z.string().optional(),
  HEROKU_APP_NAME: z.string().optional(),
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
  /**
   * The external base URL the server advertises (OAuth metadata, callback URLs,
   * .well-known docs). No trailing slash. Backed by {@link publicUrlResolver}:
   * reading it before the URL is known (production, no request seen yet) throws,
   * so consumers must read it inside a request handler, not at app-build time.
   */
  publicUrl: string;
  /** Owns the lazy resolution of {@link publicUrl}. The public-url middleware
   *  feeds it request headers; explicit env or dev fallback lock it earlier. */
  publicUrlResolver: PublicUrlResolver;
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

  const isProduction = (e.NODE_ENV ?? '').toLowerCase() === 'production';

  const publicUrlResolver = new PublicUrlResolver({
    explicit: e.HEROKUMCP_PUBLIC_URL,
    isProduction,
    port: e.PORT,
  });

  const masterKey = loadMasterKey(e.HEROKUMCP_MASTER_KEY);

  const allowedEmails = parseCommaList(e.MCP_ALLOWED_EMAILS)?.map(normalizeEmail) ?? null;
  const allowedTeams = parseCommaList(e.MCP_ALLOWED_TEAMS) ?? null;
  const adminEmails = (parseCommaList(e.MCP_ADMIN_EMAILS) ?? []).map(normalizeEmail);

  const cfg: Config = {
    port: e.PORT,
    isProduction,
    publicUrlResolver,
    // Backed by the resolver: reads inside request handlers see the resolved
    // value; reading before any request (production, unresolved) throws.
    get publicUrl(): string {
      return publicUrlResolver.getOrThrow();
    },
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
