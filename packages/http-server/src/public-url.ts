/**
 * Lazy resolver for the server's external base URL.
 *
 * Three states:
 *  - Explicit: the operator set HEROKUMCP_PUBLIC_URL; that value is locked.
 *  - Resolved: no explicit value, but a request arrived; resolved from the
 *    X-Forwarded-Host (or Host) header + X-Forwarded-Proto (or "https" in
 *    production, "http" otherwise).
 *  - Unresolved: no explicit value, no request yet. In dev (isProduction=false)
 *    we synthesize http://localhost:PORT so local development works without
 *    any env config. In production, reading the value before resolution throws.
 *
 * The resolver is single-write: once any path sets the URL it's locked. We
 * don't need a mutex because (a) the explicit case is set at construction
 * before any request can arrive, and (b) the request case sees the same
 * Host across concurrent first requests, so last-writer-wins is harmless.
 */

export type PublicUrlSource = 'explicit' | 'resolved' | 'dev-fallback';

interface ResolveFromHeadersInput {
  /** Value of the X-Forwarded-Host header, if any. */
  forwardedHost?: string | undefined;
  /** Value of the Host header. */
  host?: string | undefined;
  /** Value of the X-Forwarded-Proto header, if any. */
  forwardedProto?: string | undefined;
}

export class PublicUrlResolver {
  #value: string | undefined;
  #source: PublicUrlSource | undefined;
  readonly #isProduction: boolean;

  constructor(opts: { explicit?: string | undefined; isProduction: boolean; port: number }) {
    this.#isProduction = opts.isProduction;
    if (opts.explicit) {
      this.#value = trimTrailingSlash(opts.explicit);
      this.#source = 'explicit';
      return;
    }
    if (!opts.isProduction) {
      this.#value = `http://localhost:${opts.port}`;
      this.#source = 'dev-fallback';
    }
  }

  /** Current value, or undefined if not yet resolved. */
  peek(): string | undefined {
    return this.#value;
  }

  /** Source of the current value, for diagnostics. */
  source(): PublicUrlSource | undefined {
    return this.#source;
  }

  /**
   * Return the resolved URL, or throw with an actionable message if not yet
   * resolved. Use this in handlers that absolutely need the value (OAuth
   * metadata, sign-in redirects). Most handlers run after the resolver
   * middleware has set a value, so this rarely throws.
   */
  getOrThrow(): string {
    if (this.#value === undefined) {
      throw new Error(
        'Public URL is not yet known. The server is waiting for its first ' +
          'inbound HTTP request to learn its public hostname. If this error ' +
          'appears in logs, something tried to read the public URL outside ' +
          'a request context — file a bug.',
      );
    }
    return this.#value;
  }

  /**
   * Resolve from request headers if not already locked. Once locked (by
   * explicit env, or by an earlier request that resolved a host) this is a
   * no-op. A dev-fallback localhost value is provisional, not locked: the
   * first real request with a usable Host upgrades it (so dev-via-tunnel
   * adopts the tunnel host).
   */
  resolveFromHeaders(input: ResolveFromHeadersInput): void {
    if (this.#source === 'explicit' || this.#source === 'resolved') {
      return; // Already locked in.
    }
    const host = pickHost(input.forwardedHost, input.host);
    if (!host) return; // No usable host; leave state alone, try again next request.
    const proto = pickProto(input.forwardedProto, this.#isProduction);
    this.#value = trimTrailingSlash(`${proto}://${host}`);
    this.#source = 'resolved';
  }
}

function pickHost(forwarded: string | undefined, host: string | undefined): string | undefined {
  // X-Forwarded-Host may be a comma-separated list; the first entry is the
  // client-facing host.
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  const trimmed = host?.trim();
  if (trimmed) return trimmed;
  return undefined;
}

function pickProto(forwarded: string | undefined, isProduction: boolean): string {
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim().toLowerCase();
    if (first === 'http' || first === 'https') return first;
  }
  // Heroku terminates TLS at the router; if we don't have an explicit hint,
  // assume https in production (Heroku's default) and http for local dev.
  return isProduction ? 'https' : 'http';
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
