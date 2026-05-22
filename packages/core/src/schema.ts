/**
 * Heroku JSON Schema fetch + on-disk cache (ARCHITECTURE.md §5.1).
 *
 * Heroku exposes the canonical resource description at
 * `GET https://api.heroku.com/schema`. The response is a (large) JSON Schema
 * document with one definition per resource and per-endpoint `links`.
 *
 * This module:
 *   - Fetches the schema, with optional `If-None-Match` revalidation.
 *   - Caches the body to disk keyed by ETag, with a TTL (default 24 h).
 *   - On cold start, returns the cached copy when fresh; revalidates with
 *     Heroku otherwise.
 *
 * We do not parse the schema deeply — it's used as data by downstream code
 * (the prober, request validation, type generation). Helpers here are limited
 * to convenience accessors for definitions and links.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Top-level shape; permissive because Heroku may add fields. */
export interface HerokuSchema {
  $schema?: string;
  type?: string | string[];
  description?: string;
  definitions?: Record<string, SchemaDefinition>;
}

/** One resource definition. */
export interface SchemaDefinition {
  title?: string;
  description?: string;
  type?: string | string[];
  properties?: Record<string, unknown>;
  required?: readonly string[];
  links?: readonly SchemaLink[];
  definitions?: Record<string, unknown>;
  [extra: string]: unknown;
}

/** One endpoint description under a resource's `links`. */
export interface SchemaLink {
  title?: string;
  description?: string;
  href: string;
  method?: string;
  rel?: string;
  schema?: unknown;
  targetSchema?: unknown;
  [extra: string]: unknown;
}

/** Default schema TTL: 24h per ARCHITECTURE.md §5.1. */
export const SCHEMA_TTL_MS = 24 * 60 * 60 * 1000;
const SCHEMA_PATH = '/schema';

export interface FetchSchemaOptions {
  baseUrl?: string;
  apiVersion?: string;
  fetch?: typeof globalThis.fetch;
  ifNoneMatch?: string;
}

export interface FetchSchemaResult {
  status: number;
  schema?: HerokuSchema;
  etag?: string;
}

/** Fetch the Heroku schema, optionally revalidating with `If-None-Match`. */
export async function fetchHerokuSchema(opts: FetchSchemaOptions = {}): Promise<FetchSchemaResult> {
  const baseUrl = (opts.baseUrl ?? 'https://api.heroku.com').replace(/\/$/, '');
  const url = `${baseUrl}${SCHEMA_PATH}`;
  const apiVersion = opts.apiVersion ?? '3';
  const fetchFn = opts.fetch ?? globalThis.fetch;

  const headers: Record<string, string> = {
    Accept: `application/vnd.heroku+json; version=${apiVersion}`,
  };
  if (opts.ifNoneMatch) headers['If-None-Match'] = opts.ifNoneMatch;

  const response = await fetchFn(url, { method: 'GET', headers });
  const etag = response.headers.get('etag') ?? undefined;

  if (response.status === 304) {
    const result: FetchSchemaResult = { status: 304 };
    if (etag) result.etag = etag;
    return result;
  }
  if (response.status !== 200) {
    return { status: response.status };
  }

  const text = await response.text();
  let schema: HerokuSchema;
  try {
    schema = JSON.parse(text) as HerokuSchema;
  } catch (err) {
    throw new SchemaError(`/schema response was not valid JSON: ${(err as Error).message}`);
  }
  if (!isHerokuSchema(schema)) {
    throw new SchemaError('/schema response did not look like a Heroku schema document.');
  }
  const result: FetchSchemaResult = { status: 200, schema };
  if (etag) result.etag = etag;
  return result;
}

/** Loose runtime check: it has a `definitions` map. */
export function isHerokuSchema(value: unknown): value is HerokuSchema {
  return (
    typeof value === 'object' &&
    value !== null &&
    'definitions' in value &&
    typeof value.definitions === 'object'
  );
}

/** Look up a definition by name. Returns undefined if absent. */
export function getDefinition(schema: HerokuSchema, name: string): SchemaDefinition | undefined {
  return schema.definitions?.[name];
}

/** Disk envelope for a cached schema. Version 1 only at present. */
interface CachedSchemaEnvelope {
  version: 1;
  storedAt: number;
  etag?: string;
  schema: HerokuSchema;
}

export interface SchemaCacheOptions {
  /** Absolute path to the cache file. */
  path: string;
  /** Time-to-live in milliseconds. Defaults to 24h. */
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Fetch + fetch-time overrides forwarded to {@link fetchHerokuSchema}. */
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  apiVersion?: string;
}

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

/**
 * Persistent schema cache. Calls {@link fetchHerokuSchema} when needed,
 * persists the response to disk, and revalidates with the stored ETag when
 * the TTL expires.
 */
export class SchemaCache {
  private readonly path: string;
  private readonly ttlMs: number;
  private readonly clock: () => number;
  private readonly fetchFn: typeof globalThis.fetch | undefined;
  private readonly baseUrl: string | undefined;
  private readonly apiVersion: string | undefined;

  constructor(opts: SchemaCacheOptions) {
    this.path = opts.path;
    this.ttlMs = opts.ttlMs ?? SCHEMA_TTL_MS;
    this.clock = opts.now ?? Date.now;
    this.fetchFn = opts.fetch;
    this.baseUrl = opts.baseUrl;
    this.apiVersion = opts.apiVersion;
  }

  /** Return a current schema. Reads the cache when fresh, otherwise calls
   *  {@link fetchHerokuSchema} (with ETag revalidation when available). */
  async load(opts: { forceRefresh?: boolean } = {}): Promise<HerokuSchema> {
    const cached = await this.readCache();
    const now = this.clock();
    if (!opts.forceRefresh && cached && now - cached.storedAt < this.ttlMs) {
      return cached.schema;
    }

    const fetchOpts: FetchSchemaOptions = {};
    if (this.fetchFn) fetchOpts.fetch = this.fetchFn;
    if (this.baseUrl !== undefined) fetchOpts.baseUrl = this.baseUrl;
    if (this.apiVersion !== undefined) fetchOpts.apiVersion = this.apiVersion;
    if (cached?.etag) fetchOpts.ifNoneMatch = cached.etag;

    const result = await fetchHerokuSchema(fetchOpts);
    if (result.status === 304 && cached) {
      await this.touchCache(cached);
      return cached.schema;
    }
    if (result.status === 200 && result.schema) {
      await this.writeCache(result.schema, result.etag);
      return result.schema;
    }
    if (cached) return cached.schema;
    throw new SchemaError(
      `Failed to fetch /schema (status ${result.status}) and no cached copy is available.`,
    );
  }

  /** Read the cached envelope. Returns null on missing or corrupt files. */
  async readCache(): Promise<CachedSchemaEnvelope | null> {
    let text: string;
    try {
      text = await readFile(this.path, { encoding: 'utf8' });
    } catch (err) {
      if (isENOENT(err)) return null;
      throw err;
    }
    try {
      const parsed = JSON.parse(text) as CachedSchemaEnvelope;
      if (parsed.version === 1 && isHerokuSchema(parsed.schema)) return parsed;
      return null;
    } catch {
      return null;
    }
  }

  /** Write the cache envelope to disk. */
  private async writeCache(schema: HerokuSchema, etag: string | undefined): Promise<void> {
    const envelope: CachedSchemaEnvelope = {
      version: 1,
      storedAt: this.clock(),
      schema,
    };
    if (etag !== undefined) envelope.etag = etag;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(envelope), { encoding: 'utf8' });
  }

  /** Update only the storedAt timestamp on a 304 revalidation. */
  private async touchCache(cached: CachedSchemaEnvelope): Promise<void> {
    const envelope: CachedSchemaEnvelope = {
      ...cached,
      storedAt: this.clock(),
    };
    await writeFile(this.path, JSON.stringify(envelope), { encoding: 'utf8' });
  }
}

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}
