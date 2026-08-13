import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";

test("Gemini Spark can dynamically register through its issuer-root fallback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-oauth-http-test-"));
  const project = join(root, "project");
  await mkdir(project);

  const running = createServer(loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_STATE_DIR: join(root, ".state"),
    DEVSPACE_ALLOWED_ROOTS: project,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:1",
    DEVSPACE_LOG_LEVEL: "silent",
    PORT: "1",
  }));
  const httpServer = await listen(running.app);

  t.after(async () => {
    await close(httpServer);
    await running.close();
    await rm(root, { recursive: true, force: true });
  });

  const address = httpServer.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const registration = {
    client_name: "Gemini Spark",
    redirect_uris: ["https://oauth-redirect-test.googleusercontent.com/r/devspace-test"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  };

  const response = await fetch(`${baseUrl}/`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "user-agent": "OpenAuth/1.0",
    },
    body: JSON.stringify(registration),
  });
  const client = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 201);
  assert.equal(typeof client.client_id, "string");
  assert.equal(typeof client.client_secret, "string");
  assert.deepEqual(client.redirect_uris, registration.redirect_uris);

  const rejected = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "OpenAuth",
    },
    body: JSON.stringify({
      ...registration,
      redirect_uris: ["https://unapproved.example/callback"],
    }),
  });
  const rejectedBody = await rejected.json() as Record<string, unknown>;
  assert.equal(rejected.status, 400);
  assert.match(String(rejectedBody.error_description), /unapproved\.example/);

  const unrelated = await fetch(`${baseUrl}/`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "user-agent": "not-spark",
    },
    body: JSON.stringify(registration),
  });
  assert.equal(unrelated.status, 404);
});

test("workspace app template reads do not depend on a retained MCP session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-template-http-test-"));
  const project = join(root, "project");
  const stateDir = join(root, ".state");
  await mkdir(project);

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_ALLOWED_ROOTS: project,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:7676",
    DEVSPACE_LOG_LEVEL: "silent",
    PORT: "1",
  });
  assert.equal(config.mcpMaxSessions, 32);
  assert.equal(config.mcpSessionIdleTimeoutMs, 5 * 60 * 1_000);

  const accessToken = "test-access-token";
  const oauthStore = new SqliteOAuthStore(stateDir);
  const client = oauthStore.registerClient(
    {
      client_name: "Template test client",
      redirect_uris: ["http://127.0.0.1/callback"],
    },
    config.oauth.allowedRedirectHosts,
  );
  oauthStore.saveAccessToken(
    createHash("sha256").update(accessToken).digest("base64url"),
    {
      clientId: client.client_id,
      scopes: config.oauth.scopes,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      resource: new URL("/mcp", config.publicBaseUrl).href,
    },
  );
  oauthStore.close();

  const templateResult = {
    contents: [
      {
        uri: "ui://devspace/workspace-app.html",
        mimeType: "text/html;profile=mcp-app",
        text: "<!doctype html><title>DevSpace test template</title>",
      },
    ],
  };
  let templateReads = 0;
  const running = createServer(config, {
    workspaceAppResourceReader: async () => {
      templateReads += 1;
      return templateResult;
    },
  });
  const httpServer = await listen(running.app);

  t.after(async () => {
    await close(httpServer);
    await running.close();
    await rm(root, { recursive: true, force: true });
  });

  const address = httpServer.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const readTemplate = (sessionId?: string, uri = "ui://devspace/workspace-app.html") =>
    fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "read-template",
        method: "resources/read",
        params: { uri },
      }),
    });

  const withoutSession = await readTemplate();
  assert.equal(withoutSession.status, 200);
  assert.equal(withoutSession.headers.get("mcp-session-id"), null);
  assert.deepEqual(await withoutSession.json(), {
    jsonrpc: "2.0",
    id: "read-template",
    result: templateResult,
  });

  const afterEviction = await readTemplate("already-evicted-session");
  assert.equal(afterEviction.status, 200);
  assert.deepEqual(await afterEviction.json(), {
    jsonrpc: "2.0",
    id: "read-template",
    result: templateResult,
  });

  const otherResource = await readTemplate("already-evicted-session", "ui://devspace/other.html");
  assert.equal(otherResource.status, 404);
  assert.match(JSON.stringify(await otherResource.json()), /Unknown MCP session/);

  const unauthorized = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "unauthorized-template-read",
      method: "resources/read",
      params: { uri: "ui://devspace/workspace-app.html" },
    }),
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(templateReads, 2);
});

function listen(app: ReturnType<typeof createServer>["app"]): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
