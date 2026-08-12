import { spawn } from "node:child_process";
import {
  resolveShellCommand,
  terminateProcessTree,
  type ShellCommand,
} from "./process-platform.js";
import {
  type ProcessSessionStatus,
  type ProcessSessionStore,
  type StoredProcessSession,
} from "./process-store.js";

const DEFAULT_EXEC_YIELD_MS = 2_000;
const DEFAULT_INTERACTIVE_YIELD_MS = 250;
const DEFAULT_POLL_YIELD_MS = 2_000;
const MAX_COMMAND_YIELD_MS = 30_000;
const MAX_POLL_YIELD_MS = 110_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const DEFAULT_BUFFER_CHARACTERS = 1_000_000;
const COMPLETED_SESSION_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

export interface StartCommandInput {
  workspaceId: string;
  command: string;
  cwd: string;
  workspaceRoot?: string;
  tty?: boolean;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
  maxRuntimeMs?: number;
  cleanupDescendantsOnExit?: boolean;
  shellCommand?: ShellCommand;
}

export interface WriteStdinInput {
  workspaceId: string;
  sessionId: number;
  chars?: string;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

export interface ProcessSnapshot {
  sessionId: number;
  command: string;
  workingDirectory: string;
  tty: boolean;
  status: ProcessSessionStatus;
  output: string;
  outputTruncated: boolean;
  running: boolean;
  exitCode?: number;
  signal?: string;
  timedOut?: boolean;
  interrupted?: boolean;
  startedAt: string;
  completedAt?: string;
  wallTimeMs: number;
}

export interface ProcessSummary extends Omit<ProcessSnapshot, "output"> {
  outputPreview: string;
}

interface ManagedProcess {
  write(data: string): void;
  kill(signal?: NodeJS.Signals): void;
  resize?(columns: number, rows: number): void;
}

interface ProcessSession {
  id: number;
  workspaceId: string;
  command: string;
  workingDirectory: string;
  tty: boolean;
  process?: ManagedProcess;
  startedAt: number;
  completedAt?: number;
  columns: number;
  rows: number;
  buffer: HeadTailBuffer;
  transcript: HeadTailBuffer;
  running: boolean;
  status: ProcessSessionStatus;
  exitCode?: number;
  signal?: string;
  timedOut?: boolean;
  interrupted?: boolean;
  storeFinalized?: boolean;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  cleanupTimer?: NodeJS.Timeout;
  runtimeTimer?: NodeJS.Timeout;
  forceKillTimer?: NodeJS.Timeout;
}

interface ProcessSessionManagerOptions {
  maxBufferCharacters?: number;
  completedSessionTtlMs?: number;
  store?: ProcessSessionStore;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Duration and output limits must be non-negative.");
  }
  return Math.min(Math.floor(value), maximum);
}

function optionalPositiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function terminalSize(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Terminal dimensions must be integers between 1 and 1000.");
  }
  return value;
}

function processEnvironment(input?: {
  workspaceId?: string;
  workspaceRoot?: string;
}): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    NO_COLOR: "1",
    TERM: "dumb",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GH_PAGER: "cat",
    CODEX_CI: "1",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    ...(input?.workspaceId ? { DEVSPACE_WORKSPACE_ID: input.workspaceId } : {}),
    ...(input?.workspaceRoot ? { DEVSPACE_WORKSPACE_ROOT: input.workspaceRoot } : {}),
  };
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function sliceCodePoints(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join("");
}

function takeHead(value: string, count: number): string {
  if (count <= 0) return "";
  return sliceCodePoints(value, 0, count);
}

function takeTail(value: string, count: number): string {
  if (count <= 0) return "";
  const characters = Array.from(value);
  return characters.slice(Math.max(0, characters.length - count)).join("");
}

function splitBudget(maxCharacters: number): { head: number; tail: number } {
  return {
    head: Math.ceil(maxCharacters / 2),
    tail: Math.floor(maxCharacters / 2),
  };
}

function formatHeadTail(head: string, tail: string, omittedCharacters: number): string {
  if (omittedCharacters <= 0) return head + tail;
  return `${head}\n... output truncated (${omittedCharacters} characters omitted) ...\n${tail}`;
}

export class HeadTailBuffer {
  private head = "";
  private tail = "";
  private totalCharacters = 0;

  constructor(private readonly maxCharacters: number) {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Head/tail buffer limit must be a positive integer.");
    }
  }

  append(output: string): void {
    if (!output) return;

    const previousTotal = this.totalCharacters;
    this.totalCharacters += codePointLength(output);

    if (this.totalCharacters <= this.maxCharacters) {
      this.head += output;
      return;
    }

    const budget = splitBudget(this.maxCharacters);
    if (previousTotal <= this.maxCharacters) {
      const fullOutput = this.head + output;
      this.head = takeHead(fullOutput, budget.head);
      this.tail = takeTail(fullOutput, budget.tail);
      return;
    }

    this.tail = takeTail(this.tail + output, budget.tail);
  }

  hasOutput(): boolean {
    return this.totalCharacters > 0;
  }

  snapshot(maxCharacters: number): { output: string; truncated: boolean } {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Output limit must be a positive integer.");
    }

    const omittedByBuffer = Math.max(
      0,
      this.totalCharacters - codePointLength(this.head) - codePointLength(this.tail),
    );
    const retained = formatHeadTail(this.head, this.tail, omittedByBuffer);
    const output = truncateOutput(retained, maxCharacters);
    const truncated = omittedByBuffer > 0 || output.truncated;

    return { output: output.output, truncated };
  }

  drain(maxCharacters: number): { output: string; truncated: boolean } {
    const snapshot = this.snapshot(maxCharacters);

    this.head = "";
    this.tail = "";
    this.totalCharacters = 0;

    return snapshot;
  }
}

function truncateOutput(output: string, maxCharacters: number): { output: string; truncated: boolean } {
  const outputCharacters = codePointLength(output);
  if (outputCharacters <= maxCharacters) return { output, truncated: false };

  const marker = "\n... output truncated ...\n";
  const markerCharacters = codePointLength(marker);
  const available = Math.max(0, maxCharacters - markerCharacters);
  const budget = splitBudget(available);
  return {
    output: takeHead(output, budget.head) + marker + takeTail(output, budget.tail),
    truncated: true,
  };
}

export class ProcessSessionManager {
  private readonly sessions = new Map<number, ProcessSession>();
  private readonly maxBufferCharacters: number;
  private readonly completedSessionTtlMs: number;
  private readonly store?: ProcessSessionStore;
  private nextSessionId = 1;
  private closed = false;

  constructor(options: ProcessSessionManagerOptions = {}) {
    this.maxBufferCharacters = options.maxBufferCharacters ?? DEFAULT_BUFFER_CHARACTERS;
    this.completedSessionTtlMs = options.completedSessionTtlMs ?? COMPLETED_SESSION_TTL_MS;
    this.store = options.store;
  }

  async start(input: StartCommandInput): Promise<ProcessSnapshot> {
    if (this.closed) throw new Error("Process session manager is closed.");
    const maxRuntimeMs = optionalPositiveInteger(input.maxRuntimeMs, "Maximum runtime");
    const session = this.createSession(input);
    this.sessions.set(session.id, session);

    try {
      if (input.tty && process.platform !== "win32") await this.startPty(session, input);
      else this.startPipe(session, input);
      if (maxRuntimeMs !== undefined) this.armRuntimeLimit(session, maxRuntimeMs);
    } catch (error) {
      this.append(session, `${error instanceof Error ? error.message : String(error)}\n`);
      this.finish(session, undefined, undefined, "failed");
      throw error;
    }

    const yieldTimeMs = boundedInteger(input.yieldTimeMs, DEFAULT_EXEC_YIELD_MS, MAX_COMMAND_YIELD_MS);
    await this.waitForExit(session, yieldTimeMs);

    const snapshot = this.consume(session, input.maxOutputTokens);
    return snapshot;
  }

  async write(input: WriteStdinInput): Promise<ProcessSnapshot> {
    const session = this.getOwnedSession(input.workspaceId, input.sessionId);
    const chars = input.chars ?? "";
    const interactionRequested =
      chars.length > 0 || input.columns !== undefined || input.rows !== undefined;

    if (input.columns !== undefined || input.rows !== undefined) {
      session.columns = terminalSize(input.columns, session.columns);
      session.rows = terminalSize(input.rows, session.rows);
      if (!session.process?.resize) {
        throw new Error(`Process session ${session.id} is not a PTY and cannot be resized.`);
      }
      session.process.resize(session.columns, session.rows);
    }

    const interruptRequested = chars.includes("\u0003") && session.running;
    if (interruptRequested) {
      session.process?.kill("SIGINT");
    }
    const writableChars = chars.replaceAll("\u0003", "");
    if (writableChars && session.running) session.process?.write(writableChars);

    if ((interactionRequested || !session.buffer.hasOutput()) && session.running) {
      const fallback = interactionRequested ? DEFAULT_INTERACTIVE_YIELD_MS : DEFAULT_POLL_YIELD_MS;
      const maximum = interactionRequested ? MAX_COMMAND_YIELD_MS : MAX_POLL_YIELD_MS;
      const yieldTimeMs = boundedInteger(input.yieldTimeMs, fallback, maximum);
      await this.waitForExit(session, yieldTimeMs);
    }

    const snapshot = this.consume(session, input.maxOutputTokens);
    return snapshot;
  }

  inspect(workspaceId: string, sessionId: number, maxOutputTokens?: number): ProcessSnapshot {
    const live = this.sessions.get(sessionId);
    if (live) {
      if (live.workspaceId !== workspaceId) {
        throw new Error(`Process session ${sessionId} does not belong to workspace ${workspaceId}.`);
      }
      return this.snapshot(live, maxOutputTokens);
    }

    const stored = this.store?.get(workspaceId, sessionId);
    if (!stored) throw new Error(`Unknown process session: ${sessionId}`);
    return storedProcessSnapshot(stored, maxOutputTokens);
  }

  list(workspaceId: string, limit = 10): ProcessSummary[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new Error("Process list limit must be an integer between 1 and 50.");
    }

    const byId = new Map<number, ProcessSnapshot>();
    for (const stored of this.store?.list(workspaceId, limit) ?? []) {
      byId.set(stored.id, storedProcessSnapshot(stored, 250));
    }
    for (const session of this.sessions.values()) {
      if (session.workspaceId === workspaceId) byId.set(session.id, this.snapshot(session, 250));
    }

    return Array.from(byId.values())
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
      .slice(0, limit)
      .map(({ output, ...snapshot }) => ({ ...snapshot, outputPreview: output }));
  }

  terminate(workspaceId: string, sessionId: number): void {
    const session = this.getOwnedSession(workspaceId, sessionId);
    if (session.running) session.process?.kill("SIGTERM");
  }

  hasRunningSessions(workspaceId: string): boolean {
    return Array.from(this.sessions.values()).some(
      (session) => session.workspaceId === workspaceId && session.running,
    );
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const session of this.sessions.values()) {
      if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
      if (session.runtimeTimer) clearTimeout(session.runtimeTimer);
      if (session.forceKillTimer) clearTimeout(session.forceKillTimer);
      if (session.running) {
        session.interrupted = true;
        this.append(session, "Process interrupted because DevSpace stopped before completion.\n");
        session.process?.kill("SIGTERM");
        this.finish(session, undefined, undefined, "interrupted");
      }
    }
    this.sessions.clear();
    this.store?.close();
  }

  private async waitForExit(session: ProcessSession, yieldTimeMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        session.exitPromise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, yieldTimeMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private createSession(input: StartCommandInput): ProcessSession {
    let resolveExit = (): void => undefined;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const startedAt = Date.now();
    const tty = input.tty === true;
    const id = this.store?.create({
      workspaceId: input.workspaceId,
      command: input.command,
      workingDirectory: input.cwd,
      tty,
      startedAt,
    }) ?? this.nextSessionId++;

    return {
      id,
      workspaceId: input.workspaceId,
      command: input.command,
      workingDirectory: input.cwd,
      tty,
      startedAt,
      columns: terminalSize(input.columns, DEFAULT_COLUMNS),
      rows: terminalSize(input.rows, DEFAULT_ROWS),
      buffer: new HeadTailBuffer(this.maxBufferCharacters),
      transcript: new HeadTailBuffer(this.maxBufferCharacters),
      running: true,
      status: "running",
      exitPromise,
      resolveExit,
    };
  }

  private startPipe(session: ProcessSession, input: StartCommandInput): void {
    const shell = input.shellCommand ?? resolveShellCommand(input.command);
    const detached = process.platform !== "win32";
    const spawnOptions = {
      cwd: input.cwd,
      env: processEnvironment({
        workspaceId: input.workspaceId,
        workspaceRoot: input.workspaceRoot,
      }),
      stdio: "pipe",
      windowsHide: true,
      detached,
    } as const;
    const child = input.shellCommand
      ? spawn(shell.executable, shell.args, spawnOptions)
      : spawn(input.command, { ...spawnOptions, shell: shell.executable });

    session.process = {
      write: (data) => child.stdin.write(data),
      kill: (signal = "SIGTERM") => terminateProcessTree(child, signal, detached),
      resize: input.tty ? () => undefined : undefined,
    };
    child.stdout.on("data", (data: Buffer) => this.append(session, data.toString("utf8")));
    child.stderr.on("data", (data: Buffer) => this.append(session, data.toString("utf8")));
    child.on("error", (error) => this.append(session, `${error.message}\n`));
    if (input.cleanupDescendantsOnExit && process.platform !== "win32") {
      child.on("exit", () => {
        session.process?.kill("SIGTERM");
        this.armForceKill(session);
      });
    }
    child.on("close", (code, signal) => {
      if ((input.cleanupDescendantsOnExit && process.platform !== "win32") || session.timedOut) {
        session.process?.kill("SIGKILL");
      }
      this.finish(session, code ?? undefined, signal ?? undefined);
    });
  }

  private async startPty(session: ProcessSession, input: StartCommandInput): Promise<void> {
    let nodePty: typeof import("node-pty");
    try {
      nodePty = await import("node-pty");
    } catch {
      throw new Error("PTY support requires the optional node-pty dependency.");
    }

    const shell = resolveShellCommand(input.command);
    let pty: import("node-pty").IPty;
    try {
      pty = nodePty.spawn(shell.executable, shell.args, {
        cwd: input.cwd,
        env: processEnvironment({
          workspaceId: input.workspaceId,
          workspaceRoot: input.workspaceRoot,
        }),
        name: "xterm-256color",
        cols: session.columns,
        rows: session.rows,
      });
    } catch (error) {
      throw error;
    }

    session.process = {
      write: (data) => pty.write(data),
      kill: (signal) => pty.kill(signal),
      resize: (columns, rows) => pty.resize(columns, rows),
    };
    pty.onData((data) => this.append(session, data));
    pty.onExit(({ exitCode, signal }) => {
      this.finish(session, exitCode, signal === 0 ? undefined : String(signal));
    });
  }

  private finish(
    session: ProcessSession,
    exitCode?: number,
    signal?: string,
    forcedStatus?: ProcessSessionStatus,
  ): void {
    if (!session.running) return;
    if (session.runtimeTimer) clearTimeout(session.runtimeTimer);
    if (session.forceKillTimer) clearTimeout(session.forceKillTimer);
    session.running = false;
    session.exitCode = exitCode;
    session.signal = signal;
    session.completedAt = Date.now();
    session.status = forcedStatus ?? (
      session.timedOut || signal !== undefined || (exitCode !== undefined && exitCode !== 0)
        ? "failed"
        : "completed"
    );
    session.resolveExit();
    this.persistFinal(session);
    session.cleanupTimer = setTimeout(
      () => this.removeSession(session.id),
      this.completedSessionTtlMs,
    );
    session.cleanupTimer.unref();
  }

  private append(session: ProcessSession, output: string): void {
    session.buffer.append(output);
    session.transcript.append(output);
  }

  private armRuntimeLimit(session: ProcessSession, maxRuntimeMs: number): void {
    session.runtimeTimer = setTimeout(() => {
      if (!session.running) return;
      session.timedOut = true;
      this.append(session, `Command timed out after ${maxRuntimeMs}ms.\n`);
      session.process?.kill("SIGTERM");
      this.armForceKill(session);
    }, maxRuntimeMs);
    session.runtimeTimer.unref();
  }

  private armForceKill(session: ProcessSession): void {
    if (session.forceKillTimer) return;
    session.forceKillTimer = setTimeout(() => {
      if (session.running) session.process?.kill("SIGKILL");
    }, 250);
    session.forceKillTimer.unref();
  }

  private consume(session: ProcessSession, maxOutputTokens?: number): ProcessSnapshot {
    const limit = boundedInteger(maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 100_000);
    const maxCharacters = Math.max(256, limit * 4);
    const buffered = session.buffer.drain(maxCharacters);

    return this.sessionSnapshot(session, buffered);
  }

  private snapshot(session: ProcessSession, maxOutputTokens?: number): ProcessSnapshot {
    const limit = boundedInteger(maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 100_000);
    const maxCharacters = Math.max(256, limit * 4);
    return this.sessionSnapshot(session, session.transcript.snapshot(maxCharacters));
  }

  private sessionSnapshot(
    session: ProcessSession,
    output: { output: string; truncated: boolean },
  ): ProcessSnapshot {
    const end = session.completedAt ?? Date.now();

    return {
      sessionId: session.id,
      command: session.command,
      workingDirectory: session.workingDirectory,
      tty: session.tty,
      status: session.status,
      output: output.output,
      outputTruncated: output.truncated,
      running: session.running,
      exitCode: session.exitCode,
      signal: session.signal,
      timedOut: session.timedOut,
      interrupted: session.interrupted,
      startedAt: new Date(session.startedAt).toISOString(),
      completedAt: session.completedAt === undefined
        ? undefined
        : new Date(session.completedAt).toISOString(),
      wallTimeMs: end - session.startedAt,
    };
  }

  private persistFinal(session: ProcessSession): void {
    if (!this.store || session.storeFinalized) return;
    session.storeFinalized = true;
    const output = session.transcript.snapshot(this.maxBufferCharacters);
    const record: StoredProcessSession = {
      id: session.id,
      workspaceId: session.workspaceId,
      command: session.command,
      workingDirectory: session.workingDirectory,
      tty: session.tty,
      status: session.status,
      output: output.output,
      outputTruncated: output.truncated,
      exitCode: session.exitCode,
      signal: session.signal,
      timedOut: session.timedOut === true,
      interrupted: session.interrupted === true,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      updatedAt: session.completedAt ?? Date.now(),
    };
    try {
      if (session.status === "interrupted") this.store.interrupt(record);
      else this.store.finish(record);
    } catch (error) {
      this.append(
        session,
        `DevSpace could not persist this process result: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  private getOwnedSession(workspaceId: string, sessionId: number): ProcessSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown process session: ${sessionId}`);
    if (session.workspaceId !== workspaceId) {
      throw new Error(`Process session ${sessionId} does not belong to workspace ${workspaceId}.`);
    }
    return session;
  }

  private removeSession(sessionId: number): void {
    const session = this.sessions.get(sessionId);
    if (session?.cleanupTimer) clearTimeout(session.cleanupTimer);
    if (session?.runtimeTimer) clearTimeout(session.runtimeTimer);
    if (session?.forceKillTimer) clearTimeout(session.forceKillTimer);
    this.sessions.delete(sessionId);
  }
}

function storedProcessSnapshot(
  stored: StoredProcessSession,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
): ProcessSnapshot {
  const limit = boundedInteger(maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 100_000);
  const output = truncateOutput(stored.output, Math.max(256, limit * 4));
  const end = stored.completedAt ?? Date.now();
  return {
    sessionId: stored.id,
    command: stored.command,
    workingDirectory: stored.workingDirectory,
    tty: stored.tty,
    status: stored.status,
    output: output.output,
    outputTruncated: stored.outputTruncated || output.truncated,
    running: stored.status === "running",
    exitCode: stored.exitCode,
    signal: stored.signal,
    timedOut: stored.timedOut || undefined,
    interrupted: stored.interrupted || undefined,
    startedAt: new Date(stored.startedAt).toISOString(),
    completedAt: stored.completedAt === undefined
      ? undefined
      : new Date(stored.completedAt).toISOString(),
    wallTimeMs: end - stored.startedAt,
  };
}
