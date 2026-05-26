import { describe, expect, it } from 'vitest';
import {
  ConfirmationRequiredError,
  assertConfirm,
  formatConfirmationError,
} from '../src/confirm.js';
import { ConfirmationMismatchError, isHerokuError } from '../src/errors.js';

describe('assertConfirm', () => {
  it('returns silently when confirm matches', () => {
    expect(() =>
      assertConfirm({ value: 'myapp', expected: 'myapp', targetKind: 'app' }),
    ).not.toThrow();
  });

  it('throws ConfirmationRequiredError when confirm is missing', () => {
    let caught: unknown;
    try {
      assertConfirm({ value: undefined, expected: 'myapp', targetKind: 'app' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfirmationRequiredError);
    expect(caught).toBeInstanceOf(ConfirmationMismatchError);
    expect(isHerokuError(caught)).toBe(true);
    const env = (caught as ConfirmationRequiredError).toToolEnvelope();
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.kind).toBe('confirmation');
      expect(env.error.details).toMatchObject({
        kind: 'confirmation_required',
        expected: 'myapp',
        target_kind: 'app',
        reason: 'destructive operation',
      });
    }
  });

  it('throws when confirm is the empty string', () => {
    expect(() => assertConfirm({ value: '', expected: 'myapp', targetKind: 'app' })).toThrow(
      ConfirmationRequiredError,
    );
  });

  it('throws when confirm is mismatched and surfaces the received value', () => {
    let caught: ConfirmationRequiredError | undefined;
    try {
      assertConfirm({ value: 'oops', expected: 'myapp', targetKind: 'app' });
    } catch (err) {
      caught = err as ConfirmationRequiredError;
    }
    expect(caught).toBeInstanceOf(ConfirmationRequiredError);
    expect(caught!.received).toBe('oops');
    const env = caught!.toToolEnvelope();
    if (env.ok === false) {
      expect(env.error.message).toMatch(/destructive/i);
    }
  });

  it('is case-sensitive: mismatched case throws', () => {
    expect(() => assertConfirm({ value: 'MyApp', expected: 'myapp', targetKind: 'app' })).toThrow(
      ConfirmationRequiredError,
    );
  });

  it('is whitespace-sensitive: leading/trailing whitespace is not trimmed', () => {
    expect(() => assertConfirm({ value: ' myapp', expected: 'myapp', targetKind: 'app' })).toThrow(
      ConfirmationRequiredError,
    );
    expect(() => assertConfirm({ value: 'myapp ', expected: 'myapp', targetKind: 'app' })).toThrow(
      ConfirmationRequiredError,
    );
  });

  it('preserves the target kind on the envelope', () => {
    let caught: ConfirmationRequiredError | undefined;
    try {
      assertConfirm({ value: undefined, expected: 'pg-prod', targetKind: 'addon' });
    } catch (err) {
      caught = err as ConfirmationRequiredError;
    }
    const env = caught!.toToolEnvelope();
    if (env.ok === false) {
      expect((env.error.details as { target_kind?: string }).target_kind).toBe('addon');
    }
  });
});

describe('formatConfirmationError', () => {
  it('produces an envelope without throwing', () => {
    const env = formatConfirmationError({
      expected: 'sample.com',
      targetKind: 'domain',
      reason: 'destructive operation',
    });
    expect(env.ok).toBe(false);
    if (env.ok === false) {
      expect(env.error.kind).toBe('confirmation');
      expect((env.error.details as { expected?: string }).expected).toBe('sample.com');
    }
  });
});
