import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/index.js';

function describeProgram(): { names: string[]; help: string } {
  const p = buildProgram();
  const names = p.commands.map((c) => c.name());
  const help = p.helpInformation();
  return { names, help };
}

describe('herokumcp-admin CLI surface', () => {
  it('registers every Phase 4 top-level command', () => {
    const { names } = describeProgram();
    expect(names.sort()).toEqual(['audit', 'db', 'keys', 'status', 'tokens', 'users'].sort());
  });

  it('users command lists its subcommands', () => {
    const p = buildProgram();
    const users = p.commands.find((c) => c.name() === 'users');
    const sub = users?.commands.map((c) => c.name()).sort() ?? [];
    expect(sub).toEqual(['list', 'revoke-all-tokens']);
  });

  it('tokens command lists its subcommands', () => {
    const p = buildProgram();
    const tokens = p.commands.find((c) => c.name() === 'tokens');
    const sub = tokens?.commands.map((c) => c.name()).sort() ?? [];
    expect(sub).toEqual(['list', 'revoke']);
  });

  it('audit command lists its subcommands', () => {
    const p = buildProgram();
    const audit = p.commands.find((c) => c.name() === 'audit');
    const sub = audit?.commands.map((c) => c.name()).sort() ?? [];
    expect(sub).toEqual(['prune', 'tail']);
  });

  it('db command lists its subcommands', () => {
    const p = buildProgram();
    const db = p.commands.find((c) => c.name() === 'db');
    const sub = db?.commands.map((c) => c.name()).sort() ?? [];
    expect(sub).toEqual(['migrate', 'status']);
  });

  it('keys command lists its subcommands', () => {
    const p = buildProgram();
    const keys = p.commands.find((c) => c.name() === 'keys');
    const sub = keys?.commands.map((c) => c.name()).sort() ?? [];
    expect(sub).toEqual(['fingerprint', 'gen', 'rotate-master']);
  });

  it('top-level help mentions the operator context', () => {
    const { help } = describeProgram();
    expect(help).toMatch(/hosted Heroku MCP server/i);
    expect(help).toContain('Postgres');
  });
});

describe('keys gen', () => {
  it('prints a base64-encoded 32-byte key (no extra output)', async () => {
    const p = buildProgram();
    const written: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      written.push(s);
      return true;
    };
    try {
      await p.parseAsync(['node', 'herokumcp-admin', 'keys', 'gen']);
    } finally {
      (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
    }
    const out = written.join('').trim();
    const raw = Buffer.from(out, 'base64');
    expect(raw.length).toBe(32);
  });
});

describe('keys fingerprint', () => {
  it('exits with 2 when no key is provided', async () => {
    const p = buildProgram();
    const origExit = process.exit.bind(process);
    let exitCode: number | undefined;
    (process as unknown as { exit: (n?: number) => void }).exit = ((n?: number) => {
      exitCode = n;
      throw new Error('process.exit');
    }) as never;
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
    delete process.env.HEROKUMCP_MASTER_KEY;
    try {
      await p.parseAsync(['node', 'herokumcp-admin', 'keys', 'fingerprint']).catch(() => undefined);
    } finally {
      (process as unknown as { exit: typeof origExit }).exit = origExit;
      (process.stderr as unknown as { write: typeof origErr }).write = origErr;
    }
    expect(exitCode).toBe(2);
  });
});
