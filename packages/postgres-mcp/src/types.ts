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

// ---------------------------------------------------------------------------
// Phase 6 Part B — write/mutation tool inputs.
//
// Destructive tools take a `confirm` string that must equal the resource the
// tool acts on (the database add-on name, or the backup id for backup delete).
// We surface the expected value in the field description so a model can fill it
// correctly on the second attempt after a `confirmation` error. NOTE: the
// Heroku CLI confirms these same operations against the owning *app* name; we
// confirm against the more specific database/backup the tool targets, which is
// also our primary input. See each tool's handler for the citation.
// ---------------------------------------------------------------------------

/** Build a `confirm` field whose description tells the model what to pass. */
export const confirmField = (passWhat: string) =>
  z
    .string()
    .min(1)
    .describe(
      `Confirmation guard for this destructive operation. Pass ${passWhat} to proceed; ` +
        `any other value is rejected with a structured "confirmation" error (no API call is made). ` +
        `Only fill this once the user has explicitly confirmed the action.`,
    );

/** Optional database identifier (some write tools can resolve scope from `app`). */
export const optionalDatabaseInput = {
  database: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Heroku Postgres database identifier — add-on UUID or name. Optional when "app" is supplied.',
    ),
};

/** A credential (role) name to create/destroy/rotate. Mirrors the CLI `--name`
 *  flag and Heroku's credential-name rules: 3–63 chars, lowercase alnum plus
 *  `_`/`-`, starting with a letter and ending alphanumeric. */
const credentialNameField = z
  .string()
  .min(3)
  .max(63)
  .regex(
    /^[a-z][a-z0-9_-]*[a-z0-9]$/,
    'Credential name must be 3–63 chars, lowercase letters/digits/_/-, start with a letter and end alphanumeric.',
  )
  .describe('Credential (role) name, e.g. "reporting" or "default".');

/** `pg_credentials_create` — non-destructive, no confirm. */
export const credentialsCreateInput = {
  ...databaseInput,
  name: credentialNameField,
};

/** `pg_credentials_destroy` — destructive. */
export const credentialsDestroyInput = {
  ...databaseInput,
  name: credentialNameField,
  confirm: confirmField('the database add-on name'),
};

/** `pg_credentials_rotate` — mutating. */
export const credentialsRotateInput = {
  ...databaseInput,
  name: z
    .string()
    .min(1)
    .default('default')
    .describe('Credential to rotate. Defaults to "default".'),
  force: z
    .boolean()
    .optional()
    .describe(
      'Force rotation. Without it, only connections older than 30 minutes are reset and a temporary rotation username is used; with it, all connections reset immediately and lagging followers may become temporarily inaccessible.',
    ),
  confirm: confirmField('the database add-on name'),
};

/** `pg_credentials_repair_default` — mutating. */
export const credentialsRepairDefaultInput = {
  ...databaseInput,
  confirm: confirmField('the database add-on name'),
};

/** `pg_backups_capture` — non-destructive (creates a backup). */
export const backupsCaptureInput = {
  ...databaseInput,
  wait: z
    .boolean()
    .optional()
    .describe(
      'Reserved. Capture always returns the in-progress transfer immediately; polling to completion is a separate (not-yet-implemented) tool. Passing true adds a note to the response.',
    ),
};

/** `pg_backups_delete` — destructive. App resolved from `database` unless given. */
export const backupsDeleteInput = {
  ...optionalDatabaseInput,
  ...optionalAppInput,
  backup_id: z
    .string()
    .min(1)
    .describe('Backup to delete — its "num" (e.g. "b001" or "1") or numeric id.'),
  confirm: confirmField('the backup_id'),
};

/** `pg_backups_schedule` — non-destructive (additive). */
export const backupsScheduleInput = {
  ...databaseInput,
  at: z
    .string()
    .min(1)
    .describe(
      'When to run the daily backup, as "HH:00 [TIMEZONE]" (minutes must be 00). ' +
        'Timezone may be an abbreviation (e.g. PST, EST) or IANA name; defaults to UTC. ' +
        'Example: "02:00 America/Los_Angeles".',
    ),
  name: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Attachment name the schedule is keyed to (the schedule_name becomes "{name}_URL"). Defaults to "DATABASE".',
    ),
};

/** `pg_connection_reset` — mutating (terminates all connections). */
export const connectionResetInput = {
  ...databaseInput,
  confirm: confirmField('the database add-on name'),
};

/** `pg_maintenance_window_set` — mutating. */
export const maintenanceWindowSetInput = {
  ...databaseInput,
  day_of_week: z
    .string()
    .min(1)
    .describe('UTC maintenance day of week, e.g. "sunday".'),
  time_of_day: z
    .string()
    .min(1)
    .describe('UTC maintenance time of day, e.g. "13:30" or "1:30PM".'),
  confirm: confirmField('the database add-on name'),
};
