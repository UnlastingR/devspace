import assert from "node:assert/strict";
import test from "node:test";
import {
  cardFromOpenAIToolGlobals,
  persistedCardFromOpenAIHost,
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

test("ChatGPT globals can rehydrate a historical card without a tool-result event", () => {
  const card = cardFromOpenAIToolGlobals(
    {
      workspaceId: "ws_history",
      summary: { additions: 8, removals: 2 },
    },
    {
      mcp_tool_result: {
        structuredContent: { workspaceId: "ws_history" },
        _meta: {
          tool: "show_changes",
          card: {
            workspaceId: "ws_history",
            files: [{ path: "src/example.ts", operation: "update", additions: 8, removals: 2 }],
            payload: { patch: "diff --git a/src/example.ts b/src/example.ts" },
          },
        },
      },
    },
  );

  assert.deepEqual(card, {
    tool: "show_changes",
    workspaceId: "ws_history",
    summary: { additions: 8, removals: 2 },
    files: [{ path: "src/example.ts", operation: "update", additions: 8, removals: 2 }],
    payload: { patch: "diff --git a/src/example.ts b/src/example.ts" },
  });
});

test("persisted widget state remains preferred over ChatGPT result globals", () => {
  const persisted: ToolResultCard = { tool: "read", path: "README.md" };
  const widgetState = widgetStateWithPersistedCard(undefined, persisted);

  assert.deepEqual(
    persistedCardFromOpenAIHost({
      widgetState,
      toolOutput: { path: "other.txt" },
      toolResponseMetadata: {
        mcp_tool_result: { _meta: { tool: "read", card: { path: "other.txt" } } },
      },
    }),
    persisted,
  );
});
