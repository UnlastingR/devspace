import {
  isToolName,
  isToolResultCard,
  type ToolResultCard,
} from "./card-types.js";

const PERSISTED_CARD_KEY = "devspaceCard";
const PERSISTED_CARD_VERSION = 1;

export interface OpenAIWidgetStateBridge {
  toolOutput?: unknown;
  toolResponseMetadata?: unknown;
  widgetState?: unknown;
  setWidgetState?: (state: unknown) => void;
}

interface PersistedCardEnvelope {
  version: number;
  card: ToolResultCard;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function persistedCardFromWidgetState(widgetState: unknown): ToolResultCard | undefined {
  const state = asRecord(widgetState);
  const privateContent = asRecord(state?.privateContent);
  const envelope = asRecord(privateContent?.[PERSISTED_CARD_KEY]);

  if (envelope?.version !== PERSISTED_CARD_VERSION) return undefined;

  const candidate = asRecord(envelope.card);
  if (!candidate || !isToolName(candidate.tool) || !isToolResultCard(candidate)) {
    return undefined;
  }

  return candidate as unknown as ToolResultCard;
}

export function cardFromOpenAIToolGlobals(
  toolOutput: unknown,
  toolResponseMetadata: unknown,
): ToolResultCard | undefined {
  const responseMetadata = asRecord(toolResponseMetadata);
  const result = asRecord(responseMetadata?.mcp_tool_result)
    ?? asRecord(responseMetadata?.call_tool_result);
  const resultMeta = asRecord(result?._meta);
  const metaCard = asRecord(resultMeta?.card);
  const structuredContent = asRecord(toolOutput)
    ?? asRecord(result?.structuredContent)
    ?? {};
  const tool = resultMeta?.tool;

  if (!isToolName(tool)) return undefined;

  const candidate = {
    ...structuredContent,
    ...(metaCard ?? {}),
    tool,
  };
  if (!isToolResultCard(candidate)) return undefined;

  return candidate as unknown as ToolResultCard;
}

export function persistedCardFromOpenAIHost(
  bridge: OpenAIWidgetStateBridge | undefined,
): ToolResultCard | undefined {
  if (!bridge) return undefined;

  return persistedCardFromWidgetState(bridge.widgetState)
    ?? cardFromOpenAIToolGlobals(bridge.toolOutput, bridge.toolResponseMetadata);
}

export function widgetStateWithPersistedCard(
  widgetState: unknown,
  card: ToolResultCard,
): Record<string, unknown> {
  const currentState = asRecord(widgetState) ?? {};
  const currentPrivateContent = asRecord(currentState.privateContent) ?? {};
  const persisted: PersistedCardEnvelope = {
    version: PERSISTED_CARD_VERSION,
    card,
  };

  return {
    ...currentState,
    privateContent: {
      ...currentPrivateContent,
      [PERSISTED_CARD_KEY]: persisted,
    },
  };
}
