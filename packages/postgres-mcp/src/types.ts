/**
 * Shared zod input shapes and TypeScript response aliases for the Postgres MCP
 * tools.
 *
 * Responses from the Heroku Data API are passed through to the caller verbatim
 * inside the standard tool envelope (matching `@heroku-mcp/platform`'s
 * pass-through convention), so we model them as loose records rather than
 * pinning a strict schema that would drift against Heroku's evolving payloads.
 * Inputs, by contrast, ARE strictly validated — they are the only thing the
 * model controls.
 */

import { z } from 'zod';

/** A Heroku JSON object we don't strictly model — passed through verbatim. */
export type PgRecord = Record<string, unknown>;
/** A list of {@link PgRecord}. */
export type PgList = PgRecord[];

/** App identifier (id or name), used by `pg_list`. */
export const appInput = {
  app: z
    .string()
    .min(1)
    .describe('App id (UUID) or name the Postgres databases are attached to.'),
};

/** A database identifier. The Data API prefers the add-on UUID; the add-on
 *  name (e.g. `heroku-postgresql-curved-12345`) also works for most reads. */
export const databaseInput = {
  database: z
    .string()
    .min(1)
    .describe(
      'Heroku Postgres database identifier — the add-on id (UUID, preferred) or add-on name (e.g. "heroku-postgresql-curved-12345").',
    ),
};

/** A credential (role) name on a database. */
export const credentialInput = {
  ...databaseInput,
  credential: z
    .string()
    .min(1)
    .describe('Credential (role) name on the database, e.g. "default" or a named credential.'),
};

/** Optional owning-app override. Heroku scopes backup transfers to the *app*,
 *  not the database. When omitted, the tool resolves the owning app from the
 *  database add-on via the Platform API. */
export const optionalAppInput = {
  app: z
    .string()
    .min(1)
    .optional()
    .describe(
      'App id (UUID) or name that owns the database. Optional — defaults to the database add-on\'s owning app. Backups (transfers) are scoped to the app.',
    ),
};

/** Input for the app-scoped backup *list*: a database plus an optional app. */
export const backupListInput = {
  ...databaseInput,
  ...optionalAppInput,
};

/** A backup identifier on a database (app-scoped transfer). */
export const backupInput = {
  ...databaseInput,
  ...optionalAppInput,
  backup: z
    .string()
    .min(1)
    .describe('Backup identifier — the backup "num" (e.g. "b001") or its UUID.'),
};
