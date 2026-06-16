import { describe, expect, it } from 'vitest';
import { generateMasterKey } from '@heroku-mcp/core';
import { openSession, sealSession } from '../src/auth/session.js';

interface FlowState {
  state: string;
  pkceVerifier: string;
  redirectAfterLogin: string;
  createdAt: number;
}

const sample: FlowState = {
  state: 'state-abc',
  pkceVerifier: 'verifier-xyz',
  redirectAfterLogin: '/me',
  createdAt: Date.now(),
};

describe('sealSession / openSession', () => {
  it('round-trips a payload', () => {
    const kek = generateMasterKey();
    const sealed = sealSession<FlowState>(sample, 60_000, kek);
    const opened = openSession<FlowState>(sealed, kek);
    expect(opened).toEqual(sample);
  });

  it('returns null on the wrong key', () => {
    const kek1 = generateMasterKey();
    const kek2 = generateMasterKey();
    const sealed = sealSession(sample, 60_000, kek1);
    expect(openSession(sealed, kek2)).toBeNull();
  });

  it('returns null on a tampered cookie', () => {
    const kek = generateMasterKey();
    const sealed = sealSession(sample, 60_000, kek);
    const tampered = sealed.slice(0, -1) + (sealed.endsWith('a') ? 'b' : 'a');
    expect(openSession(tampered, kek)).toBeNull();
  });

  it('returns null on garbage input', () => {
    const kek = generateMasterKey();
    expect(openSession('!!!not-base64', kek)).toBeNull();
    expect(openSession(undefined, kek)).toBeNull();
    expect(openSession('', kek)).toBeNull();
  });

  it('returns null after expiry', async () => {
    const kek = generateMasterKey();
    const sealed = sealSession(sample, 10, kek);
    await new Promise((r) => setTimeout(r, 30));
    expect(openSession(sealed, kek)).toBeNull();
  });
});
