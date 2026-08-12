import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

test("Gemini Spark can dynamically register through its issuer-root fallback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-oauth-http-test-"));
  const project = join(root, "project");
  await mkdir(project);

  const running = createServer(loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
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
    redirect_uris: ["https://oauth-redirect.googleusercontent.com/r/devspace-test"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  };

  const response = await fetch(`${baseUrl}/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "OpenAuth",
    },
    body: JSON.stringify(registration),
  });
  const client = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 201);
  assert.equal(typeof client.client_id, "string");
  assert.equal(typeof client.client_secret, "string");
  assert.deepEqual(client.redirect_uris, registration.redirect_uris);

  const unrelated = await fetch(`${baseUrl}/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "not-spark",
    },
    body: JSON.stringify(registration),
  });
  assert.equal(unrelated.status, 404);
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
