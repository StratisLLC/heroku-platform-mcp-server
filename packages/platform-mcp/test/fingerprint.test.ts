import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { TOKEN_FINGERPRINT_LENGTH, fingerprintToken } from '../src/fingerprint.js';

describe('fingerprintToken', () => {
  it('returns the first 16 hex chars of SHA-256(token)', () => {
    const token = 'HRKU-deadbeef';
    const expected = createHash('sha256').update(token).digest('hex').slice(0, 16);
    expect(fingerprintToken(token)).toBe(expected);
    expect(fingerprintToken(token)).toHaveLength(TOKEN_FINGERPRINT_LENGTH);
  });

  it('is deterministic and distinct for distinct tokens', () => {
    const a = fingerprintToken('HRKU-a');
    const b = fingerprintToken('HRKU-b');
    expect(a).not.toBe(b);
    expect(fingerprintToken('HRKU-a')).toBe(a);
  });
});
