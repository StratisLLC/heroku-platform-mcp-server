/**
 * Thin cookie helpers built on Hono's request/response APIs. We avoid pulling
 * in `hono/cookie` so the cookie attributes stay explicit and audit-able.
 */

import type { Context } from 'hono';

export function getCookie(c: Context, name: string): string | undefined {
  const header = c.req.header('cookie');
  if (!header) return undefined;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const k = pair.slice(0, eq).trim();
    if (k !== name) continue;
    return decodeURIComponent(pair.slice(eq + 1).trim());
  }
  return undefined;
}

export interface SetCookieOptions {
  path?: string;
  maxAgeSeconds?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export function setCookie(c: Context, name: string, value: string, opts: SetCookieOptions): void {
  const parts: string[] = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? '/'}`);
  if (opts.maxAgeSeconds !== undefined) parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  if (opts.expires !== undefined) parts.push(`Expires=${opts.expires.toUTCString()}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.sameSite !== undefined) parts.push(`SameSite=${opts.sameSite}`);
  c.header('set-cookie', parts.join('; '), { append: true });
}

export function clearCookie(c: Context, name: string, secure: boolean): void {
  setCookie(c, name, '', {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    maxAgeSeconds: 0,
  });
}
