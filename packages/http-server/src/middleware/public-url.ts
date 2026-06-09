import type { MiddlewareHandler } from 'hono';
import type { PublicUrlResolver } from '../public-url.js';

/**
 * Top-level middleware: on every request, give the resolver a chance to lock
 * in the public URL from the request headers. Once resolved (by explicit env
 * or by the first request that succeeded), this becomes a no-op.
 *
 * Mount this BEFORE any route that reads cfg.publicUrl (OAuth metadata,
 * sign-in pages, MCP endpoint, well-known docs).
 */
export function publicUrlMiddleware(resolver: PublicUrlResolver): MiddlewareHandler {
  return async (c, next) => {
    resolver.resolveFromHeaders({
      forwardedHost: c.req.header('x-forwarded-host'),
      host: c.req.header('host'),
      forwardedProto: c.req.header('x-forwarded-proto'),
    });
    await next();
  };
}
