import { describe, expect, it } from 'vitest';
import { buildDryRunResponse, sanitizeHeaders } from '../src/dry-run.js';

describe('buildDryRunResponse', () => {
  it('returns the documented dry-run envelope shape', () => {
    const result = buildDryRunResponse({
      method: 'DELETE',
      url: 'https://api.heroku.com/apps/demo',
      headers: { Accept: 'application/vnd.heroku+json; version=3' },
      description: "Would delete app 'demo'.",
    });
    expect(result).toEqual({
      ok: true,
      dry_run: true,
      data: {
        request: {
          method: 'DELETE',
          url: 'https://api.heroku.com/apps/demo',
          headers: { Accept: 'application/vnd.heroku+json; version=3' },
          body: null,
        },
        description: "Would delete app 'demo'.",
      },
      meta: { requestId: null, rateLimitRemaining: null, cached: false },
    });
  });

  it('strips Authorization-like headers from the preview', () => {
    const result = buildDryRunResponse({
      method: 'POST',
      url: 'https://api.heroku.com/apps',
      headers: {
        Authorization: 'Bearer HRKU-shouldnt-appear',
        'Proxy-Authorization': 'Bearer HRKU-also-bad',
        Cookie: 'session=xyz',
        'X-Api-Key': 'k',
        Accept: 'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json',
      },
      body: { name: 'demo' },
      description: 'Create demo app.',
    });
    expect(result.data.request.headers).toEqual({
      Accept: 'application/vnd.heroku+json; version=3',
      'Content-Type': 'application/json',
    });
    expect(JSON.stringify(result)).not.toContain('HRKU-shouldnt-appear');
    expect(JSON.stringify(result)).not.toContain('HRKU-also-bad');
    expect(JSON.stringify(result)).not.toContain('session=xyz');
  });

  it('threads rateLimitRemaining when provided', () => {
    const result = buildDryRunResponse({
      method: 'PATCH',
      url: 'https://api.heroku.com/apps/demo',
      body: { maintenance: true },
      description: 'Enable maintenance.',
      rateLimitRemaining: 2400,
    });
    expect(result.meta.rateLimitRemaining).toBe(2400);
  });

  it('defaults body to null when omitted', () => {
    const result = buildDryRunResponse({
      method: 'DELETE',
      url: 'https://api.heroku.com/apps/demo',
      description: 'Delete the demo app.',
    });
    expect(result.data.request.body).toBeNull();
  });

  it('works with no headers given', () => {
    const result = buildDryRunResponse({
      method: 'POST',
      url: 'https://api.heroku.com/apps',
      description: 'Create.',
    });
    expect(result.data.request.headers).toEqual({});
  });
});

describe('sanitizeHeaders', () => {
  it('is case-insensitive on input', () => {
    const result = sanitizeHeaders({
      AUTHORIZATION: 'Bearer x',
      authorization: 'Bearer y',
      Accept: 'a',
    });
    expect(result).toEqual({ Accept: 'a' });
  });

  it('returns an empty object when every header is sensitive', () => {
    expect(sanitizeHeaders({ Authorization: 'Bearer x', Cookie: 'c' })).toEqual({});
  });
});
