import { describe, expect, it, vi } from 'vitest';
import { TransportManager, generateSessionId } from '../src/mcp/transport.js';

function fakeSessionEntry(userId: string, tokenId: string) {
  return {
    userId,
    connectionTokenId: tokenId,
    built: {
      server: { close: vi.fn(async () => undefined) },
    } as unknown as {
      server: { close: () => Promise<void> };
    } & Record<string, unknown>,
    transport: {} as unknown as Record<string, unknown>,
    clientName: null,
    clientVersion: null,
  };
}

describe('TransportManager', () => {
  it('registers and looks up sessions by id', () => {
    const tm = new TransportManager();
    const id = generateSessionId();
    tm.register(fakeSessionEntry('u1', 't1') as never, id);
    const found = tm.get(id);
    expect(found?.userId).toBe('u1');
    expect(tm.size()).toBe(1);
  });

  it('returns undefined for unknown ids', () => {
    const tm = new TransportManager();
    expect(tm.get('nope')).toBeUndefined();
    expect(tm.get(undefined)).toBeUndefined();
    expect(tm.get(null)).toBeUndefined();
  });

  it('removes sessions on remove()', () => {
    const tm = new TransportManager();
    const id = generateSessionId();
    tm.register(fakeSessionEntry('u1', 't1') as never, id);
    tm.remove(id);
    expect(tm.get(id)).toBeUndefined();
    expect(tm.size()).toBe(0);
  });

  it('evictByUser removes only sessions for the given user', () => {
    const tm = new TransportManager();
    tm.register(fakeSessionEntry('u1', 't1') as never, 'a');
    tm.register(fakeSessionEntry('u1', 't2') as never, 'b');
    tm.register(fakeSessionEntry('u2', 't3') as never, 'c');
    expect(tm.evictByUser('u1')).toBe(2);
    expect(tm.size()).toBe(1);
    expect(tm.get('c')).toBeTruthy();
  });

  it('evictByConnectionToken removes only sessions for that token', () => {
    const tm = new TransportManager();
    tm.register(fakeSessionEntry('u1', 't1') as never, 'a');
    tm.register(fakeSessionEntry('u1', 't2') as never, 'b');
    expect(tm.evictByConnectionToken('t1')).toBe(1);
    expect(tm.size()).toBe(1);
    expect(tm.get('b')).toBeTruthy();
  });

  it('collectIdle evicts sessions past the TTL', () => {
    const tm = new TransportManager();
    const id = generateSessionId();
    tm.register(fakeSessionEntry('u1', 't1') as never, id);
    const farFuture = Date.now() + 2 * 60 * 60 * 1000;
    expect(tm.collectIdle(farFuture)).toBe(1);
    expect(tm.size()).toBe(0);
  });
});
