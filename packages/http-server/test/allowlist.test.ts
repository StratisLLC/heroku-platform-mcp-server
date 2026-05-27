import { describe, expect, it } from 'vitest';
import { evaluateAccess, isAdminEmail, maskEmail } from '../src/access/allowlist.js';

describe('evaluateAccess — neither list set', () => {
  it('allows any identity', () => {
    expect(
      evaluateAccess(
        { email: 'anyone@example.com', herokuId: 'u', teams: [] },
        { allowedEmails: null, allowedTeams: null },
      ),
    ).toEqual({ allowed: true });
  });
});

describe('evaluateAccess — emails only', () => {
  const cfg = { allowedEmails: ['alice@example.com'], allowedTeams: null };
  it('allows a matching email', () => {
    expect(evaluateAccess({ email: 'alice@example.com', herokuId: 'u', teams: [] }, cfg)).toEqual({
      allowed: true,
    });
  });
  it('matches case-insensitively', () => {
    expect(evaluateAccess({ email: 'ALICE@Example.COM', herokuId: 'u', teams: [] }, cfg)).toEqual({
      allowed: true,
    });
  });
  it('rejects a non-matching email', () => {
    expect(evaluateAccess({ email: 'bob@example.com', herokuId: 'u', teams: [] }, cfg)).toEqual({
      allowed: false,
      reason: 'email_not_allowed',
    });
  });
});

describe('evaluateAccess — teams only', () => {
  const cfg = { allowedEmails: null, allowedTeams: ['eng'] };
  it('allows a member of an allowed team', () => {
    expect(
      evaluateAccess({ email: 'x@y.com', herokuId: 'u', teams: ['eng', 'sales'] }, cfg),
    ).toEqual({ allowed: true });
  });
  it('matches case-insensitively', () => {
    expect(evaluateAccess({ email: 'x@y.com', herokuId: 'u', teams: ['ENG'] }, cfg)).toEqual({
      allowed: true,
    });
  });
  it('rejects non-members', () => {
    expect(evaluateAccess({ email: 'x@y.com', herokuId: 'u', teams: ['ops'] }, cfg)).toEqual({
      allowed: false,
      reason: 'team_not_allowed',
    });
  });
});

describe('evaluateAccess — both lists set requires BOTH', () => {
  const cfg = { allowedEmails: ['alice@example.com'], allowedTeams: ['eng'] };
  it('allows when email matches AND team matches', () => {
    expect(
      evaluateAccess({ email: 'alice@example.com', herokuId: 'u', teams: ['eng'] }, cfg),
    ).toEqual({ allowed: true });
  });
  it('rejects when only email matches', () => {
    expect(
      evaluateAccess({ email: 'alice@example.com', herokuId: 'u', teams: ['ops'] }, cfg),
    ).toEqual({ allowed: false, reason: 'team_not_allowed' });
  });
  it('rejects when only team matches', () => {
    expect(
      evaluateAccess({ email: 'bob@example.com', herokuId: 'u', teams: ['eng'] }, cfg),
    ).toEqual({ allowed: false, reason: 'email_not_allowed' });
  });
  it('rejects with no_match when neither matches', () => {
    expect(
      evaluateAccess({ email: 'bob@example.com', herokuId: 'u', teams: ['ops'] }, cfg),
    ).toEqual({ allowed: false, reason: 'no_match' });
  });
});

describe('maskEmail', () => {
  it('keeps the first letter and the domain', () => {
    expect(maskEmail('alice@stratis.com')).toBe('a***@stratis.com');
  });
  it('handles single-character local parts', () => {
    expect(maskEmail('a@b.com')).toBe('a***@b.com');
  });
  it('returns *** for malformed inputs', () => {
    expect(maskEmail('no-at-sign')).toBe('***');
    expect(maskEmail('@nolocal.com')).toBe('***');
  });
});

describe('isAdminEmail', () => {
  it('matches in case-insensitive way', () => {
    expect(isAdminEmail('Admin@Example.COM', ['admin@example.com'])).toBe(true);
  });
  it('returns false when no admins are configured', () => {
    expect(isAdminEmail('anyone@example.com', [])).toBe(false);
  });
  it('does not match by substring', () => {
    expect(isAdminEmail('not-admin@example.com', ['admin@example.com'])).toBe(false);
  });
});
