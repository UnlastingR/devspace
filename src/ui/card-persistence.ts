import {
  isToolName,
  isToolResultCard,
  type ToolResultCard,
} from "./card-types.js";

const PERSISTED_CARD_KEY = "devspaceCard";
const PERSISTED_CARD_VERSION = 1;

export interface OpenAIWidgetStateBridge {
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
