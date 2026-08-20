function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function authorized(request, env) {
  const expected = env.CARD_STORE_TOKEN;
  if (!expected) return false;
  return request.headers.get("authorization") === `Bearer ${expected}`;
}

function parseCardPath(url) {
  const match = new URL(url).pathname.match(/^\/cards\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function validSnapshot(value, id) {
  return Boolean(
    value
      && typeof value === "object"
      && !Array.isArray(value)
      && value.id === id
      && typeof value.tool === "string"
      && typeof value.createdAt === "string"
      && value.card
      && typeof value.card === "object"
      && !Array.isArray(value.card)
      && (value.conversationScopeId === undefined || typeof value.conversationScopeId === "string")
      && (value.workspaceId === undefined || typeof value.workspaceId === "string"),
  );
}

export default {
  async fetch(request, env) {
    if (!authorized(request, env)) {
      return json({ error: "unauthorized" }, 401);
    }

    const id = parseCardPath(request.url);
    if (!id) return json({ error: "not_found" }, 404);

    if (request.method === "GET") {
      const row = await env.DB.prepare(
        `SELECT id, conversation_scope_id, workspace_id, tool, card_json, created_at
         FROM card_snapshots
         WHERE id = ?`,
      ).bind(id).first();

      if (!row) return json({ error: "not_found" }, 404);

      let card;
      try {
        card = JSON.parse(row.card_json);
      } catch {
        return json({ error: "stored_card_malformed" }, 500);
      }

      return json({
        id: row.id,
        ...(row.conversation_scope_id ? { conversationScopeId: row.conversation_scope_id } : {}),
        ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
        tool: row.tool,
        card,
        createdAt: row.created_at,
      });
    }

    if (request.method === "PUT") {
      let snapshot;
      try {
        snapshot = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }

      if (!validSnapshot(snapshot, id)) {
        return json({ error: "invalid_snapshot" }, 400);
      }

      await env.DB.prepare(
        `INSERT INTO card_snapshots (
           id, conversation_scope_id, workspace_id, tool, card_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           conversation_scope_id = excluded.conversation_scope_id,
           workspace_id = excluded.workspace_id,
           tool = excluded.tool,
           card_json = excluded.card_json,
           created_at = excluded.created_at`,
      ).bind(
        snapshot.id,
        snapshot.conversationScopeId ?? null,
        snapshot.workspaceId ?? null,
        snapshot.tool,
        JSON.stringify(snapshot.card),
        snapshot.createdAt,
      ).run();

      return new Response(null, {
        status: 204,
        headers: { "cache-control": "no-store" },
      });
    }

    return json({ error: "method_not_allowed" }, 405);
  },
};
