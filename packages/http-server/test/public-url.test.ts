import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { PublicUrlResolver } from '../src/public-url.js';
import { publicUrlMiddleware } from '../src/middleware/public-url.js';
import { buildWellKnownRoutes } from '../src/routes/wellknown.js';
import type { Config } from '../src/config.js';
import type { AppEnv } from '../src/auth/middleware.js';

describe('PublicUrlResolver', () => {
  it('returns explicit value when set', () => {
    const r = new PublicUrlResolver({
      explicit: 'https://example.com',
      isProduction: true,
      port: 3000,
    });
    expect(r.peek()).toBe('https://example.com');
    expect(r.source()).toBe('explicit');
  });

  it('strips trailing slash from explicit', () => {
    const r = new PublicUrlResolver({
      explicit: 'https://example.com/',
      isProduction: true,
      port: 3000,
    });
    expect(r.peek()).toBe('https://example.com');
  });

  it('uses localhost fallback in dev', () => {
    const r = new PublicUrlResolver({ explicit: undefined, isProduction: false, port: 8080 });
    expect(r.peek()).toBe('http://localhost:8080');
    expect(r.source()).toBe('dev-fallback');
  });

  it('is unresolved in production with no explicit value', () => {
    const r = new PublicUrlResolver({ explicit: undefined, isProduction: true, port: 3000 });
    expect(r.peek()).toBeUndefined();
    expect(() => r.getOrThrow()).toThrow();
  });

  it('resolves from X-Forwarded-Host with X-Forwarded-Proto', () => {
    const r = new PublicUrlResolver({ explicit: undefined, isProduction: true, port: 3000 });
    r.resolveFromHeaders({
      forwardedHost: 'myapp-12345.herokuapp.com',
      host: 'localhost:3000',
      forwardedProto: 'https',
    });
    expect(r.peek()).toBe('https://myapp-12345.herokuapp.com');
    expect(r.source()).toBe('resolved');
  });

  it('falls back to Host header when no X-Forwarded-Host', () => {
    const r = new PublicUrlResolver({ explicit: undefined, isProduction: true, port: 3000 });
    r.resolveFromHeaders({ host: 'myapp.herokuapp.com' });
    expect(r.peek()).toBe('https://myapp.herokuapp.com');
  });

  it('assumes https in production when no X-Forwarded-Proto', () => {
    const r = new PublicUrlResolver({ explicit: undefined, isProduction: true, port: 3000 });
    r.resolveFromHeaders({ host: 'example.com' });
    expect(r.peek()).toBe('https://example.com');
  });

  it('honors X-Forwarded-Proto: http when explicit', () => {
    const r = new PublicUrlResolver({ explicit: undefined, isProduction: true, port: 3000 });
    r.resolveFromHeaders({ host: 'example.com', forwardedProto: 'http' });
    expect(r.peek()).toBe('http://example.com');
  });

  it('parses comma-separated X-Forwarded-Host (uses first)', () => {
    const r = new PublicUrlResolver({ explicit: undefined, isProduction: true, port: 3000 });
    r.resolveFromHeaders({ forwardedHost: 'client.com, proxy1.com, proxy2.com' });
    expect(r.peek()).toBe('https://client.com');
  });

  it('parses comma-separated X-Forwarded-Proto (uses first)', () => {
    const r = new PublicUrlResolver({ explicit: undefined, isProduction: true, port: 3000 });
    r.resolveFromHeaders({ host: 'example.com', forwardedProto: 'https, http' });
    expect(r.peek()).toBe('https://example.com');
  });

  it('ignores an empty Host header and stays unresolved', () => {
    const r = new PublicUrlResolver({ explicit: undefined, isProduction: true, port: 3000 });
    r.resolveFromHeaders({ host: '   ' });
    expect(r.peek()).toBeUndefined();
    expect(r.source()).toBeUndefined();
  });

  it('is idempotent: second resolveFromHeaders is a no-op', () => {
    const r = new PublicUrlResolver({ explicit: undefined, isProduction: true, port: 3000 });
    r.resolveFromHeaders({ host: 'first.com' });
    r.resolveFromHeaders({ host: 'second.com' });
    expect(r.peek()).toBe('https://first.com');
  });

  it('explicit value cannot be overridden by request', () => {
    const r = new PublicUrlResolver({
      explicit: 'https://configured.com',
      isProduction: true,
      port: 3000,
    });
    r.resolveFromHeaders({ host: 'something-else.com' });
    expect(r.peek()).toBe('https://configured.com');
  });

  it('dev-fallback is provisional: a real request upgrades it', () => {
    // localhost is only a placeholder until a real request arrives; the first
    // request with a usable Host wins (so dev-via-tunnel adopts the tunnel host).
    const r = new PublicUrlResolver({ explicit: undefined, isProduction: false, port: 8080 });
    expect(r.peek()).toBe('http://localhost:8080');
    expect(r.source()).toBe('dev-fallback');
    r.resolveFromHeaders({ host: 'tunnel.example.com' });
    expect(r.peek()).toBe('http://tunnel.example.com');
    expect(r.source()).toBe('resolved');
  });
});

describe('publicUrlMiddleware + .well-known integration', () => {
  /** Minimal cfg whose publicUrl getter is backed by the resolver, mirroring
   *  what loadConfig produces. */
  function cfgFor(resolver: PublicUrlResolver): Config {
    return {
      publicUrlResolver: resolver,
      get publicUrl(): string {
        return resolver.getOrThrow();
      },
    } as Config;
  }

  it('serves oauth-authorization-server with the URL resolved from the first request', async () => {
    // Production, no explicit HEROKUMCP_PUBLIC_URL — unresolved at construction.
    const resolver = new PublicUrlResolver({ explicit: undefined, isProduction: true, port: 3000 });
    const cfg = cfgFor(resolver);

    const app = new Hono<AppEnv>();
    app.use('*', publicUrlMiddleware(resolver));
    app.route('/', buildWellKnownRoutes({ cfg }));

    const res = await app.request('/.well-known/oauth-authorization-server', {
      headers: {
        host: 'localhost:3000',
        'x-forwarded-host': 'myapp.herokuapp.com',
        'x-forwarded-proto': 'https',
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issuer: string; authorization_endpoint: string };
    expect(body.issuer).toBe('https://myapp.herokuapp.com');
    expect(body.authorization_endpoint).toBe('https://myapp.herokuapp.com/oauth/authorize');

    // And it stays locked across subsequent requests, even from a different host.
    const res2 = await app.request('/.well-known/oauth-protected-resource', {
      headers: { host: 'other.example.com' },
    });
    const body2 = (await res2.json()) as { resource: string };
    expect(body2.resource).toBe('https://myapp.herokuapp.com/mcp');
  });
});
