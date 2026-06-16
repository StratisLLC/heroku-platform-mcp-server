import { describe, expect, it } from 'vitest';
import { rowsToCsv } from '../src/routes/audit.js';

describe('rowsToCsv', () => {
  it('emits a header line and escapes commas/quotes/newlines', () => {
    const csv = rowsToCsv([
      {
        id: '1',
        occurredAt: new Date('2026-05-22T00:00:00Z'),
        userId: 'u',
        category: 'tool_call',
        eventName: 'apps,delete',
        status: 'ok',
        requestId: 'r"q"',
        durationMs: 12,
        clientName: 'claude-desktop',
        clientVersion: '0.1.0',
        details: { args: { app: 'name\nwith newline' } },
      },
    ]);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe(
      'id,occurred_at,user_id,category,event,status,duration_ms,client_name,client_version,request_id,details',
    );
    // Comma inside event must be quoted
    expect(lines[1]).toContain('"apps,delete"');
    // Doubled quotes inside the request_id field
    expect(lines[1]).toContain('"r""q"""');
    // Newline inside details must be quoted-wrapped
    expect(lines[1]).toContain('\\n');
  });

  it('handles empty rows', () => {
    expect(rowsToCsv([])).toBe(
      'id,occurred_at,user_id,category,event,status,duration_ms,client_name,client_version,request_id,details\n',
    );
  });

  it('renders null fields as empty', () => {
    const csv = rowsToCsv([
      {
        id: '1',
        occurredAt: new Date('2026-05-22T00:00:00Z'),
        userId: null,
        category: 'system',
        eventName: 'mcp_session_start',
        status: 'ok',
        requestId: null,
        durationMs: null,
        clientName: null,
        clientVersion: null,
        details: null,
      },
    ]);
    const lines = csv.trim().split('\n');
    expect(lines[1]).toBe('1,2026-05-22T00:00:00.000Z,,system,mcp_session_start,ok,,,,,');
  });
});
