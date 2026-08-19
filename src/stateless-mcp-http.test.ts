import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";
import { WorkspaceRegistry } from "./workspaces.js";

const PROTOCOL_VERSION = "2025-06-18";
const WORKSPACE_APP_URI = "ui://devspace/workspace-app.html";

test("stateless MCP keeps resources readable after more than 32 fresh client initializations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-stateless-http-test-"));
  const project = join(root, "project");
  const stateDir = join(root, ".state");
  await mkdir(project);
  await ensureUiBuildFixture(t);

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
  authorizeToken(stateDir, publicBaseUrl, token, "Stateless MCP Test");

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

  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: {
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  });
  const client = new Client({
    name: "stateless-sdk-client-test",
    version: "1.0.0",
  });
  await client.connect(transport);
  assert.equal(transport.sessionId, undefined);
  const resource = await client.readResource({ uri: WORKSPACE_APP_URI });
  assert.equal(resource.contents.length, 1);
  assert.equal(resource.contents[0]?.uri, WORKSPACE_APP_URI);
  assert.match(String(resource.contents[0]?.mimeType), /text\/html/);
  await client.close();
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
  authorizeToken(stateDir, publicBaseUrl, token, "Stateless Shutdown Test");

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
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(shutdownFinished, false);

  const rejectedDuringShutdown = await postMcp(endpoint, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "stateless-shutdown-rejected", version: "1.0.0" },
    },
  });
  assert.equal(rejectedDuringShutdown.status, 503);
  assert.match(await rejectedDuringShutdown.text(), /Server is shutting down/);

  releaseClose?.();
  await shutdown;
  assert.equal(shutdownFinished, true);
});

test("shutdown waits for a request admitted before authentication completes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-stateless-auth-shutdown-test-"));
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
  const token = "stateless-auth-shutdown-test-access-token";
  authorizeToken(stateDir, publicBaseUrl, token, "Stateless Auth Shutdown Test");

  const originalVerifyAccessToken = SingleUserOAuthProvider.prototype.verifyAccessToken;
  let releaseVerification: (() => void) | undefined;
  let markVerificationStarted: (() => void) | undefined;
  const verificationStarted = new Promise<void>((resolve) => {
    markVerificationStarted = resolve;
  });
  const verificationRelease = new Promise<void>((resolve) => {
    releaseVerification = resolve;
  });
  SingleUserOAuthProvider.prototype.verifyAccessToken = async function patchedVerifyAccessToken(tokenValue) {
    markVerificationStarted?.();
    await verificationRelease;
    return originalVerifyAccessToken.call(this, tokenValue);
  };

  const running = createServer(config);
  const httpServer = await listen(running.app);
  const address = httpServer.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;

  t.after(async () => {
    SingleUserOAuthProvider.prototype.verifyAccessToken = originalVerifyAccessToken;
    releaseVerification?.();
    await running.close();
    await close(httpServer);
    await rm(root, { recursive: true, force: true });
  });

  const request = postMcp(endpoint, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "stateless-auth-shutdown-test", version: "1.0.0" },
    },
  });
  await verificationStarted;

  let shutdownFinished = false;
  const shutdown = running.close().then(() => {
    shutdownFinished = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(shutdownFinished, false);

  releaseVerification?.();
  const response = await request;
  assert.equal(response.status, 503);
  assert.match(await response.text(), /Server is shutting down/);
  await shutdown;
  assert.equal(shutdownFinished, true);
});

test("shutdown waits for tool handlers after their request transport closes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-stateless-tool-shutdown-test-"));
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
  const token = "stateless-tool-shutdown-test-access-token";
  authorizeToken(stateDir, publicBaseUrl, token, "Stateless Tool Shutdown Test");

  const originalOpenWorkspace = WorkspaceRegistry.prototype.openWorkspace;
  let releaseTool: (() => void) | undefined;
  let markToolStarted: (() => void) | undefined;
  const toolStarted = new Promise<void>((resolve) => {
    markToolStarted = resolve;
  });
  const toolRelease = new Promise<void>((resolve) => {
    releaseTool = resolve;
  });
  WorkspaceRegistry.prototype.openWorkspace = async function patchedOpenWorkspace(input, options) {
    markToolStarted?.();
    await toolRelease;
    return originalOpenWorkspace.call(this, input, options);
  };

  const running = createServer(config);
  const httpServer = await listen(running.app);
  const address = httpServer.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;

  t.after(async () => {
    WorkspaceRegistry.prototype.openWorkspace = originalOpenWorkspace;
    releaseTool?.();
    await running.close();
    await close(httpServer);
    await rm(root, { recursive: true, force: true });
  });

  const toolRequest = postMcp(
    endpoint,
    token,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "open_workspace",
        arguments: { path: project },
      },
    },
    { "mcp-protocol-version": PROTOCOL_VERSION },
  ).catch(() => undefined);
  await toolStarted;

  let shutdownFinished = false;
  const shutdown = running.close().then(() => {
    shutdownFinished = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(shutdownFinished, false);

  releaseTool?.();
  await shutdown;
  await toolRequest;
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

function authorizeToken(
  stateDir: string,
  publicBaseUrl: string,
  token: string,
  clientName: string,
): void {
  const oauthStore = new SqliteOAuthStore(stateDir);
  const oauthClient = oauthStore.registerClient(
    {
      client_name: clientName,
      redirect_uris: ["http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    ["127.0.0.1"],
  );
  oauthStore.saveAccessToken(hashToken(token), {
    clientId: oauthClient.client_id,
    scopes: ["devspace"],
    expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    resource: resourceUrlFromServerUrl(new URL("/mcp", publicBaseUrl)).href,
  });
  oauthStore.close();
}

async function ensureUiBuildFixture(t: TestContext): Promise<void> {
  const uiRoot = join(process.cwd(), "dist", "ui");
  const manifestPath = join(uiRoot, ".vite", "manifest.json");
  if (existsSync(manifestPath)) return;

  const scriptPath = join(uiRoot, "assets", "workspace-app-stateless-test.js");
  const stylesheetPath = join(uiRoot, "assets", "workspace-app-stateless-test.css");
  t.after(async () => {
    await rm(manifestPath, { force: true });
    await rm(scriptPath, { force: true });
    await rm(stylesheetPath, { force: true });
  });

  await mkdir(join(uiRoot, ".vite"), { recursive: true });
  await mkdir(join(uiRoot, "assets"), { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify({
      "workspace-app.html": {
        file: "assets/workspace-app-stateless-test.js",
        css: ["assets/workspace-app-stateless-test.css"],
      },
    }),
  );
  await writeFile(scriptPath, "export {};\n");
  await writeFile(stylesheetPath, "/* stateless MCP test fixture */\n");
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
