import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteProcessSessionStore, type StoredProcessSession } from "./process-store.js";

test("process results survive store reopen and abandoned running records become interrupted", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-process-store-test-"));
  try {
    const startedAt = Date.now() - 1_000;
    const first = new SqliteProcessSessionStore(stateDir);
    const completedId = first.create({
      workspaceId: "workspace-a",
      command: "echo completed",
      workingDirectory: "/tmp/project",
      tty: false,
      startedAt,
    });
    first.finish(record({
      id: completedId,
      startedAt,
      status: "completed",
      output: "completed\n",
      exitCode: 0,
    }));

    const runningId = first.create({
      workspaceId: "workspace-a",
      command: "long-running",
      workingDirectory: "/tmp/project",
      tty: false,
      startedAt: Date.now(),
    });
    first.close();

    const reopened = new SqliteProcessSessionStore(stateDir);
    const completed = reopened.get("workspace-a", completedId);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.output, "completed\n");
    assert.equal(completed?.exitCode, 0);

    const interrupted = reopened.get("workspace-a", runningId);
    assert.equal(interrupted?.status, "interrupted");
    assert.equal(interrupted?.interrupted, true);
    assert.equal(interrupted?.completedAt !== undefined, true);
    assert.deepEqual(
      reopened.list("workspace-a", 10).map((entry) => entry.id),
      [runningId, completedId],
    );
    assert.equal(reopened.get("workspace-b", completedId), undefined);
    reopened.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

function record(input: {
  id: number;
  startedAt: number;
  status: StoredProcessSession["status"];
  output: string;
  exitCode?: number;
}): StoredProcessSession {
  const completedAt = input.startedAt + 10;
  return {
    id: input.id,
    workspaceId: "workspace-a",
    command: "echo completed",
    workingDirectory: "/tmp/project",
    tty: false,
    status: input.status,
    output: input.output,
    outputTruncated: false,
    exitCode: input.exitCode,
    timedOut: false,
    interrupted: false,
    startedAt: input.startedAt,
    completedAt,
    updatedAt: completedAt,
  };
}
