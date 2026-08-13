import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  isShellTool,
  isToolName,
  type ToolContent,
  type ToolName,
  type ToolResultCard,
} from "./card-types.js";

interface ResolveToolResultCardOptions {
  hostToolName?: unknown;
  toolOutput?: unknown;
  toolResponseMetadata?: unknown;
}

const processSummaryKeys = [
  "sessionId",
  "command",
  "workingDirectory",
  "tty",
  "status",
  "running",
  "exitCode",
  "signal",
  "timedOut",
  "interrupted",
  "startedAt",
  "completedAt",
  "wallTimeMs",
  "outputTruncated",
  "lines",
  "characters",
] as const;

export function resolveToolResultCard(
  result: CallToolResult,
  options: ResolveToolResultCardOptions = {},
): ToolResultCard | undefined {
  const metadataResults = toolResultsFromMetadata(options.toolResponseMetadata);
  const resultCandidates = [result, ...metadataResults];
  const structuredContent = firstRecord(
    resultCandidates.map((candidate) => candidate.structuredContent),
  ) ?? asRecord(options.toolOutput);
  const resultMetas = resultCandidates
    .map((candidate) => asRecord(candidate._meta))
    .filter((candidate): candidate is Record<string, unknown> => Boolean(candidate));
  const meta = resultMetas.find((candidate) => (
    candidate.card !== undefined || isToolName(candidate.tool)
  )) ?? resultMetas[0];
  const metaCard = asRecord(meta?.card);
  const tool = resolveToolName(meta?.tool, structuredContent?.tool, options.hostToolName);

  if (!tool) return undefined;
  if (metaCard) {
    return {
      ...(structuredContent ?? {}),
      ...metaCard,
      tool,
    } as ToolResultCard;
  }

  if (!structuredContent || !isShellTool(tool)) return undefined;
  return recoverProcessCard(tool, structuredContent, resultCandidates);
}

function recoverProcessCard(
  tool: ToolName,
  structuredContent: Record<string, unknown>,
  results: CallToolResult[],
): ToolResultCard | undefined {
  const processes = Array.isArray(structuredContent.processes)
    ? structuredContent.processes
    : undefined;
  const sessionId = structuredContent.sessionId;
  const isProcessList = tool === "process_status" && processes !== undefined;

  if (!isProcessList && typeof sessionId !== "number") return undefined;

  const content = firstToolContent(results);
  const resultText = typeof structuredContent.result === "string"
    ? structuredContent.result
    : toolContentText(content);
  const payloadContent = content.length > 0
    ? content
    : resultText
      ? [{ type: "text" as const, text: resultText }]
      : [];
  const summary: Record<string, unknown> = {};

  for (const key of processSummaryKeys) {
    if (structuredContent[key] !== undefined) summary[key] = structuredContent[key];
  }

  if (isProcessList) {
    summary.processes = processes.length;
    summary.running = processes.filter((process) => asRecord(process)?.running === true).length;
  }

  if (summary.lines === undefined || summary.characters === undefined) {
    const text = toolContentText(payloadContent);
    if (summary.lines === undefined) {
      summary.lines = text.length === 0 ? 0 : text.split("\n").length;
    }
    if (summary.characters === undefined) summary.characters = text.length;
  }

  if (summary.running === true) summary.streamDisconnected = true;

  return {
    tool,
    workspaceId: typeof structuredContent.workspaceId === "string"
      ? structuredContent.workspaceId
      : undefined,
    path: typeof structuredContent.workingDirectory === "string"
      ? structuredContent.workingDirectory
      : undefined,
    summary,
    ...(payloadContent.length > 0 ? { payload: { content: payloadContent } } : {}),
  };
}

function toolResultsFromMetadata(value: unknown): CallToolResult[] {
  const metadata = asRecord(value);
  if (!metadata) return [];

  const candidates = [
    metadata.mcp_tool_result,
    metadata.call_tool_result,
  ];
  const results: CallToolResult[] = [];

  for (const candidate of candidates) {
    const record = asRecord(candidate);
    if (!record) continue;
    const nestedResult = asRecord(record.result);
    results.push((nestedResult ?? record) as CallToolResult);
  }

  return results;
}

function resolveToolName(...candidates: unknown[]): ToolName | undefined {
  return candidates.find(isToolName) as ToolName | undefined;
}

function firstRecord(values: unknown[]): Record<string, unknown> | undefined {
  for (const value of values) {
    const record = asRecord(value);
    if (record) return record;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstToolContent(results: CallToolResult[]): ToolContent[] {
  for (const result of results) {
    if (!Array.isArray(result.content)) continue;
    const content = result.content.flatMap((item): ToolContent[] => {
      if (item.type === "text") return [{ type: "text", text: item.text }];
      if (item.type === "image") {
        return [{ type: "image", data: item.data, mimeType: item.mimeType }];
      }
      return [];
    });
    if (content.length > 0) return content;
  }
  return [];
}

function toolContentText(content: ToolContent[]): string {
  return content
    .map((item) => item.type === "text" ? item.text ?? "" : "")
    .filter(Boolean)
    .join("\n\n");
}
