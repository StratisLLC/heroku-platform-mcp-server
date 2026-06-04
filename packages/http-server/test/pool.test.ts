import { describe, expect, it } from 'vitest';
import { isAwsHostedPostgres, resolveSslConfig } from '../src/db/pool.js';

// A Heroku Postgres DATABASE_URL shape (host on AWS RDS).
const HEROKU_URL = 'postgres://user:pass@ec2-1-2-3-4.compute-1.amazonaws.com:5432/db';
const RDS_URL = 'postgres://user:pass@mydb.abcdef.us-east-1.rds.amazonaws.com:5432/db';
const LOCAL_URL = 'postgres://localhost:5432/test';

describe('isAwsHostedPostgres', () => {
  it('matches Heroku-style compute-1.amazonaws.com hosts', () => {
    expect(isAwsHostedPostgres(HEROKU_URL)).toBe(true);
  });
  it('matches other amazonaws.com hosts (e.g. on-prem RDS)', () => {
    expect(isAwsHostedPostgres(RDS_URL)).toBe(true);
  });
  it('does not match localhost', () => {
    expect(isAwsHostedPostgres(LOCAL_URL)).toBe(false);
  });
  it('returns false for an unparseable connection string', () => {
    expect(isAwsHostedPostgres('not a url')).toBe(false);
  });
});

describe('resolveSslConfig', () => {
  it('relaxes issuer verification for AWS-hosted Postgres by default', () => {
    expect(resolveSslConfig({ databaseUrl: HEROKU_URL })).toEqual({ rejectUnauthorized: false });
    expect(resolveSslConfig({ databaseUrl: HEROKU_URL, ssl: 'require' })).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('also relaxes verification for non-Heroku AWS RDS hosts', () => {
    expect(resolveSslConfig({ databaseUrl: RDS_URL, ssl: 'require' })).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('keeps strict verification for non-AWS hosts under the default require mode', () => {
    expect(resolveSslConfig({ databaseUrl: LOCAL_URL })).toEqual({ rejectUnauthorized: true });
    expect(resolveSslConfig({ databaseUrl: LOCAL_URL, ssl: 'require' })).toEqual({
      rejectUnauthorized: true,
    });
  });

  it('honors an explicit no-verify override on any host', () => {
    expect(resolveSslConfig({ databaseUrl: LOCAL_URL, ssl: 'no-verify' })).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('honors an explicit off override (no TLS) even for AWS hosts', () => {
    expect(resolveSslConfig({ databaseUrl: HEROKU_URL, ssl: 'off' })).toBe(false);
  });
});
