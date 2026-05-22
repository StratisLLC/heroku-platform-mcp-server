/**
 * Pagination helpers for Heroku's `Range` / `Content-Range` / `Next-Range`
 * idiom (see ARCHITECTURE.md §8.2 and Heroku Platform API "ranges").
 *
 * Heroku pages by an opaque cursor in a request `Range` header:
 *
 *     Range: id ..; max=200; order=asc
 *
 * The response carries `Content-Range` summarising the page, and `Next-Range`
 * if more pages exist. To MCP tool callers we expose `page_size` and an
 * opaque `cursor` — the cursor is just the `Next-Range` value from the
 * previous response, returned verbatim.
 */

/** Default page size when caller doesn't specify (ARCHITECTURE.md §8.2). */
export const DEFAULT_PAGE_SIZE = 200;

/** Hard upper bound on page size per ARCHITECTURE.md §8.2. */
export const MAX_PAGE_SIZE = 1000;

export interface BuildRangeOptions {
  /** Caller-supplied page size; clamped to `[1, maxPageSize]`. */
  pageSize?: number;
  /** Opaque cursor returned by a previous `parsePaginationMeta` call. */
  cursor?: string;
  /** Override the default-when-unspecified page size. */
  defaultPageSize?: number;
  /** Override the hard upper bound. */
  maxPageSize?: number;
  /** Property to range over (`id` for nearly every Heroku resource). */
  property?: string;
}

/**
 * Build a `Range` request header from `page_size` / `cursor` tool params.
 *
 * When a cursor is supplied, it is used verbatim — Heroku's `Next-Range`
 * already encodes the property, order, and starting point. If `pageSize` is
 * also given, the `max=` field of the cursor is rewritten so the caller's
 * choice wins.
 */
export function buildRangeHeader(opts: BuildRangeOptions = {}): string {
  const defaultSize = opts.defaultPageSize ?? DEFAULT_PAGE_SIZE;
  const maxSize = opts.maxPageSize ?? MAX_PAGE_SIZE;
  const property = opts.property ?? 'id';

  if (opts.cursor !== undefined && opts.cursor !== '') {
    if (opts.pageSize !== undefined) {
      const clamped = clampPageSize(opts.pageSize, maxSize);
      return rewriteMaxField(opts.cursor, clamped);
    }
    return opts.cursor;
  }

  const size = clampPageSize(opts.pageSize ?? defaultSize, maxSize);
  return `${property} ..; max=${size}`;
}

export interface PaginationMeta {
  /** True if Heroku returned a `Next-Range` header indicating more pages. */
  hasMore: boolean;
  /** Opaque cursor to feed back as `cursor` on the next call. */
  cursor?: string;
  /** Total resource count if Heroku included it in `Content-Range`. */
  total?: number;
  /** Raw `Content-Range` for callers who want detail. */
  contentRange?: string;
}

export interface PaginationHeaders {
  contentRange?: string | null | undefined;
  nextRange?: string | null | undefined;
}

/**
 * Parse `Content-Range` and `Next-Range` into a {@link PaginationMeta}
 * suitable for the tool response envelope.
 */
export function parsePaginationMeta(headers: PaginationHeaders): PaginationMeta {
  const meta: PaginationMeta = { hasMore: false };
  if (headers.nextRange) {
    meta.hasMore = true;
    meta.cursor = headers.nextRange;
  }
  if (headers.contentRange) {
    meta.contentRange = headers.contentRange;
    const totalMatch = /total=(\d+)/i.exec(headers.contentRange);
    if (totalMatch?.[1]) meta.total = Number.parseInt(totalMatch[1], 10);
  }
  return meta;
}

function clampPageSize(n: number, max: number): number {
  if (!Number.isFinite(n)) return 1;
  const intN = Math.floor(n);
  if (intN < 1) return 1;
  if (intN > max) return max;
  return intN;
}

function rewriteMaxField(range: string, newMax: number): string {
  if (/;\s*max\s*=\s*\d+/i.test(range)) {
    return range.replace(/(;\s*max\s*=\s*)\d+/i, `$1${newMax}`);
  }
  return `${range}; max=${newMax}`;
}
