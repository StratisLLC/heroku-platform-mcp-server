/**
 * Registration-time redirect_uri validation (RFC 7591 `invalid_redirect_uri`).
 *
 * The DCR endpoint rejects placeholder / non-routable redirect hosts so a live
 * client can't sit in the store pointing at a domain the operator does not
 * control:
 *   - RFC 2606 example domains are ALWAYS rejected.
 *   - localhost / loopback are rejected in production, permitted only when
 *     HEROKUMCP_ALLOW_INSECURE_REDIRECTS is set for local dev.
 *   - Real https callbacks and custom-scheme URIs (cursor://, …) pass.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRig } from '../helpers/wiring.js';
import { envBool, validateRedirectUri } from '../../src/oauth-provider/dcr.js';

const FLAG = 'HEROKUMCP_ALLOW_INSECURE_REDIRECTS';

function register(
  app: import('hono').Hono<import('../../src/auth/middleware.js').AppEnv>,
  body: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /oauth/register redirect_uri validation', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[FLAG];
    delete process.env[FLAG];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  });

  it('rejects an RFC 2606 example domain (https://example.com/cb)', async () => {
    const rig = buildRig();
    const res = await register(rig.app, { redirect_uris: ['https://example.com/cb'] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('rejects http://localhost/cb when the escape hatch is unset', async () => {
    const rig = buildRig();
    const res = await register(rig.app, { redirect_uris: ['http://localhost/cb'] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('allows http://localhost/cb when HEROKUMCP_ALLOW_INSECURE_REDIRECTS=1', async () => {
    process.env[FLAG] = '1';
    const rig = buildRig();
    const res = await register(rig.app, { redirect_uris: ['http://localhost/cb'] });
    expect(res.status).toBe(201);
  });

  it('rejects http://example.org/cb even with the escape hatch on (RFC 2606 always blocked)', async () => {
    process.env[FLAG] = '1';
    const rig = buildRig();
    const res = await register(rig.app, { redirect_uris: ['http://example.org/cb'] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('allows a real https callback', async () => {
    const rig = buildRig();
    const res = await register(rig.app, {
      redirect_uris: ['https://real-customer-domain.com/oauth/callback'],
    });
    expect(res.status).toBe(201);
  });

  it('allows a custom-scheme redirect URI (cursor://…)', async () => {
    const rig = buildRig();
    const res = await register(rig.app, {
      redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback'],
    });
    expect(res.status).toBe(201);
  });

  it('rejects a garbage non-URL string', async () => {
    const rig = buildRig();
    const res = await register(rig.app, { redirect_uris: ['not a url at all'] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('rejects the whole registration if ANY redirect_uri is invalid', async () => {
    const rig = buildRig();
    const res = await register(rig.app, {
      redirect_uris: ['https://real-customer-domain.com/cb', 'https://example.com/cb'],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_redirect_uri');
    // Nothing persisted when validation fails.
    expect(rig.pool.store.oauthClients.length).toBe(0);
  });
});

describe('validateRedirectUri (unit)', () => {
  it('always blocks RFC 2606 example hosts, escape hatch notwithstanding', () => {
    for (const uri of [
      'https://example.com/cb',
      'https://www.example.com/cb',
      'http://example.org/cb',
      'https://example.net/cb',
      'https://foo.example.com/cb', // example as a non-terminal label (*.example.*)
    ]) {
      expect(validateRedirectUri(uri, { allowInsecure: true }).ok).toBe(false);
    }
  });

  it('does not treat a trailing `example` label as reserved (cursor.example)', () => {
    expect(validateRedirectUri('https://cursor.example/cb', { allowInsecure: false }).ok).toBe(
      true,
    );
  });

  it('blocks loopback hosts only without the escape hatch', () => {
    for (const uri of [
      'http://localhost/cb',
      'http://127.0.0.1/cb',
      'http://[::1]/cb',
      'http://0.0.0.0/cb',
    ]) {
      expect(validateRedirectUri(uri, { allowInsecure: false }).ok).toBe(false);
      expect(validateRedirectUri(uri, { allowInsecure: true }).ok).toBe(true);
    }
  });

  it('requires https for routable http hosts', () => {
    expect(validateRedirectUri('http://real-domain.com/cb', { allowInsecure: true }).ok).toBe(
      false,
    );
    expect(validateRedirectUri('https://real-domain.com/cb', { allowInsecure: false }).ok).toBe(
      true,
    );
  });

  it('allows custom schemes with a non-empty body', () => {
    expect(
      validateRedirectUri('cursor://anysphere.cursor-mcp/cb', { allowInsecure: false }).ok,
    ).toBe(true);
    expect(validateRedirectUri('claude-desktop://oauth', { allowInsecure: false }).ok).toBe(true);
  });
});

describe('envBool', () => {
  it('treats "1"/"true" (any case) as true, everything else as false', () => {
    for (const v of ['1', 'true', 'TRUE', 'True', ' true ']) expect(envBool(v)).toBe(true);
    for (const v of [undefined, '', '0', 'false', 'yes', 'no', 'xyz'])
      expect(envBool(v)).toBe(false);
  });
});
