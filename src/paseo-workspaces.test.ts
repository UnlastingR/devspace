import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PaseoWorkspaceBridge } from "./paseo-workspaces.js";

const config = {
  url: "ws://127.0.0.1:6767/ws",
  timeoutMs: 1_000,
};

test("Paseo registration reuses an active workspace with the same real path", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-paseo-reuse-"));
  const calls: string[] = [];
  const bridge = new PaseoWorkspaceBridge(config, () => ({
    async connect() {
      calls.push("connect");
    },
    async close() {
      calls.push("close");
    },
    async fetchWorkspaces() {
      calls.push("list");
      return {
        entries: [{ id: "wks_existing", workspaceDirectory: await realpath(root) }],
        pageInfo: { hasMore: false },
      };
    },
    async createWorkspace() {
      calls.push("create");
      return { workspace: { id: "wks_new" } };
    },
    async archiveWorkspace() {
      calls.push("archive");
      return {};
    },
  }));

  assert.deepEqual(
    await bridge.registerWorkspace({ path: root, title: "DevSpace test" }),
    { workspaceId: "wks_existing", reused: true },
  );
  assert.deepEqual(calls, ["connect", "list", "close"]);
});

test("Paseo registration creates a directory-backed external workspace and archives by id", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-paseo-create-"));
  const calls: unknown[] = [];
  const bridge = new PaseoWorkspaceBridge(config, () => ({
    async connect() {},
    async close() {},
    async fetchWorkspaces() {
      return { entries: [], pageInfo: { hasMore: false } };
    },
    async createWorkspace(input) {
      calls.push(input);
      return { workspace: { id: "wks_new", workspaceDirectory: root }, error: null };
    },
    async archiveWorkspace(workspaceId) {
      calls.push(workspaceId);
      return { archivedAt: "2026-08-12T00:00:00.000Z", error: null };
    },
  }));

  assert.deepEqual(
    await bridge.registerWorkspace({ path: root, title: "DevSpace test" }),
    { workspaceId: "wks_new", reused: false },
  );
  assert.deepEqual(await bridge.archiveWorkspace("wks_new"), {
    workspaceId: "wks_new",
    archivedAt: "2026-08-12T00:00:00.000Z",
  });
  assert.deepEqual(calls, [
    {
      source: { kind: "directory", path: root },
      title: "DevSpace test",
    },
    "wks_new",
  ]);
});

test("Paseo registration surfaces API failures after closing the client", async () => {
  let closed = false;
  const bridge = new PaseoWorkspaceBridge(config, () => ({
    async connect() {},
    async close() {
      closed = true;
    },
    async fetchWorkspaces() {
      return { entries: [], pageInfo: { hasMore: false } };
    },
    async createWorkspace() {
      return { workspace: null, error: "registration rejected" };
    },
    async archiveWorkspace() {
      return {};
    },
  }));

  await assert.rejects(
    () => bridge.registerWorkspace({ path: process.cwd(), title: "DevSpace test" }),
    /registration rejected/,
  );
  assert.equal(closed, true);
});
