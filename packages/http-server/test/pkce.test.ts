import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { makePkcePair, makeStateToken } from '../src/oauth/pkce.js';

describe('makePkcePair', () => {
  it('returns a valid PKCE verifier + challenge pair', () => {
    const pair = makePkcePair();
    expect(pair.method).toBe('S256');
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    // challenge MUST equal base64url(sha256(verifier)).
    const expected = createHash('sha256').update(pair.verifier).digest('base64url');
    expect(pair.challenge).toBe(expected);
  });
  it('returns a different pair every call', () => {
    const a = makePkcePair();
    const b = makePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe('makeStateToken', () => {
  it('returns base64url with sufficient length', () => {
    const t = makeStateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(43);
  });
  it('is unique per call', () => {
    expect(makeStateToken()).not.toBe(makeStateToken());
  });
});
