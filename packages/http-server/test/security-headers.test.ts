/**
 * Security headers are set on every response (F2 hardening).
 */

import { describe, expect, it } from 'vitest';
import { buildRig } from './helpers/wiring.js';

describe('security headers', () => {
  const expected: [string, string][] = [
    ['strict-transport-security', 'max-age=31536000; includeSubDomains'],
    ['x-frame-options', 'DENY'],
    ['x-content-type-options', 'nosniff'],
    ['referrer-policy', 'strict-origin-when-cross-origin'],
  ];

  it('sets HSTS, frame, nosniff and referrer headers on the landing page', async () => {
    const rig = buildRig();
    const res = await rig.app.request('/');
    for (const [name, value] of expected) {
      expect(res.headers.get(name)).toBe(value);
    }
  });

  it('sets the same headers on /mcp (JSON API path)', async () => {
    const rig = buildRig();
    // No bearer token → 401, but the headers run first and must still be present.
    const res = await rig.app.request('/mcp', { method: 'POST' });
    for (const [name, value] of expected) {
      expect(res.headers.get(name)).toBe(value);
    }
  });
});
