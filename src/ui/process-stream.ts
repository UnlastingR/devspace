import type { ToolResultCard } from "./card-types.js";

export interface ProcessStreamSnapshot {
  sessionId: number;
  command: string;
  workingDirectory: string;
  tty: boolean;
  status: "running" | "completed" | "failed" | "interrupted";
  result: string;
  outputTruncated: boolean;
  running: boolean;
  exitCode?: number;
  signal?: string;
  timedOut?: boolean;
  interrupted?: boolean;
  startedAt: string;
  completedAt?: string;
  wallTimeMs: number;
  lines: number;
  characters: number;
}

export function isProcessStreamSnapshot(value: unknown): value is ProcessStreamSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<ProcessStreamSnapshot>;
  return Number.isSafeInteger(snapshot.sessionId)
    && Number(snapshot.sessionId) > 0
    && typeof snapshot.command === "string"
    && typeof snapshot.workingDirectory === "string"
    && typeof snapshot.tty === "boolean"
    && ["running", "completed", "failed", "interrupted"].includes(snapshot.status ?? "")
    && typeof snapshot.result === "string"
    && typeof snapshot.outputTruncated === "boolean"
    && typeof snapshot.running === "boolean"
    && typeof snapshot.startedAt === "string"
    && typeof snapshot.wallTimeMs === "number"
    && Number.isFinite(snapshot.wallTimeMs)
    && typeof snapshot.lines === "number"
    && Number.isFinite(snapshot.lines)
    && typeof snapshot.characters === "number"
    && Number.isFinite(snapshot.characters);
}

export function applyProcessStreamSnapshot(
  card: ToolResultCard,
  snapshot: ProcessStreamSnapshot,
): ToolResultCard {
  return {
    ...card,
    summary: {
      ...card.summary,
      sessionId: snapshot.sessionId,
      command: snapshot.command,
      workingDirectory: snapshot.workingDirectory,
      tty: snapshot.tty,
      status: snapshot.status,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      timedOut: snapshot.timedOut,
      interrupted: snapshot.interrupted,
      startedAt: snapshot.startedAt,
      completedAt: snapshot.completedAt,
      wallTimeMs: snapshot.wallTimeMs,
      outputTruncated: snapshot.outputTruncated,
      lines: snapshot.lines,
      characters: snapshot.characters,
      streamDisconnected: false,
    },
    payload: {
      ...card.payload,
      content: [{ type: "text", text: snapshot.result }],
    },
  };
}
