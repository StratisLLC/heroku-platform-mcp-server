/**
 * Streamable HTTP MCP transport orchestration.
 *
 * One map of `mcp-session-id → { transport, mcpServer }`. Initialize requests
 * create new sessions; subsequent requests reuse them. Sessions evict on
 * transport close or after 60 minutes of inactivity.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { BuiltServer } from '@heroku-mcp/platform';

export interface SessionEntry {
  /** Stable session id (also stored on the transport). */
  id: string;
  /** The user's primary key. Set at session creation. */
  userId: string;
  /** Connection-token id used to create this session. */
  connectionTokenId: string;
  /** The MCP server + its context. */
  built: BuiltServer;
  /** The transport hosting the session. */
  transport: StreamableHTTPServerTransport;
  /** Wall-clock of last incoming request. */
  lastSeen: number;
  /** Latest reported client name + version, from the most recent initialize. */
  clientName: string | null;
  clientVersion: string | null;
}

const SESSION_TTL_MS = 60 * 60 * 1000;

export class TransportManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private gcTimer: NodeJS.Timeout | undefined;

  /** Look up an existing session by `mcp-session-id` header. */
  get(sessionId: string | undefined | null): SessionEntry | undefined {
    if (!sessionId) return undefined;
    const entry = this.sessions.get(sessionId);
    if (entry) entry.lastSeen = Date.now();
    return entry;
  }

  /** Register a fresh session. */
  register(entry: Omit<SessionEntry, 'id' | 'lastSeen'>, sessionId: string): SessionEntry {
    const full: SessionEntry = {
      ...entry,
      id: sessionId,
      lastSeen: Date.now(),
    };
    this.sessions.set(sessionId, full);
    return full;
  }

  /** Remove a session (called on transport close). */
  remove(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    void entry.built.server.close().catch(() => undefined);
  }

  /** Number of active sessions. */
  size(): number {
    return this.sessions.size;
  }

  /** Revoke every session owned by a user (e.g. on "sign out everywhere"). */
  evictByUser(userId: string): number {
    let n = 0;
    for (const [id, entry] of this.sessions) {
      if (entry.userId === userId) {
        this.sessions.delete(id);
        void entry.built.server.close().catch(() => undefined);
        n += 1;
      }
    }
    return n;
  }

  /** Revoke every session that was authorised by the given connection token. */
  evictByConnectionToken(tokenId: string): number {
    let n = 0;
    for (const [id, entry] of this.sessions) {
      if (entry.connectionTokenId === tokenId) {
        this.sessions.delete(id);
        void entry.built.server.close().catch(() => undefined);
        n += 1;
      }
    }
    return n;
  }

  /** Start a periodic GC loop that evicts idle sessions. The interval is
   *  unref'd so it never blocks process shutdown. */
  startGc(intervalMs = 60_000): void {
    if (this.gcTimer) return;
    this.gcTimer = setInterval(() => this.collectIdle(), intervalMs);
    this.gcTimer.unref();
  }

  /** Cancel the GC loop. */
  stopGc(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = undefined;
    }
  }

  /** Manually evict sessions idle past TTL. */
  collectIdle(now = Date.now()): number {
    let n = 0;
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastSeen > SESSION_TTL_MS) {
        this.sessions.delete(id);
        void entry.built.server.close().catch(() => undefined);
        n += 1;
      }
    }
    return n;
  }
}

export interface DispatchOptions {
  /** Node req/res from `@hono/node-server`. */
  req: IncomingMessage;
  res: ServerResponse;
  /** Pre-parsed body (Hono parses it before invoking the route). */
  body: unknown;
  /** Existing session, if any. */
  session: SessionEntry;
}

/** Hand a raw HTTP request to a session's transport. */
export async function dispatchToTransport(opts: DispatchOptions): Promise<void> {
  await opts.session.transport.handleRequest(opts.req, opts.res, opts.body);
}

export function generateSessionId(): string {
  return randomUUID();
}
