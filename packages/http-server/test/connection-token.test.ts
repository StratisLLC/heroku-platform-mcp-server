import { describe, expect, it } from 'vitest';
import {
  hashToken,
  looksLikeConnectionToken,
  mintConnectionToken,
  parseBearer,
  TOKEN_PREFIX,
  timingSafeEqual,
} from '../src/auth/connection-token.js';

describe('mintConnectionToken', () => {
  it('returns a hmcp_-prefixed string with at least 256 bits of entropy in body', () => {
    const t = mintConnectionToken();
    expect(t.plaintext.startsWith(TOKEN_PREFIX)).toBe(true);
    const body = t.plaintext.slice(TOKEN_PREFIX.length);
    // 32 bytes → 43 base64url chars (no padding).
    expect(body).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it('every call returns a distinct token', () => {
    const a = mintConnectionToken();
    const b = mintConnectionToken();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(timingSafeEqual(a.hash, b.hash)).toBe(false);
  });
  it('hash matches SHA-256(plaintext)', () => {
    const t = mintConnectionToken();
    const recomputed = hashToken(t.plaintext);
    expect(timingSafeEqual(t.hash, recomputed)).toBe(true);
  });
});

describe('parseBearer', () => {
  it('returns the token from a well-formed header', () => {
    expect(parseBearer('Bearer hmcp_abc')).toBe('hmcp_abc');
  });
  it('handles case-insensitive scheme', () => {
    expect(parseBearer('bearer hmcp_abc')).toBe('hmcp_abc');
    expect(parseBearer('BEARER hmcp_abc')).toBe('hmcp_abc');
  });
  it('returns null for missing/empty/wrong-scheme headers', () => {
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer('')).toBeNull();
    expect(parseBearer('Basic abc')).toBeNull();
    expect(parseBearer('Bearer ')).toBeNull();
    expect(parseBearer('Bearer   ')).toBeNull();
  });
});

describe('looksLikeConnectionToken', () => {
  it('accepts well-formed values', () => {
    const t = mintConnectionToken();
    expect(looksLikeConnectionToken(t.plaintext)).toBe(true);
  });
  it('rejects values without the prefix', () => {
    expect(looksLikeConnectionToken('not_hmcp_abc')).toBe(false);
  });
  it('rejects values that are too short', () => {
    expect(looksLikeConnectionToken('hmcp_short')).toBe(false);
  });
});
