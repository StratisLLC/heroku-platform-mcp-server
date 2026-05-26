/**
 * Token fingerprinting (ARCHITECTURE.md §5.3, §10).
 *
 * The fingerprint is the first 16 hex chars of SHA-256(token) and is used as
 * the cache-file key for capability results and as the `tokenFp` field in
 * audit log entries. The raw token never leaves the process — only the
 * fingerprint does.
 */

import { createHash } from 'node:crypto';

/** Length of the fingerprint in hex chars. 16 is enough to avoid practical
 *  collisions across one person's set of tokens while staying short enough
 *  to be readable in a filename. */
export const TOKEN_FINGERPRINT_LENGTH = 16;

/** Compute the fingerprint for a token. */
export function fingerprintToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, TOKEN_FINGERPRINT_LENGTH);
}
