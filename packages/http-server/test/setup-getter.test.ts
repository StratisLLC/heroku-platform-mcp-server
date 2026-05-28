/**
 * Verifies that `buildSessionMcp` wires its `getAccessToken` getter through to
 * the core HTTP client per request — i.e. completes the v0.2.3 fix that
 * makes the token resolve on every call rather than only at session creation.
 *
 * The resolver's own refresh logic is covered in flow.test.ts; here we only
 * check the lifecycle wiring (getter is a function, invoked per request,
 * errors from it surface as a kind:'auth' tool envelope).
 */

import { describe, expect, it, vi } from 'vitest';
import { AuthError, toToolEnvelope } from '@heroku-mcp/core';
import { buildSessionMcp } from '../src/mcp/setup.js';

function alwaysOkFetch(): typeof globalThis.fetch {
  // Probes + tool calls — everything succeeds with an empty JSON body. The
  // prober only cares about HTTP status, and we never inspect the body in
  // these tests.
  return (async () =>
    new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
}

describe('buildSessionMcp — per-request token resolution (v0.2.3)', () => {
  it('invokes getAccessToken on every Heroku request, not just at session creation', async () => {
    const getAccessToken = vi.fn(async () => 'AT-token');
    const built = await buildSessionMcp({
      getAccessToken,
      tokenFingerprint: 'fp1',
      auditSink: async () => undefined,
      getAuditContext: () => ({ userId: 'u1', clientName: null, clientVersion: null }),
      fetch: alwaysOkFetch(),
    });

    const afterBuild = getAccessToken.mock.calls.length;
    // Probing alone invokes the getter at least once.
    expect(afterBuild).toBeGreaterThan(0);

    await built.context.client.get('/account');
    expect(getAccessToken.mock.calls.length).toBe(afterBuild + 1);

    await built.context.client.get('/account');
    expect(getAccessToken.mock.calls.length).toBe(afterBuild + 2);
  });

  it('surfaces an AuthError thrown by the getter as a kind:auth tool envelope', async () => {
    // The route wraps ReauthRequiredError into AuthError with `details.code` =
    // 'reauth_required' so the platform-mcp `runTool` wrapper renders the
    // failure as kind:'auth' (not the generic kind:'server' that a bare
    // Error would produce).
    let initialised = false;
    const getAccessToken = async (): Promise<string> => {
      if (!initialised) {
        initialised = true;
        return 'AT-startup';
      }
      throw new AuthError('Your Heroku authorization has expired.', {
        details: { code: 'reauth_required', signInUrl: 'https://example.test/sign-in' },
      });
    };
    const built = await buildSessionMcp({
      getAccessToken,
      tokenFingerprint: 'fp2',
      auditSink: async () => undefined,
      getAuditContext: () => ({ userId: 'u1', clientName: null, clientVersion: null }),
      fetch: alwaysOkFetch(),
    });

    let captured: unknown;
    try {
      await built.context.client.get('/account');
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(AuthError);
    const env = toToolEnvelope(captured);
    expect(env.ok).toBe(false);
    expect(env.error.kind).toBe('auth');
    expect(env.error.details).toMatchObject({
      code: 'reauth_required',
      signInUrl: 'https://example.test/sign-in',
    });
  });

  it('regression: valid token round-trips through the getter without buildSessionMcp caching it', async () => {
    let calls = 0;
    const getAccessToken = async (): Promise<string> => {
      calls += 1;
      return 'AT-stable';
    };
    const built = await buildSessionMcp({
      getAccessToken,
      tokenFingerprint: 'fp3',
      auditSink: async () => undefined,
      getAuditContext: () => ({ userId: 'u1', clientName: null, clientVersion: null }),
      fetch: alwaysOkFetch(),
    });

    const baseline = calls;
    await built.context.client.get('/account');
    expect(calls).toBe(baseline + 1);
    await built.context.client.get('/account');
    expect(calls).toBe(baseline + 2);
  });
});
