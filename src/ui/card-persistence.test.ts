import assert from "node:assert/strict";
import test from "node:test";
import {
  persistedCardFromWidgetState,
  widgetStateWithPersistedCard,
} from "./card-persistence.js";
import type { ToolResultCard } from "./card-types.js";

test("card widget state round-trips a private DevSpace snapshot", () => {
  const card: ToolResultCard = {
    tool: "show_changes",
    workspaceId: "ws_example",
    summary: { additions: 4, removals: 1 },
    files: [{ path: "src/example.ts", operation: "update", additions: 4, removals: 1 }],
    payload: { patch: "diff --git a/src/example.ts b/src/example.ts" },
  };

  const nextState = widgetStateWithPersistedCard(
    {
      modelContent: "keep this model-visible context",
      privateContent: { selectedTab: "files" },
    },
    card,
  );

  assert.equal(nextState.modelContent, "keep this model-visible context");
  assert.equal(
    (nextState.privateContent as Record<string, unknown>).selectedTab,
    "files",
  );
  assert.deepEqual(persistedCardFromWidgetState(nextState), card);
});

test("card widget state does not invent model-visible content", () => {
  const card: ToolResultCard = { tool: "read", path: "README.md" };
  const nextState = widgetStateWithPersistedCard(undefined, card);

  assert.equal("modelContent" in nextState, false);
  assert.deepEqual(persistedCardFromWidgetState(nextState), card);
});

test("malformed or unsupported widget state is ignored", () => {
  assert.equal(persistedCardFromWidgetState(undefined), undefined);
  assert.equal(
    persistedCardFromWidgetState({
      privateContent: {
        devspaceCard: { version: 99, card: { tool: "read" } },
      },
    }),
    undefined,
  );
  assert.equal(
    persistedCardFromWidgetState({
      privateContent: {
        devspaceCard: { version: 1, card: { tool: "not-a-tool" } },
      },
    }),
    undefined,
  );
});
