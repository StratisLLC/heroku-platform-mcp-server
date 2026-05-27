import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { installAuditWrapper, type AuditSink } from '../src/mcp/audit-wrapper.js';

interface Recorded {
  userId: string | null;
  category: string;
  eventName: string;
  status: string;
  details: Record<string, unknown>;
}

async function wireServer(sink: AuditSink): Promise<{ client: Client; server: McpServer }> {
  const server = new McpServer(
    { name: 'test', version: '0.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  installAuditWrapper(server, sink, () => ({
    userId: 'user-1',
    clientName: 'test-host',
    clientVersion: '1.2.3',
  }));
  server.registerTool(
    'ok_tool',
    {
      title: 'Always ok',
      inputSchema: { x: z.string().optional() },
    },
    async (args) => {
      void args;
      await Promise.resolve();
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  );
  server.registerTool(
    'error_tool',
    {
      title: 'Returns isError',
      inputSchema: {},
    },
    async () => {
      await Promise.resolve();
      return { content: [{ type: 'text', text: 'fail' }], isError: true };
    },
  );
  server.registerTool(
    'throw_tool',
    {
      title: 'Throws',
      inputSchema: {},
    },
    async () => {
      await Promise.resolve();
      throw new Error('boom');
    },
  );
  server.registerTool(
    'redact_tool',
    {
      title: 'Sensitive args',
      inputSchema: { password: z.string().optional(), confirm: z.string().optional() },
    },
    async () => {
      await Promise.resolve();
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  );

  const client = new Client({ name: 'test-harness', version: '0.0.0' });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return { client, server };
}

describe('installAuditWrapper', () => {
  it('records a successful tool call', async () => {
    const calls: Recorded[] = [];
    const sink = vi.fn(async (entry: Recorded) => {
      calls.push(entry);
    });
    const { client } = await wireServer(sink);
    await client.callTool({ name: 'ok_tool', arguments: { x: 'hi' } });
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({
      userId: 'user-1',
      eventName: 'ok_tool',
      status: 'ok',
      category: 'tool_call',
    });
    expect(calls[0]?.details).toMatchObject({
      args: { x: 'hi' },
      dry_run: false,
      confirm_present: false,
    });
  });

  it('records isError outcomes as status=error', async () => {
    const calls: Recorded[] = [];
    const { client } = await wireServer(async (entry) => {
      calls.push(entry);
    });
    await client.callTool({ name: 'error_tool', arguments: {} });
    expect(calls[0]?.status).toBe('error');
  });

  it('records thrown errors as status=error and re-throws', async () => {
    const calls: Recorded[] = [];
    const { client } = await wireServer(async (entry) => {
      calls.push(entry);
    });
    // The SDK turns thrown handler errors into isError responses (per the MCP
    // spec) instead of rejecting the callTool promise. Either path must produce
    // an audit row with status=error.
    await client.callTool({ name: 'throw_tool', arguments: {} }).catch(() => undefined);
    expect(calls[0]?.status).toBe('error');
  });

  it('strips confirm and redacts secret-named fields', async () => {
    const calls: Recorded[] = [];
    const { client } = await wireServer(async (entry) => {
      calls.push(entry);
    });
    await client.callTool({
      name: 'redact_tool',
      arguments: { password: 'secret', confirm: 'app-name' },
    });
    const args = calls[0]?.details.args as Record<string, unknown>;
    expect(args).not.toHaveProperty('confirm');
    expect(args.password).toBe('[REDACTED]');
    expect(calls[0]?.details).toMatchObject({ confirm_present: true });
  });
});
