import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { cardSnapshots, type CardSnapshotRow } from "./db/schema.js";

export interface StoredCardSnapshot {
  id: string;
  conversationScopeId?: string;
  workspaceId?: string;
  tool: string;
  card: Record<string, unknown>;
  createdAt: string;
}

export interface CardStore {
  save(input: {
    conversationScopeId?: string;
    workspaceId?: string;
    tool: string;
    card: Record<string, unknown>;
  }): StoredCardSnapshot;
  get(id: string): StoredCardSnapshot | undefined;
  close?(): void;
}

export class SqliteCardStore implements CardStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  save(input: {
    conversationScopeId?: string;
    workspaceId?: string;
    tool: string;
    card: Record<string, unknown>;
  }): StoredCardSnapshot {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const card = {
      ...input.card,
      cardId: id,
    };

    this.database.db
      .insert(cardSnapshots)
      .values({
        id,
        conversationScopeId: input.conversationScopeId ?? null,
        workspaceId: input.workspaceId ?? null,
        tool: input.tool,
        cardJson: JSON.stringify(card),
        createdAt,
      })
      .run();

    return {
      id,
      conversationScopeId: input.conversationScopeId,
      workspaceId: input.workspaceId,
      tool: input.tool,
      card,
      createdAt,
    };
  }

  get(id: string): StoredCardSnapshot | undefined {
    const row = this.database.db
      .select()
      .from(cardSnapshots)
      .where(eq(cardSnapshots.id, id))
      .get();

    return row ? rowToStoredCardSnapshot(row) : undefined;
  }

  close(): void {
    this.database.close();
  }
}

function rowToStoredCardSnapshot(row: CardSnapshotRow): StoredCardSnapshot {
  const parsed = JSON.parse(row.cardJson) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Stored card snapshot ${row.id} is malformed.`);
  }

  return {
    id: row.id,
    conversationScopeId: row.conversationScopeId ?? undefined,
    workspaceId: row.workspaceId ?? undefined,
    tool: row.tool,
    card: parsed as Record<string, unknown>,
    createdAt: row.createdAt,
  };
}
