/**
 * Encrypted cookie sessions.
 *
 * Two session shapes share the same machinery:
 *
 *   - hmcp_oauth_flow (5 min, SameSite=Strict) — carries OAuth state between
 *     /sign-in and /oauth/callback.
 *   - hmcp_session    (30 days, SameSite=Lax)  — web-UI sign-in cookie.
 *
 * Both are AES-256-GCM-encrypted under the master KEK. We don't sign
 * separately — GCM's auth tag IS the signature.
 *
 * Wire format (after base64url):
 *
 *   v1 | iv(12) | tag(16) | ciphertext(JSON)
 *
 * Using base64url so the cookie value is URL-safe and small.
 */

import {
  decodeFromStorage,
  decryptWithKek,
  encodeForStorage,
  encryptWithKek,
  EnvelopeDecryptError,
} from '@heroku-mcp/core';

/** Five minutes; the OAuth round-trip should never take longer. */
export const OAUTH_FLOW_TTL_MS = 5 * 60 * 1000;
/** Thirty days; the web session is sliding (touched on each request). */
export const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const OAUTH_FLOW_COOKIE = 'hmcp_oauth_flow';
export const WEB_SESSION_COOKIE = 'hmcp_session';

export interface OAuthFlowState {
  state: string;
  pkceVerifier: string;
  redirectAfterLogin: string;
  createdAt: number;
}

export interface WebSessionData {
  userId: string;
  signedInAt: number;
}

interface Envelope<T> {
  v: 1;
  /** Expiry in ms since epoch; checked at decode time. */
  exp: number;
  d: T;
}

/** Encrypt + base64url-encode a payload. */
export function sealSession<T>(payload: T, ttlMs: number, kek: Uint8Array): string {
  const envelope: Envelope<T> = {
    v: 1,
    exp: Date.now() + ttlMs,
    d: payload,
  };
  const json = new TextEncoder().encode(JSON.stringify(envelope));
  const parts = encryptWithKek(json, kek);
  const blob = encodeForStorage(parts);
  return Buffer.from(blob).toString('base64url');
}

/** Decode + decrypt + validate expiry. Returns null on any failure (the
 *  caller treats this as "no session"). */
export function openSession<T>(value: string | undefined | null, kek: Uint8Array): T | null {
  if (!value) return null;
  let blob: Buffer;
  try {
    blob = Buffer.from(value, 'base64url');
  } catch {
    return null;
  }
  let parts;
  try {
    parts = decodeFromStorage(new Uint8Array(blob));
  } catch {
    return null;
  }
  let plaintext: Uint8Array;
  try {
    plaintext = decryptWithKek(parts, kek);
  } catch (err) {
    if (err instanceof EnvelopeDecryptError) return null;
    throw err;
  }
  let envelope: Envelope<T>;
  try {
    envelope = JSON.parse(new TextDecoder().decode(plaintext)) as Envelope<T>;
  } catch {
    return null;
  }
  if (envelope.v !== 1) return null;
  if (typeof envelope.exp !== 'number' || envelope.exp < Date.now()) return null;
  return envelope.d;
}
