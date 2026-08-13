export interface ClosableMcpTransport {
  close(): Promise<void>;
}

export interface McpSessionCloseResult {
  sessionId: string;
  error?: unknown;
}

interface McpSessionEntry<TTransport> {
  transport: TTransport;
  lastActivityAt: number;
}

export interface McpSessionRegistryOptions {
  now?: () => number;
  maxSessions?: number;
}

export class McpSessionRegistry<TTransport extends ClosableMcpTransport> {
  private readonly sessions = new Map<string, McpSessionEntry<TTransport>>();
  private readonly now: () => number;
  private readonly maxSessions: number;

  constructor(options: McpSessionRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxSessions = options.maxSessions ?? Number.POSITIVE_INFINITY;
    if (
      this.maxSessions !== Number.POSITIVE_INFINITY
      && (!Number.isInteger(this.maxSessions) || this.maxSessions < 1)
    ) {
      throw new Error(`maxSessions must be a positive integer: ${this.maxSessions}`);
    }
  }

  get size(): number {
    return this.sessions.size;
  }

  register(sessionId: string, transport: TTransport): Promise<McpSessionCloseResult[]> {
    const replaced = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      transport,
      lastActivityAt: this.now(),
    });

    const sessionsToClose: Array<{ sessionId: string; transport: TTransport }> = [];
    if (replaced && replaced.transport !== transport) {
      sessionsToClose.push({ sessionId, transport: replaced.transport });
    }

    while (this.sessions.size > this.maxSessions) {
      const oldest = this.oldestSessionExcept(sessionId);
      if (!oldest) break;

      this.sessions.delete(oldest.sessionId);
      sessionsToClose.push(oldest);
    }

    return closeSessions(sessionsToClose);
  }

  get(sessionId: string): TTransport | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;

    entry.lastActivityAt = this.now();
    return entry.transport;
  }

  prepareForRegistration(): Promise<McpSessionCloseResult[]> {
    const sessionsToClose: Array<{ sessionId: string; transport: TTransport }> = [];

    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.oldestSessionExcept();
      if (!oldest) break;

      this.sessions.delete(oldest.sessionId);
      sessionsToClose.push(oldest);
    }

    return closeSessions(sessionsToClose);
  }

  remove(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  async closeIdle(idleTimeoutMs: number): Promise<McpSessionCloseResult[]> {
    const cutoff = this.now() - idleTimeoutMs;
    const idleSessions: Array<{ sessionId: string; transport: TTransport }> = [];

    for (const [sessionId, entry] of this.sessions) {
      if (entry.lastActivityAt > cutoff) continue;

      this.sessions.delete(sessionId);
      idleSessions.push({ sessionId, transport: entry.transport });
    }

    return closeSessions(idleSessions);
  }

  async closeAll(): Promise<McpSessionCloseResult[]> {
    const sessions = Array.from(this.sessions, ([sessionId, entry]) => ({
      sessionId,
      transport: entry.transport,
    }));
    this.sessions.clear();
    return closeSessions(sessions);
  }

  private oldestSessionExcept(excludedSessionId?: string): { sessionId: string; transport: TTransport } | undefined {
    let oldest: { sessionId: string; entry: McpSessionEntry<TTransport> } | undefined;

    for (const [sessionId, entry] of this.sessions) {
      if (excludedSessionId !== undefined && sessionId === excludedSessionId) continue;
      if (!oldest || entry.lastActivityAt < oldest.entry.lastActivityAt) {
        oldest = { sessionId, entry };
      }
    }

    return oldest
      ? { sessionId: oldest.sessionId, transport: oldest.entry.transport }
      : undefined;
  }
}

async function closeSessions<TTransport extends ClosableMcpTransport>(
  sessions: Array<{ sessionId: string; transport: TTransport }>,
): Promise<McpSessionCloseResult[]> {
  return Promise.all(
    sessions.map(async ({ sessionId, transport }) => {
      try {
        await transport.close();
        return { sessionId };
      } catch (error) {
        return { sessionId, error };
      }
    }),
  );
}
