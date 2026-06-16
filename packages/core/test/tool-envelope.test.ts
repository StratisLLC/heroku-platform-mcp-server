import { describe, expect, it } from 'vitest';
import { envelopeFromClientSuccess, envelopeFromLocal, toolContent } from '../src/tool-envelope.js';
import type { ClientSuccess } from '../src/client.js';

const baseSuccess: ClientSuccess<{ id: string }> = {
  ok: true,
  status: 200,
  body: { id: 'abc' },
  headers: {},
  cached: false,
};

describe('envelopeFromClientSuccess', () => {
  it('wraps body unchanged and copies request meta', () => {
    const env = envelopeFromClientSuccess({
      ...baseSuccess,
      requestId: 'req-1',
      rateLimitRemaining: 4000,
    });
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({ id: 'abc' });
    expect(env.meta).toEqual({ requestId: 'req-1', rateLimitRemaining: 4000 });
  });

  it('reports cached: true when the response was an ETag hit', () => {
    const env = envelopeFromClientSuccess({ ...baseSuccess, cached: true });
    expect(env.meta.cached).toBe(true);
  });

  it('passes through pagination cursor', () => {
    const env = envelopeFromClientSuccess({
      ...baseSuccess,
      pagination: { hasMore: true, cursor: 'id 42; max=10' },
    });
    expect(env.meta.pagination).toEqual({ hasMore: true, cursor: 'id 42; max=10' });
  });
});

describe('envelopeFromLocal', () => {
  it('shapes a local payload as a success envelope with empty meta', () => {
    const env = envelopeFromLocal({ x: 1 });
    expect(env).toEqual({ ok: true, data: { x: 1 }, meta: {} });
  });
});

describe('toolContent', () => {
  it('serializes the envelope as a single TextContent item', () => {
    const env = envelopeFromLocal({ hello: 'world' });
    const content = toolContent(env);
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe('text');
    const parsed = JSON.parse(content[0]!.text) as typeof env;
    expect(parsed).toEqual(env);
  });
});
