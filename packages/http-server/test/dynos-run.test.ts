import { describe, expect, it } from 'vitest';
import { readBufferedOutput, type WebSocketLike } from '../src/mcp/dynos-run.js';

interface FakeOpts {
  messages: (string | Buffer)[];
  /** Delay between dispatching each message (ms). */
  intervalMs?: number;
  /** Whether to emit 'close' after messages run out. */
  closeAfter?: boolean;
}

/** Build a fake WebSocket that emits a scripted sequence of messages, then
 *  (optionally) closes. */
function fakeWs(opts: FakeOpts): WebSocketLike {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const ws: WebSocketLike = {
    on(event, handler) {
      const arr = handlers.get(event) ?? [];
      arr.push(handler);
      handlers.set(event, arr);
    },
    close() {
      // best-effort
    },
  };
  // dispatch on next tick so the readBufferedOutput callsite sees its
  // handlers installed before our messages arrive.
  setImmediate(() => {
    void (async () => {
      for (const m of opts.messages) {
        for (const h of handlers.get('message') ?? []) h(m);
        if (opts.intervalMs) await new Promise((r) => setTimeout(r, opts.intervalMs));
      }
      if (opts.closeAfter !== false) {
        for (const h of handlers.get('close') ?? []) h();
      }
    })();
  });
  return ws;
}

const now = () => Date.now();

describe('readBufferedOutput', () => {
  it('concatenates messages and reports the close path', async () => {
    const out = await readBufferedOutput({
      attachUrl: 'wss://x',
      wsFactory: () => fakeWs({ messages: ['hello ', 'world'] }),
      maxDurationMs: 1000,
      maxOutputBytes: 1024,
      now,
    });
    expect(out.output).toBe('hello world');
    expect(out.truncated).toBe(false);
    expect(out.timedOut).toBe(false);
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('truncates when output exceeds max_output_bytes', async () => {
    const out = await readBufferedOutput({
      attachUrl: 'wss://x',
      wsFactory: () => fakeWs({ messages: ['a'.repeat(100), 'b'.repeat(100)] }),
      maxDurationMs: 1000,
      maxOutputBytes: 150,
      now,
    });
    expect(out.output.length).toBe(150);
    expect(out.truncated).toBe(true);
    expect(out.timedOut).toBe(false);
  });

  it('times out when no close arrives before maxDurationMs', async () => {
    const out = await readBufferedOutput({
      attachUrl: 'wss://x',
      wsFactory: () => fakeWs({ messages: ['slow-stream'], intervalMs: 10, closeAfter: false }),
      maxDurationMs: 30,
      maxOutputBytes: 1024,
      now,
    });
    expect(out.timedOut).toBe(true);
  });

  it('decodes Buffer payloads as utf8', async () => {
    const out = await readBufferedOutput({
      attachUrl: 'wss://x',
      wsFactory: () => fakeWs({ messages: [Buffer.from('héllo', 'utf8')] }),
      maxDurationMs: 1000,
      maxOutputBytes: 1024,
      now,
    });
    expect(out.output).toBe('héllo');
  });

  it('treats ws errors as a clean termination (so the tool still returns)', async () => {
    const out = await readBufferedOutput({
      attachUrl: 'wss://x',
      wsFactory: () => {
        const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
        const ws: WebSocketLike = {
          on(event, handler) {
            const arr = handlers.get(event) ?? [];
            arr.push(handler);
            handlers.set(event, arr);
          },
          close() {
            // no-op
          },
        };
        setImmediate(() => {
          for (const h of handlers.get('error') ?? []) h(new Error('boom'));
        });
        return ws;
      },
      maxDurationMs: 1000,
      maxOutputBytes: 1024,
      now,
    });
    expect(out.output).toBe('');
    expect(out.timedOut).toBe(false);
  });
});
