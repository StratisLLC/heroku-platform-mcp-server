/**
 * Integration: the per-IP rate limiter is wired onto /oauth/register in the
 * real app, and does not interfere with a legitimate single registration.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRig } from '../helpers/wiring.js';

const ENV_KEYS = ['HEROKUMCP_RL_REGISTER_MAX', 'HEROKUMCP_RL_REGISTER_WINDOW_MS'] as const;

function registerFrom(
  app: import('hono').Hono<import('../../src/auth/middleware.js').AppEnv>,
  ip: string,
): Promise<Response> {
  return Promise.resolve(
    app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ redirect_uris: ['https://claude.ai/oauth-callback'] }),
    }),
  );
}

describe('/oauth/register rate limiting (integration)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.HEROKUMCP_RL_REGISTER_MAX = '2';
    process.env.HEROKUMCP_RL_REGISTER_WINDOW_MS = String(10 * 60 * 1000);
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('429s the (max+1)th registration from one IP, leaving other IPs unaffected', async () => {
    const rig = buildRig();
    expect((await registerFrom(rig.app, '203.0.113.7')).status).toBe(201);
    expect((await registerFrom(rig.app, '203.0.113.7')).status).toBe(201);

    const blocked = await registerFrom(rig.app, '203.0.113.7');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).not.toBeNull();

    // A different client IP still gets through.
    expect((await registerFrom(rig.app, '198.51.100.4')).status).toBe(201);
  });

  it('a single legitimate registration succeeds', async () => {
    const rig = buildRig();
    const res = await registerFrom(rig.app, '198.51.100.42');
    expect(res.status).toBe(201);
  });
});
