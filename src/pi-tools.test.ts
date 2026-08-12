import assert from "node:assert/strict";
import { runShellTool } from "./pi-tools.js";

if (process.platform !== "win32") {
  let backgroundPid: number | undefined;
  try {
    const response = await runShellTool(
      { command: "sleep 30 >/dev/null 2>&1 & echo $!" },
      { cwd: process.cwd(), root: process.cwd() },
    );
    assert.equal(response.isError, undefined);
    backgroundPid = Number(response.content.find((item) => item.type === "text")?.text.trim());
    assert.equal(Number.isInteger(backgroundPid), true);
    await waitForProcessExit(backgroundPid);
  } finally {
    if (backgroundPid !== undefined) killIfRunning(backgroundPid);
  }

  let allowedBackgroundPid: number | undefined;
  try {
    const response = await runShellTool(
      {
        command: "sleep 30 >/dev/null 2>&1 & echo $!",
        allowBackground: true,
      },
      { cwd: process.cwd(), root: process.cwd() },
    );
    assert.equal(response.isError, undefined);
    allowedBackgroundPid = Number(response.content.find((item) => item.type === "text")?.text.trim());
    assert.equal(Number.isInteger(allowedBackgroundPid), true);
    assert.equal(isProcessRunning(allowedBackgroundPid), true);
  } finally {
    if (allowedBackgroundPid !== undefined) killIfRunning(allowedBackgroundPid);
  }
}

async function waitForProcessExit(pid: number | undefined): Promise<void> {
  assert.ok(pid);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`background process ${pid} survived foreground-only shell cleanup`);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function killIfRunning(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
