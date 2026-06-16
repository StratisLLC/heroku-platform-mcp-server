import { describe, expect, it } from 'vitest';
import { DEFAULT_REDACTED_PLACEHOLDER, redact, redactToJson, scrubString } from '../src/redact.js';

const R = DEFAULT_REDACTED_PLACEHOLDER;

describe('redact — sensitive keys', () => {
  it('redacts each default sensitive key', () => {
    const input = {
      password: 'p',
      token: 't',
      secret: 's',
      client_secret: 'cs',
      access_token: 'at',
      refresh_token: 'rt',
      api_key: 'ak',
      Authorization: 'Bearer x',
    };
    const out = redact(input) as Record<string, string>;
    for (const v of Object.values(out)) expect(v).toBe(R);
  });

  it('matches keys case-insensitively', () => {
    const input = { Token: 'x', TOKEN: 'y', tOkEn: 'z' };
    expect(redact(input)).toEqual({ Token: R, TOKEN: R, tOkEn: R });
  });

  it('does not mutate the input', () => {
    const input = { token: 'abc', nested: { secret: 'def' } };
    const snapshot = structuredClone(input);
    redact(input);
    expect(input).toEqual(snapshot);
  });

  it('preserves non-sensitive keys verbatim', () => {
    const input = { name: 'my-app', region: 'us', id: 'uuid-here' };
    expect(redact(input)).toEqual(input);
  });

  it('works inside arrays', () => {
    const input = [{ token: 'a' }, { token: 'b' }];
    expect(redact(input)).toEqual([{ token: R }, { token: R }]);
  });

  it('handles deeply nested sensitive keys', () => {
    const input = { a: { b: { c: { password: 'x' } } } };
    expect(redact(input)).toEqual({ a: { b: { c: { password: R } } } });
  });

  it('accepts additional sensitive keys via options', () => {
    const input = { my_thing: 'v', other: 'ok' };
    expect(redact(input, { additionalSensitiveKeys: ['my_thing'] })).toEqual({
      my_thing: R,
      other: 'ok',
    });
  });

  it('respects a custom placeholder', () => {
    expect(redact({ token: 'x' }, { placeholder: '***' })).toEqual({ token: '***' });
  });
});

describe('redact — config_vars treatment', () => {
  it('redacts every string value under config_vars regardless of inner key', () => {
    const input = {
      app: 'ex',
      config_vars: { DATABASE_URL: 'postgres://...', FOO: 'bar', BAZ: 'qux' },
    };
    expect(redact(input)).toEqual({
      app: 'ex',
      config_vars: { DATABASE_URL: R, FOO: R, BAZ: R },
    });
  });

  it('preserves null values inside config_vars (Heroku uses null for deletion)', () => {
    expect(redact({ config_vars: { A: 'x', B: null } })).toEqual({
      config_vars: { A: R, B: null },
    });
  });

  it('matches config_vars case-insensitively', () => {
    expect(redact({ Config_Vars: { A: 'x' } })).toEqual({ Config_Vars: { A: R } });
  });

  it('accepts additional secret-map keys', () => {
    expect(redact({ env: { A: 'x', B: 'y' } }, { additionalSecretMapKeys: ['env'] })).toEqual({
      env: { A: R, B: R },
    });
  });
});

describe('redact — token scrubbing inside strings', () => {
  it('redacts a Heroku API token embedded in an error message', () => {
    expect(redact('auth failed for HRKU-abc-123 — retry')).toBe(`auth failed for ${R} — retry`);
  });

  it('redacts multiple tokens in one string', () => {
    expect(redact('first HRKU-aaa second HRKU-bbb')).toBe(`first ${R} second ${R}`);
  });

  it('matches HRKU pattern case-insensitively', () => {
    expect(scrubString('hrku-AbCd-1234')).toBe(R);
  });

  it("preserves the 'Bearer ' prefix on bearer-style tokens", () => {
    expect(redact('Authorization: Bearer HRKU-xyz')).toBe(`Authorization: Bearer ${R}`);
  });

  it('does not over-match — bare uppercase HRKU is not a token', () => {
    expect(redact('HRKU is the prefix')).toBe('HRKU is the prefix');
  });

  it('does not touch UUID-shaped strings that lack the HRKU prefix', () => {
    const uuid = 'a7b2c1d3-e4f5-6789-0123-456789abcdef';
    expect(redact(uuid)).toBe(uuid);
  });

  it('redacts a token even when stored at a non-sensitive key', () => {
    expect(redact({ note: 'see HRKU-aaa-111' })).toEqual({ note: `see ${R}` });
  });
});

describe('redact — adversarial inputs', () => {
  it('handles cyclic objects without exploding', () => {
    const a: Record<string, unknown> = { token: 'x' };
    a.self = a;
    const out = redact(a) as Record<string, unknown>;
    expect(out.token).toBe(R);
    expect(out.self).toBe('[CYCLE]');
  });

  it('handles cyclic arrays', () => {
    const arr: unknown[] = ['HRKU-aaa'];
    arr.push(arr);
    const out = redact(arr) as unknown[];
    expect(out[0]).toBe(R);
    expect(out[1]).toBe('[CYCLE]');
  });

  it('passes class instances through unchanged (does not mangle prototype)', () => {
    class Thing {
      token = 'should-not-redact'; // intentional — non-plain object isn't walked
    }
    const t = new Thing();
    const out = redact({ thing: t }) as { thing: Thing };
    expect(out.thing).toBe(t);
    expect(out.thing.token).toBe('should-not-redact');
  });

  it('walks plain objects created via Object.create(null)', () => {
    const obj = Object.create(null) as Record<string, unknown>;
    obj.token = 'x';
    expect(redact(obj)).toEqual({ token: R });
  });

  it('returns primitives unchanged', () => {
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
  });

  it('returns empty containers unchanged', () => {
    expect(redact({})).toEqual({});
    expect(redact([])).toEqual([]);
  });

  it('handles strings that are themselves the placeholder', () => {
    expect(redact('[REDACTED]')).toBe('[REDACTED]');
    expect(redact({ token: '[REDACTED]' })).toEqual({ token: R });
  });

  it('does not leak through symbol-keyed properties', () => {
    const sym = Symbol('token');
    const input: Record<string | symbol, unknown> = { token: 'secret' };
    input[sym] = 'also secret';
    const out = redact(input) as Record<string, unknown>;
    expect(out.token).toBe(R);
    // Symbol-keyed property is dropped because Object.entries skips Symbols. That's safe-by-default.
    expect(Object.getOwnPropertySymbols(out)).toHaveLength(0);
  });

  it('redacts an Authorization header that uses the canonical Heroku token', () => {
    const headers = { Authorization: 'Bearer HRKU-aaa-bbb-ccc', 'X-Request-Id': 'r1' };
    expect(redact(headers)).toEqual({ Authorization: R, 'X-Request-Id': 'r1' });
  });
});

describe('redactToJson', () => {
  it('produces a JSON string with secrets replaced', () => {
    const out = redactToJson({ token: 'x', app: 'name', config_vars: { A: '1' } });
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed).toEqual({ token: R, app: 'name', config_vars: { A: R } });
  });
});

describe('scrubString', () => {
  it('returns input unchanged when no tokens present', () => {
    expect(scrubString('hello world')).toBe('hello world');
  });

  it('redacts an inline HRKU token', () => {
    expect(scrubString('token=HRKU-abc-123 done')).toBe(`token=${R} done`);
  });

  it('respects a custom placeholder', () => {
    expect(scrubString('Bearer HRKU-x', '***')).toBe('Bearer ***');
  });
});
