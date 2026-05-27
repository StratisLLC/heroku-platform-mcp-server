/**
 * PKCE — Proof Key for Code Exchange (RFC 7636).
 *
 * On /sign-in we generate a 32-byte random verifier and SHA-256 it to produce
 * the challenge that Heroku's authorize endpoint sees. On /oauth/callback we
 * send the verifier back to Heroku's token endpoint; Heroku re-hashes it and
 * compares to what it stored. This prevents a network attacker who captured
 * the auth code from completing the flow without also having the verifier.
 */

import { createHash, randomBytes } from 'node:crypto';

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** Generate a fresh verifier + challenge pair. */
export function makePkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

/** Generate the opaque state token for CSRF defence. */
export function makeStateToken(): string {
  return randomBytes(32).toString('base64url');
}
