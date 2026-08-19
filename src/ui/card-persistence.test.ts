import assert from "node:assert/strict";
import test from "node:test";
import {
  cardFromOpenAIToolGlobals,
  persistedCardFromOpenAIHost,
  persistedCardFromWidgetState,
  widgetStateWithPersistedCard,
} from "./card-persistence.js";
import type { ToolResultCard } from "./card-types.js";

test("card state round-trips without clobbering host state", () => {
  const card: ToolResultCard = { tool: "read", path: "README.md" };
  const state = widgetStateWithPersistedCard(
    { modelContent: "keep", privateContent: { selectedTab: "files" } },
    card,
  );

  assert.equal(state.modelContent, "keep");
  assert.equal((state.privateContent as Record<string, unknown>).selectedTab, "files");
  assert.deepEqual(persistedCardFromWidgetState(state), card);
});

test("persisted state wins over ChatGPT globals", () => {
  const card: ToolResultCard = { tool: "read", path: "README.md" };
  assert.deepEqual(
    persistedCardFromOpenAIHost({
      widgetState: widgetStateWithPersistedCard(undefined, card),
      toolOutput: { path: "other.txt" },
    }),
    card,
  );
});

test("ChatGPT globals can rehydrate a historical card", () => {
  assert.deepEqual(
    cardFromOpenAIToolGlobals(
      { workspaceId: "ws_history" },
      {
        mcp_tool_result: {
          _meta: { tool: "show_changes", card: { workspaceId: "ws_history" } },
        },
      },
    ),
    { tool: "show_changes", workspaceId: "ws_history" },
  );
});
