/**
 * MCP connection token issuance + verification.
 *
 * Token format: `hmcp_` + 43 chars base64url (32 random bytes → 43 base64url
 * chars without padding). 256 bits of entropy.
 *
 * Storage: SHA-256(token) as bytea, never the plaintext.
 *
 * Verification is constant-time: the bearer header is hashed and the hash is
 * compared via Postgres `=` on bytea. (PG's equality is not strictly
 * constant-time over rows, but we look up exactly one row by indexed hash —
 * timing-side-channel exposure is bounded to the network IO it took to do the
 * point lookup, which is already non-deterministic.)
 */

import { createHash, randomBytes } from 'node:crypto';
import { timingSafeEqualBytes } from '@heroku-mcp/core';

export const TOKEN_PREFIX = 'hmcp_';
/** Bytes of randomness behind each token; 32B → 43 base64url chars. */
export const TOKEN_RANDOM_BYTES = 32;

export interface MintedToken {
  /** Full plaintext token including the `hmcp_` prefix. Shown to the user
   *  once; never persisted. */
  plaintext: string;
  /** SHA-256 hash of {@link plaintext} as raw bytes. Stored as bytea. */
  hash: Uint8Array;
}

/** Generate a fresh token. */
export function mintConnectionToken(): MintedToken {
  const raw = randomBytes(TOKEN_RANDOM_BYTES);
  const body = raw.toString('base64url');
  const plaintext = `${TOKEN_PREFIX}${body}`;
  const hash = hashToken(plaintext);
  return { plaintext, hash };
}

/** Compute the SHA-256 hash of a token plaintext. */
export function hashToken(token: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(token).digest());
}

/** Parse a `Authorization: Bearer hmcp_...` header. Returns the token
 *  plaintext or null if missing/malformed. */
export function parseBearer(header: string | undefined | null): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith('bearer ')) return null;
  const value = trimmed.slice(7).trim();
  if (value.length === 0) return null;
  return value;
}

/** Shape-check a token plaintext. We don't enforce the exact base64url length
 *  here; the SHA-256 lookup is the real check. This is a fast bail-out for
 *  obviously wrong values. */
export function looksLikeConnectionToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX) && token.length >= TOKEN_PREFIX.length + 20;
}

/** Constant-time compare two byte arrays. Re-exported for convenience. */
export const timingSafeEqual = timingSafeEqualBytes;
