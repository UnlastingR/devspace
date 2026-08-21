import assert from "node:assert/strict";
import test from "node:test";
import {
  cardInvocationFromHostContext,
  cardReferenceFromOpenAIHost,
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

test("card reference survives when historical globals retain only structured output", () => {
  assert.deepEqual(
    cardReferenceFromOpenAIHost({
      toolOutput: {
        result: "Changed 1 file (+1 -0).",
        cardId: "card-history",
      },
    }),
    { cardId: "card-history", source: "toolOutput" },
  );
});

test("card reference can arrive after the widget initially mounts without identity", () => {
  const bridge: {
    toolOutput?: unknown;
  } = {};

  assert.equal(cardReferenceFromOpenAIHost(bridge), undefined);

  bridge.toolOutput = {
    result: "Changed 1 file (+1 -0).",
    cardId: "card-late-globals",
  };

  assert.deepEqual(
    cardReferenceFromOpenAIHost(bridge),
    { cardId: "card-late-globals", source: "toolOutput" },
  );
});

test("host context exposes the original tool invocation id for card recovery", () => {
  assert.deepEqual(
    cardInvocationFromHostContext({
      toolInfo: {
        id: 73,
        tool: { name: "exec_command" },
      },
    }),
    { requestId: 73, tool: "exec_command" },
  );
  assert.deepEqual(
    cardInvocationFromHostContext({
      toolInfo: {
        id: "call-abc",
        tool: { name: "read" },
      },
    }),
    { requestId: "call-abc", tool: "read" },
  );
  assert.equal(cardInvocationFromHostContext({ toolInfo: { tool: { name: "read" } } }), undefined);
});

test("persisted widget card id remains the preferred recovery reference", () => {
  const widgetState = widgetStateWithPersistedCard(undefined, {
    tool: "show_changes",
    cardId: "card-widget-state",
  });

  assert.deepEqual(
    cardReferenceFromOpenAIHost({
      widgetState,
      toolOutput: { cardId: "card-tool-output" },
    }),
    { cardId: "card-widget-state", source: "widgetState" },
  );
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
