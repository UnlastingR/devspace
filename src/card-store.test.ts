import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteCardStore } from "./card-store.js";

test("card snapshots persist independently of widget lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-card-store-test-"));
  try {
    const first = new SqliteCardStore(root);
    const saved = first.save({
      conversationScopeId: "chat-1",
      workspaceId: "ws-1",
      tool: "show_changes",
      card: {
        tool: "show_changes",
        workspaceId: "ws-1",
        payload: { patch: "diff --git a/a b/a" },
      },
    });
    first.close();

    assert.equal(saved.card.cardId, saved.id);

    const reopened = new SqliteCardStore(root);
    try {
      assert.deepEqual(reopened.get(saved.id), saved);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
