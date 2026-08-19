import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import { SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";

const PROTOCOL_VERSION = "2025-06-18";
const WORKSPACE_APP_URI = "ui://devspace/workspace-app.html";

test("stateless MCP keeps resources readable after more than 32 fresh client initializations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-stateless-http-test-"));
  const project = join(root, "project");
  const stateDir = join(root, ".state");
  await mkdir(project);

  const publicBaseUrl = "http://127.0.0.1:1";
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_ALLOWED_ROOTS: project,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
    DEVSPACE_LOG_LEVEL: "silent",
    DEVSPACE_WIDGETS: "changes",
    PORT: "1",
  });

  const token = "stateless-mcp-test-access-token";
  const oauthStore = new SqliteOAuthStore(stateDir);
  oauthStore.saveAccessToken(hashToken(token), {
    clientId: "stateless-test-client",
    scopes: ["devspace"],
    expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    resource: resourceUrlFromServerUrl(new URL("/mcp", publicBaseUrl)).href,
  });
  oauthStore.close();

  const running = createServer(config);
  const httpServer = await listen(running.app);
  const address = httpServer.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;

  t.after(async () => {
    await close(httpServer);
    await running.close();
    await rm(root, { recursive: true, force: true });
  });

  for (let index = 0; index < 40; index += 1) {
    const initialized = await postMcp(endpoint, token, {
      jsonrpc: "2.0",
      id: index * 2 + 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "stateless-test", version: "1.0.0" },
      },
    });
    assert.equal(initialized.status, 200);
    assert.equal(initialized.headers.get("mcp-session-id"), null);

    const resource = await postMcp(
      endpoint,
      token,
      {
        jsonrpc: "2.0",
        id: index * 2 + 2,
        method: "resources/read",
        params: { uri: WORKSPACE_APP_URI },
      },
      { "mcp-protocol-version": PROTOCOL_VERSION },
    );
    assert.equal(resource.status, 200);
    assert.equal(resource.headers.get("mcp-session-id"), null);
    const body = await resource.text();
    assert.match(body, /ui:\/\/devspace\/workspace-app\.html/);
    assert.match(body, /text\/html/);
  }
});

test("server shutdown waits for active request-scoped MCP cleanup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-stateless-shutdown-test-"));
  const project = join(root, "project");
  const stateDir = join(root, ".state");
  await mkdir(project);

  const publicBaseUrl = "http://127.0.0.1:1";
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_ALLOWED_ROOTS: project,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
    DEVSPACE_LOG_LEVEL: "silent",
    PORT: "1",
  });

  const token = "stateless-shutdown-test-access-token";
  const oauthStore = new SqliteOAuthStore(stateDir);
  oauthStore.saveAccessToken(hashToken(token), {
    clientId: "stateless-shutdown-test-client",
    scopes: ["devspace"],
    expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    resource: resourceUrlFromServerUrl(new URL("/mcp", publicBaseUrl)).href,
  });
  oauthStore.close();

  const originalClose = McpServer.prototype.close;
  let releaseClose: (() => void) | undefined;
  let markCloseStarted: (() => void) | undefined;
  const closeStarted = new Promise<void>((resolve) => {
    markCloseStarted = resolve;
  });
  const closeRelease = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  McpServer.prototype.close = async function patchedClose() {
    markCloseStarted?.();
    await closeRelease;
    await originalClose.call(this);
  };

  const running = createServer(config);
  const httpServer = await listen(running.app);
  const address = httpServer.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;

  t.after(async () => {
    McpServer.prototype.close = originalClose;
    releaseClose?.();
    await running.close();
    await close(httpServer);
    await rm(root, { recursive: true, force: true });
  });

  const initialized = await postMcp(endpoint, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "stateless-shutdown-test", version: "1.0.0" },
    },
  });
  assert.equal(initialized.status, 200);
  await initialized.text();
  await closeStarted;

  let shutdownFinished = false;
  const shutdown = running.close().then(() => {
    shutdownFinished = true;
  });
  await Promise.resolve();
  assert.equal(shutdownFinished, false);

  releaseClose?.();
  await shutdown;
  assert.equal(shutdownFinished, true);
});

function postMcp(
  endpoint: string,
  token: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

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
