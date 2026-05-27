import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.js';

function baseEnv(): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://localhost/test',
    HEROKUMCP_MASTER_KEY: randomBytes(32).toString('base64'),
    HEROKUMCP_OAUTH_CLIENT_ID: 'cid',
    HEROKUMCP_OAUTH_CLIENT_SECRET: 'csec',
    HEROKUMCP_ADMIN_CONTACT: 'admin@example.com',
  };
}

describe('loadConfig', () => {
  it('parses a minimal valid env', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.port).toBe(3000);
    expect(cfg.oauth.scope).toBe('write-protected');
    expect(cfg.adminContact).toBe('admin@example.com');
    expect(cfg.allowedEmails).toBeNull();
    expect(cfg.allowedTeams).toBeNull();
    expect(cfg.adminEmails).toEqual([]);
    expect(cfg.auditRetentionDays).toBeNull();
    expect(cfg.masterKey.length).toBe(32);
  });

  it('parses MCP_ALLOWED_EMAILS as a case-normalised list', () => {
    const cfg = loadConfig({
      ...baseEnv(),
      MCP_ALLOWED_EMAILS: 'Alice@EXAMPLE.com, bob@example.com',
    });
    expect(cfg.allowedEmails).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('parses MCP_ALLOWED_TEAMS as a trimmed list', () => {
    const cfg = loadConfig({
      ...baseEnv(),
      MCP_ALLOWED_TEAMS: ' eng , platform ,',
    });
    expect(cfg.allowedTeams).toEqual(['eng', 'platform']);
  });

  it('masks secrets in the admin snapshot', () => {
    const cfg = loadConfig({ ...baseEnv(), HEROKUMCP_OAUTH_SCOPE: 'read' });
    expect(cfg.rawEnvForAdmin.HEROKUMCP_OAUTH_CLIENT_SECRET).toBe('***');
    expect(cfg.rawEnvForAdmin.HEROKUMCP_MASTER_KEY).toBe('***');
    expect(cfg.rawEnvForAdmin.DATABASE_URL).toBe('***');
    expect(cfg.rawEnvForAdmin.HEROKUMCP_OAUTH_SCOPE).toBe('read');
  });

  it('refuses to start without HEROKUMCP_ADMIN_CONTACT', () => {
    const env = baseEnv();
    delete env.HEROKUMCP_ADMIN_CONTACT;
    expect(() => loadConfig(env)).toThrow(/HEROKUMCP_ADMIN_CONTACT/);
  });

  it('refuses to start without HEROKUMCP_MASTER_KEY', () => {
    const env = baseEnv();
    delete env.HEROKUMCP_MASTER_KEY;
    expect(() => loadConfig(env)).toThrow(/HEROKUMCP_MASTER_KEY/);
  });

  it('refuses to start without OAuth client credentials', () => {
    const env = baseEnv();
    delete env.HEROKUMCP_OAUTH_CLIENT_ID;
    expect(() => loadConfig(env)).toThrow(/HEROKUMCP_OAUTH_CLIENT_ID/);
  });

  it('refuses to start with a bad master key', () => {
    expect(() => loadConfig({ ...baseEnv(), HEROKUMCP_MASTER_KEY: 'not32bytes' })).toThrow(
      /HEROKUMCP_MASTER_KEY/,
    );
  });

  it('isProduction reflects NODE_ENV', () => {
    expect(loadConfig({ ...baseEnv(), NODE_ENV: 'production' }).isProduction).toBe(true);
    expect(loadConfig({ ...baseEnv(), NODE_ENV: 'development' }).isProduction).toBe(false);
  });
});
