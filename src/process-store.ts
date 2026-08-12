import { and, desc, eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { processSessions, type ProcessSessionRow } from "./db/schema.js";

const PROCESS_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_COMPLETED_PROCESSES_PER_WORKSPACE = 50;

export type ProcessSessionStatus = "running" | "completed" | "failed" | "interrupted";

export interface StoredProcessSession {
  id: number;
  workspaceId: string;
  command: string;
  workingDirectory: string;
  tty: boolean;
  status: ProcessSessionStatus;
  output: string;
  outputTruncated: boolean;
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  interrupted: boolean;
  startedAt: number;
  completedAt?: number;
  updatedAt: number;
}

export interface ProcessSessionStore {
  create(input: {
    workspaceId: string;
    command: string;
    workingDirectory: string;
    tty: boolean;
    startedAt: number;
  }): number;
  finish(record: StoredProcessSession): void;
  interrupt(record: StoredProcessSession): void;
  get(workspaceId: string, sessionId: number): StoredProcessSession | undefined;
  list(workspaceId: string, limit: number): StoredProcessSession[];
  close(): void;
}

export class SqliteProcessSessionStore implements ProcessSessionStore {
  private readonly database: DatabaseHandle;
  private closed = false;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
    const now = Date.now();
    this.database.sqlite.prepare(`
      update process_sessions
      set status = 'interrupted', interrupted = 1, completed_at = ?, updated_at = ?
      where status = 'running'
    `).run(now, now);
    this.database.sqlite.prepare(`
      delete from process_sessions
      where status != 'running' and updated_at < ?
    `).run(now - PROCESS_RETENTION_MS);
  }

  create(input: {
    workspaceId: string;
    command: string;
    workingDirectory: string;
    tty: boolean;
    startedAt: number;
  }): number {
    this.assertOpen();
    const row = this.database.db
      .insert(processSessions)
      .values({
        workspaceId: input.workspaceId,
        command: input.command,
        workingDirectory: input.workingDirectory,
        tty: input.tty,
        status: "running",
        output: "",
        outputTruncated: false,
        timedOut: false,
        interrupted: false,
        startedAt: input.startedAt,
        updatedAt: input.startedAt,
      })
      .returning({ id: processSessions.id })
      .get();

    if (!row) throw new Error("Process session insert returned no row.");
    return row.id;
  }

  finish(record: StoredProcessSession): void {
    this.update(record);
    this.pruneWorkspace(record.workspaceId);
  }

  interrupt(record: StoredProcessSession): void {
    this.update(record);
    this.pruneWorkspace(record.workspaceId);
  }

  get(workspaceId: string, sessionId: number): StoredProcessSession | undefined {
    this.assertOpen();
    const row = this.database.db
      .select()
      .from(processSessions)
      .where(and(eq(processSessions.id, sessionId), eq(processSessions.workspaceId, workspaceId)))
      .get();
    return row ? rowToStoredProcessSession(row) : undefined;
  }

  list(workspaceId: string, limit: number): StoredProcessSession[] {
    this.assertOpen();
    return this.database.db
      .select()
      .from(processSessions)
      .where(eq(processSessions.workspaceId, workspaceId))
      .orderBy(desc(processSessions.updatedAt))
      .limit(limit)
      .all()
      .map(rowToStoredProcessSession);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private update(record: StoredProcessSession): void {
    this.assertOpen();
    this.database.db
      .update(processSessions)
      .set({
        status: record.status,
        output: record.output,
        outputTruncated: record.outputTruncated,
        exitCode: record.exitCode ?? null,
        signal: record.signal ?? null,
        timedOut: record.timedOut,
        interrupted: record.interrupted,
        completedAt: record.completedAt ?? null,
        updatedAt: record.updatedAt,
      })
      .where(eq(processSessions.id, record.id))
      .run();
  }

  private pruneWorkspace(workspaceId: string): void {
    this.database.sqlite.prepare(`
      delete from process_sessions
      where workspace_id = ?
        and status != 'running'
        and id not in (
          select id from process_sessions
          where workspace_id = ? and status != 'running'
          order by updated_at desc
          limit ?
        )
    `).run(
      workspaceId,
      workspaceId,
      MAX_COMPLETED_PROCESSES_PER_WORKSPACE,
    );
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Process session store is closed.");
  }
}

function rowToStoredProcessSession(row: ProcessSessionRow): StoredProcessSession {
  const status = isProcessSessionStatus(row.status) ? row.status : "failed";
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    command: row.command,
    workingDirectory: row.workingDirectory,
    tty: row.tty,
    status,
    output: row.output,
    outputTruncated: row.outputTruncated,
    exitCode: row.exitCode ?? undefined,
    signal: row.signal ?? undefined,
    timedOut: row.timedOut,
    interrupted: row.interrupted,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
    updatedAt: row.updatedAt,
  };
}

function isProcessSessionStatus(value: string): value is ProcessSessionStatus {
  return value === "running" || value === "completed" || value === "failed" || value === "interrupted";
}
