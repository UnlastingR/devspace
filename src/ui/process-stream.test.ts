import assert from "node:assert/strict";
import test from "node:test";
import {
  applyProcessStreamSnapshot,
  isProcessStreamSnapshot,
  type ProcessStreamSnapshot,
} from "./process-stream.js";

const snapshot: ProcessStreamSnapshot = {
  sessionId: 17,
  command: "npm test",
  workingDirectory: "/tmp/project",
  tty: false,
  status: "completed",
  result: "ok\nProcess 17 exited with code 0.",
  outputTruncated: false,
  running: false,
  exitCode: 0,
  startedAt: "2026-08-13T12:00:00.000Z",
  completedAt: "2026-08-13T12:00:02.500Z",
  wallTimeMs: 2_500,
  lines: 1,
  characters: 3,
};

test("process stream snapshots update one existing shell card", () => {
  assert.equal(isProcessStreamSnapshot(snapshot), true);
  const card = applyProcessStreamSnapshot({
    tool: "exec_command",
    workspaceId: "ws_example",
    summary: { running: true, wallTimeMs: 2_000 },
    payload: { content: [{ type: "text", text: "still running" }] },
    processStream: {
      url: "https://devspace.example/mcp-app-streams/process/token",
      expiresAt: "2026-08-13T13:00:00.000Z",
    },
  }, snapshot);

  assert.equal(card.summary?.running, false);
  assert.equal(card.summary?.exitCode, 0);
  assert.equal(card.summary?.wallTimeMs, 2_500);
  assert.equal(card.payload?.content?.[0]?.text, snapshot.result);
  assert.equal(card.processStream?.url.includes("/process/"), true);
});

test("process stream snapshot validation rejects incomplete payloads", () => {
  assert.equal(isProcessStreamSnapshot({ ...snapshot, result: undefined }), false);
  assert.equal(isProcessStreamSnapshot({ ...snapshot, sessionId: 0 }), false);
});
