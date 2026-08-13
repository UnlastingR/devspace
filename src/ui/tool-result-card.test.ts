import assert from "node:assert/strict";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveToolResultCard } from "./tool-result-card.js";

test("preserves the existing hidden card metadata path", () => {
  const result: CallToolResult = {
    content: [{ type: "text", text: "done" }],
    structuredContent: { result: "done", running: false },
    _meta: {
      tool: "exec_command",
      card: {
        workspaceId: "ws_metadata",
        summary: { running: false, exitCode: 0 },
        payload: { content: [{ type: "text", text: "done" }] },
      },
    },
  };

  const card = resolveToolResultCard(result);
  assert.equal(card?.tool, "exec_command");
  assert.equal(card?.workspaceId, "ws_metadata");
  assert.equal(card?.summary?.exitCode, 0);
});

test("recovers a completed process card from structured content without result metadata", () => {
  const result: CallToolResult = {
    content: [{ type: "text", text: "tests passed\nProcess 42 exited with code 0." }],
    structuredContent: {
      tool: "exec_command",
      workspaceId: "ws_completed",
      result: "tests passed\nProcess 42 exited with code 0.",
      sessionId: 42,
      command: "npm test",
      workingDirectory: ".",
      status: "completed",
      running: false,
      exitCode: 0,
      wallTimeMs: 1_250,
      outputTruncated: false,
      lines: 1,
      characters: 12,
    },
  };

  const card = resolveToolResultCard(result);
  assert.equal(card?.tool, "exec_command");
  assert.equal(card?.workspaceId, "ws_completed");
  assert.equal(card?.summary?.status, "completed");
  assert.equal(card?.summary?.wallTimeMs, 1_250);
  assert.equal(card?.summary?.lines, 1);
  assert.equal(card?.payload?.content?.[0]?.text, "tests passed\nProcess 42 exited with code 0.");
});

test("recovers historical process results using the host tool definition", () => {
  const result: CallToolResult = {
    content: [{ type: "text", text: "legacy output" }],
    structuredContent: {
      result: "legacy output",
      sessionId: 7,
      command: "npm run build",
      workingDirectory: ".",
      status: "completed",
      running: false,
      exitCode: 0,
      wallTimeMs: 900,
      outputTruncated: false,
    },
  };

  const card = resolveToolResultCard(result, { hostToolName: "write_stdin" });
  assert.equal(card?.tool, "write_stdin");
  assert.equal(card?.summary?.sessionId, 7);
  assert.equal(card?.summary?.lines, 1);
});

test("uses ChatGPT response metadata when the standard notification omits hidden metadata", () => {
  const result: CallToolResult = {
    content: [{ type: "text", text: "done" }],
    structuredContent: { result: "done" },
    _meta: {},
  };

  const card = resolveToolResultCard(result, {
    toolResponseMetadata: {
      mcp_tool_result: {
        _meta: {
          tool: "exec_command",
          card: {
            workspaceId: "ws_compatibility",
            summary: { sessionId: 9, running: false, exitCode: 0 },
          },
        },
      },
    },
  });

  assert.equal(card?.tool, "exec_command");
  assert.equal(card?.workspaceId, "ws_compatibility");
  assert.equal(card?.summary?.sessionId, 9);
});

test("marks a recovered running card as disconnected instead of implying live updates", () => {
  const result: CallToolResult = {
    content: [{ type: "text", text: "still running" }],
    structuredContent: {
      tool: "exec_command",
      workspaceId: "ws_running",
      result: "still running",
      sessionId: 11,
      command: "npm test",
      workingDirectory: ".",
      status: "running",
      running: true,
      wallTimeMs: 2_000,
      outputTruncated: false,
    },
  };

  const card = resolveToolResultCard(result);
  assert.equal(card?.summary?.running, true);
  assert.equal(card?.summary?.streamDisconnected, true);
});

test("does not invent a card when neither metadata nor process identity is available", () => {
  const result: CallToolResult = {
    content: [{ type: "text", text: "plain result" }],
    structuredContent: { result: "plain result" },
  };

  assert.equal(resolveToolResultCard(result, { hostToolName: "read" }), undefined);
});
