import { describe, expect, it } from 'vitest';
import {
  AuthError,
  ConfirmationMismatchError,
  ConflictError,
  DelinquentError,
  ForbiddenError,
  HerokuError,
  InvalidParamsError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ServerError,
  isHerokuError,
  mapHttpResponseToError,
  parseHerokuErrorBody,
  toToolEnvelope,
} from '../src/errors.js';

describe('HerokuError base class', () => {
  it('preserves message, name, and instanceof Error', () => {
    const e = new AuthError('nope');
    expect(e.message).toBe('nope');
    expect(e.name).toBe('AuthError');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(HerokuError);
    expect(e).toBeInstanceOf(AuthError);
  });

  it('carries the optional context fields through to the envelope', () => {
    const e = new NotFoundError('missing app', {
      status: 404,
      herokuId: 'not_found',
      requestId: 'abc-123',
      docUrl: 'https://devcenter.heroku.com/articles/platform-api-reference#errors',
      url: 'https://api.heroku.com/apps/x',
    });
    expect(e.toToolEnvelope()).toEqual({
      ok: false,
      error: {
        kind: 'not_found',
        message: 'missing app',
        status: 404,
        herokuId: 'not_found',
        requestId: 'abc-123',
        docUrl: 'https://devcenter.heroku.com/articles/platform-api-reference#errors',
      },
    });
  });

  it('does not include keys whose values were not provided', () => {
    const e = new ServerError('boom');
    const env = e.toToolEnvelope();
    expect(Object.keys(env.error)).toEqual(['kind', 'message']);
  });

  it('attaches cause when provided', () => {
    const cause = new Error('root');
    const e = new NetworkError('DNS failed', { cause });
    expect(e.cause).toBe(cause);
  });

  it('each subclass exposes a fixed kind', () => {
    expect(new AuthError('').kind).toBe('auth');
    expect(new ForbiddenError('').kind).toBe('forbidden');
    expect(new NotFoundError('').kind).toBe('not_found');
    expect(new DelinquentError('').kind).toBe('delinquent');
    expect(new RateLimitError('').kind).toBe('rate_limit');
    expect(new InvalidParamsError('').kind).toBe('invalid_params');
    expect(new ConflictError('').kind).toBe('conflict');
    expect(new ServerError('').kind).toBe('server');
    expect(new NetworkError('').kind).toBe('network');
    expect(new ConfirmationMismatchError('app', 'a', 'b').kind).toBe('confirmation');
  });
});

describe('RateLimitError details', () => {
  it('surfaces retryAfterMs and remaining via details', () => {
    const e = new RateLimitError('limited', { retryAfterMs: 5000, remaining: 0 });
    expect(e.toToolEnvelope().error.details).toEqual({ retryAfterMs: 5000, remaining: 0 });
  });

  it('omits details when no extras provided', () => {
    const e = new RateLimitError('limited');
    expect(e.toToolEnvelope().error.details).toBeUndefined();
  });
});

describe('InvalidParamsError fields', () => {
  it('surfaces fields when provided', () => {
    const e = new InvalidParamsError('bad', { fields: ['name', 'region'] });
    expect(e.toToolEnvelope().error.details).toEqual({ fields: ['name', 'region'] });
  });

  it('does not populate details when fields list is empty', () => {
    const e = new InvalidParamsError('bad');
    expect(e.toToolEnvelope().error.details).toBeUndefined();
  });
});

describe('ConfirmationMismatchError', () => {
  it('captures target / expected / received and surfaces them in details', () => {
    const e = new ConfirmationMismatchError('app', 'my-app', 'my-ap');
    expect(e.target).toBe('app');
    expect(e.expected).toBe('my-app');
    expect(e.received).toBe('my-ap');
    expect(e.toToolEnvelope().error.details).toEqual({
      target: 'app',
      expected: 'my-app',
      received: 'my-ap',
    });
    expect(e.message).toMatch(/expected "my-app", got "my-ap"/);
  });
});

describe('parseHerokuErrorBody', () => {
  it('returns the canonical shape for a well-formed body', () => {
    expect(
      parseHerokuErrorBody({
        id: 'not_found',
        message: 'Not found.',
        url: 'https://devcenter.heroku.com/x',
      }),
    ).toEqual({
      id: 'not_found',
      message: 'Not found.',
      url: 'https://devcenter.heroku.com/x',
    });
  });

  it('returns an empty object for non-objects', () => {
    expect(parseHerokuErrorBody(null)).toEqual({});
    expect(parseHerokuErrorBody(undefined)).toEqual({});
    expect(parseHerokuErrorBody('oops')).toEqual({});
    expect(parseHerokuErrorBody(42)).toEqual({});
    expect(parseHerokuErrorBody([])).toEqual({});
  });

  it('strips fields with wrong types', () => {
    expect(parseHerokuErrorBody({ id: 1, message: ['x'], url: null })).toEqual({});
  });

  it('tolerates extra keys', () => {
    expect(parseHerokuErrorBody({ id: 'x', message: 'y', extra: 99 })).toEqual({
      id: 'x',
      message: 'y',
    });
  });
});

describe('mapHttpResponseToError', () => {
  const base = {
    url: 'https://api.heroku.com/apps/example',
    requestId: 'req-1',
  };

  it('maps 401 to AuthError', () => {
    const e = mapHttpResponseToError({
      ...base,
      status: 401,
      body: { id: 'unauthorized', message: 'Bad token.' },
    });
    expect(e).toBeInstanceOf(AuthError);
    expect(e.herokuId).toBe('unauthorized');
    expect(e.message).toBe('Bad token.');
    expect(e.requestId).toBe('req-1');
  });

  it('maps 402 to DelinquentError', () => {
    const e = mapHttpResponseToError({
      ...base,
      status: 402,
      body: { id: 'delinquent', message: 'Pay up.' },
    });
    expect(e).toBeInstanceOf(DelinquentError);
  });

  it('maps 403 to ForbiddenError and preserves herokuId for suspension', () => {
    const e = mapHttpResponseToError({
      ...base,
      status: 403,
      body: { id: 'suspended', message: 'App suspended.' },
    });
    expect(e).toBeInstanceOf(ForbiddenError);
    expect(e.herokuId).toBe('suspended');
  });

  it('maps 404, 409, 422, 400 to their respective classes', () => {
    expect(mapHttpResponseToError({ ...base, status: 404, body: {} })).toBeInstanceOf(
      NotFoundError,
    );
    expect(mapHttpResponseToError({ ...base, status: 409, body: {} })).toBeInstanceOf(
      ConflictError,
    );
    expect(mapHttpResponseToError({ ...base, status: 422, body: {} })).toBeInstanceOf(
      InvalidParamsError,
    );
    expect(mapHttpResponseToError({ ...base, status: 400, body: {} })).toBeInstanceOf(
      InvalidParamsError,
    );
  });

  it('maps 429 to RateLimitError with details', () => {
    const e = mapHttpResponseToError({
      ...base,
      status: 429,
      body: { id: 'rate_limit', message: 'Slow down.' },
      retryAfterMs: 2000,
      rateLimitRemaining: 0,
    });
    expect(e).toBeInstanceOf(RateLimitError);
    const rle = e as RateLimitError;
    expect(rle.retryAfterMs).toBe(2000);
    expect(rle.remaining).toBe(0);
  });

  it('includes invalidParamsFields when given', () => {
    const e = mapHttpResponseToError({
      ...base,
      status: 422,
      body: { id: 'invalid_params', message: 'Bad name.' },
      invalidParamsFields: ['name'],
    });
    expect((e as InvalidParamsError).fields).toEqual(['name']);
  });

  it('maps 5xx to ServerError', () => {
    expect(mapHttpResponseToError({ ...base, status: 500, body: {} })).toBeInstanceOf(ServerError);
    expect(mapHttpResponseToError({ ...base, status: 502, body: {} })).toBeInstanceOf(ServerError);
    expect(mapHttpResponseToError({ ...base, status: 503, body: {} })).toBeInstanceOf(ServerError);
  });

  it('falls back to InvalidParamsError for unrecognised 4xx', () => {
    expect(mapHttpResponseToError({ ...base, status: 418, body: {} })).toBeInstanceOf(
      InvalidParamsError,
    );
  });

  it('uses a sensible default message when body has none', () => {
    const e = mapHttpResponseToError({ ...base, status: 404, body: null });
    expect(e.message).toBe('Resource not found.');
  });

  it('survives a non-JSON body (e.g. HTML gateway error)', () => {
    const e = mapHttpResponseToError({
      ...base,
      status: 502,
      body: '<html>504 gateway timeout</html>',
    });
    expect(e).toBeInstanceOf(ServerError);
    expect(e.message).toBe('Heroku returned 502.');
  });
});

describe('toToolEnvelope', () => {
  it('passes HerokuError envelopes through unchanged', () => {
    const e = new AuthError('bad');
    expect(toToolEnvelope(e)).toEqual(e.toToolEnvelope());
  });

  it('maps unknown errors to a server-kind envelope', () => {
    expect(toToolEnvelope(new Error('oh no'))).toEqual({
      ok: false,
      error: { kind: 'server', message: 'oh no' },
    });
    expect(toToolEnvelope('string thrown')).toEqual({
      ok: false,
      error: { kind: 'server', message: 'string thrown' },
    });
  });
});

describe('isHerokuError', () => {
  it('recognises subclasses', () => {
    expect(isHerokuError(new AuthError(''))).toBe(true);
    expect(isHerokuError(new NetworkError(''))).toBe(true);
  });

  it('rejects unrelated values', () => {
    expect(isHerokuError(new Error(''))).toBe(false);
    expect(isHerokuError(null)).toBe(false);
    expect(isHerokuError({ kind: 'auth' })).toBe(false);
  });
});
