import { describe, expect, it } from 'vitest';
import { ETagCache } from '../src/etag.js';

describe('ETagCache basic round-trip', () => {
  it('stores and retrieves an entry', () => {
    const cache = new ETagCache();
    cache.store('GET', 'https://api.heroku.com/account', '"abc"', { email: 'a@b' });
    const entry = cache.get('GET', 'https://api.heroku.com/account');
    expect(entry?.etag).toBe('"abc"');
    expect(entry?.body).toEqual({ email: 'a@b' });
  });

  it('returns undefined for missing entries', () => {
    const cache = new ETagCache();
    expect(cache.get('GET', 'https://api.heroku.com/missing')).toBeUndefined();
  });

  it('treats methods as part of the key', () => {
    const cache = new ETagCache();
    cache.store('GET', '/x', '"g"', { method: 'GET' });
    cache.store('HEAD', '/x', '"h"', { method: 'HEAD' });
    expect(cache.get('GET', '/x')?.etag).toBe('"g"');
    expect(cache.get('HEAD', '/x')?.etag).toBe('"h"');
  });

  it('normalises method case in the key', () => {
    const cache = new ETagCache();
    cache.store('get', '/x', '"a"', 1);
    expect(cache.get('GET', '/x')?.etag).toBe('"a"');
    expect(cache.get('Get', '/x')?.etag).toBe('"a"');
  });

  it('overwrites existing entries on store', () => {
    const cache = new ETagCache();
    cache.store('GET', '/x', '"v1"', 'body1');
    cache.store('GET', '/x', '"v2"', 'body2');
    expect(cache.get('GET', '/x')?.etag).toBe('"v2"');
    expect(cache.get('GET', '/x')?.body).toBe('body2');
  });
});

describe('ETagCache TTL', () => {
  it('expires entries past their TTL', () => {
    let nowMs = 1000;
    const cache = new ETagCache({ now: () => nowMs });
    cache.store('GET', '/x', '"a"', 'body', 100);
    expect(cache.get('GET', '/x')).toBeDefined();
    nowMs = 1100;
    expect(cache.get('GET', '/x')).toBeUndefined();
  });

  it('entries with no TTL never expire', () => {
    let nowMs = 1000;
    const cache = new ETagCache({ now: () => nowMs });
    cache.store('GET', '/x', '"a"', 'body');
    nowMs = 1_000_000_000;
    expect(cache.get('GET', '/x')).toBeDefined();
  });

  it('uses defaultTtlMs when no explicit TTL given', () => {
    let nowMs = 1000;
    const cache = new ETagCache({ defaultTtlMs: 500, now: () => nowMs });
    cache.store('GET', '/x', '"a"', 'body');
    nowMs = 1400;
    expect(cache.get('GET', '/x')).toBeDefined();
    nowMs = 1500;
    expect(cache.get('GET', '/x')).toBeUndefined();
  });

  it('expired entries are evicted on access (size shrinks)', () => {
    let nowMs = 1000;
    const cache = new ETagCache({ now: () => nowMs });
    cache.store('GET', '/x', '"a"', 'body', 100);
    expect(cache.size()).toBe(1);
    nowMs = 2000;
    cache.get('GET', '/x');
    expect(cache.size()).toBe(0);
  });
});

describe('ETagCache LRU eviction', () => {
  it('evicts the oldest accessed entry when at capacity', () => {
    const cache = new ETagCache({ maxEntries: 2 });
    cache.store('GET', '/a', '"a"', 'A');
    cache.store('GET', '/b', '"b"', 'B');
    cache.store('GET', '/c', '"c"', 'C');
    expect(cache.get('GET', '/a')).toBeUndefined();
    expect(cache.get('GET', '/b')?.body).toBe('B');
    expect(cache.get('GET', '/c')?.body).toBe('C');
  });

  it('get() moves an entry to most-recently-used', () => {
    const cache = new ETagCache({ maxEntries: 2 });
    cache.store('GET', '/a', '"a"', 'A');
    cache.store('GET', '/b', '"b"', 'B');
    cache.get('GET', '/a'); // touch a
    cache.store('GET', '/c', '"c"', 'C'); // evicts b, not a
    expect(cache.get('GET', '/a')?.body).toBe('A');
    expect(cache.get('GET', '/b')).toBeUndefined();
    expect(cache.get('GET', '/c')?.body).toBe('C');
  });
});

describe('ETagCache invalidate / clear', () => {
  it('invalidate removes a single entry', () => {
    const cache = new ETagCache();
    cache.store('GET', '/x', '"a"', 'b');
    expect(cache.invalidate('GET', '/x')).toBe(true);
    expect(cache.get('GET', '/x')).toBeUndefined();
  });

  it('invalidate returns false when key absent', () => {
    const cache = new ETagCache();
    expect(cache.invalidate('GET', '/x')).toBe(false);
  });

  it('clear empties the cache', () => {
    const cache = new ETagCache();
    cache.store('GET', '/a', '"a"', 1);
    cache.store('GET', '/b', '"b"', 2);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
