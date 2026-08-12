import {
  createBashTool,
  createLocalBashOperations,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type BashToolInput,
  type BashOperations,
  type EditToolInput,
  type EditToolDetails,
  type FindToolInput,
  type GrepToolInput,
  type LsToolInput,
  type ReadToolInput,
  type WriteToolInput,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { constants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolveAllowedPath } from "./roots.js";

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResponse<TDetails = unknown> = {
  content: McpContent[];
  details?: TDetails;
  isError?: boolean;
};

interface ToolContext {
  cwd: string;
  root: string;
  readRoots?: string[];
}

export interface ShellToolInput extends BashToolInput {
  allowBackground?: boolean;
}

function toMcpContent(result: AgentToolResult<unknown>): McpContent[] {
  return result.content.map((content) => {
    if (content.type === "text") {
      return { type: "text", text: content.text };
    }

    return {
      type: "image",
      data: content.data,
      mimeType: content.mimeType,
    };
  });
}

function formatToolError(error: unknown): McpContent[] {
  const message = error instanceof Error ? error.message : String(error);
  return [{ type: "text", text: message }];
}

async function runTool<TInput, TDetails = unknown>(
  execute: (input: TInput) => Promise<AgentToolResult<TDetails>>,
  input: TInput,
  context: ToolContext,
): Promise<ToolResponse<TDetails>> {
  try {
    const result = await execute(input);
    return {
      content: toMcpContent(result),
      details: result.details,
    };
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
}

export async function readFileTool(input: ReadToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, context.readRoots ?? [context.root]);
  const tool = createReadTool(context.cwd);

  return runTool((params) => tool.execute("read_file", params), {
    path,
    offset: input.offset,
    limit: input.limit,
  }, context);
}

export async function writeFileTool(input: WriteToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createWriteTool(context.cwd);

  return runTool((params) => tool.execute("write_file", params), {
    path,
    content: input.content,
  }, context);
}

export async function editFileTool(input: EditToolInput, context: ToolContext): Promise<ToolResponse<EditToolDetails>> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createEditTool(context.cwd);

  return runTool((params) => tool.execute("edit_file", params), {
    path,
    edits: input.edits,
  }, context);
}

export async function grepFilesTool(input: GrepToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createGrepTool(context.cwd);

  return runTool((params) => tool.execute("grep_files", params), input, context);
}

export async function findFilesTool(input: FindToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createFindTool(context.cwd);

  return runTool((params) => tool.execute("find_files", params), input, context);
}

export async function listDirectoryTool(input: LsToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createLsTool(context.cwd);

  return runTool((params) => tool.execute("list_directory", params), input, context);
}

export async function runShellTool(input: ShellToolInput, context: ToolContext): Promise<ToolResponse> {
  const tool = createBashTool(context.cwd, {
    operations: input.allowBackground
      ? createLocalBashOperations()
      : createForegroundOnlyBashOperations(),
  });
  const timeout = input.timeout === undefined ? 30 : Math.min(input.timeout, 300);

  return runTool((params) => tool.execute("run_shell", params), {
    command: input.command,
    timeout,
  }, context);
}

function createForegroundOnlyBashOperations(): BashOperations {
  if (process.platform === "win32") {
    // Pi's Windows backend is still responsible for taskkill-based timeout and
    // abort handling. Windows has no portable process-group equivalent that can
    // clean descendants after their parent shell has already exited.
    return createLocalBashOperations();
  }

  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      try {
        await access(cwd, constants.F_OK);
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      }
      if (signal?.aborted) throw new Error("aborted");

      const shell = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
      const child = spawn(shell, ["-c", command], {
        cwd,
        detached: true,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const pid = child.pid;
      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let forceKillHandle: NodeJS.Timeout | undefined;
      let closeResolved = false;
      let resolveClose: (() => void) | undefined;
      const closed = new Promise<void>((resolve) => {
        resolveClose = resolve;
      });
      child.once("close", () => {
        closeResolved = true;
        resolveClose?.();
      });

      const stopProcessGroup = () => {
        if (!pid) return;
        signalProcessGroup(pid, "SIGTERM");
        forceKillHandle ??= setTimeout(() => signalProcessGroup(pid, "SIGKILL"), 250);
      };
      const onAbort = () => stopProcessGroup();

      try {
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            stopProcessGroup();
          }, timeout * 1_000);
        }

        const exitCode = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", resolve);
        });

        // The foreground shell is done. Terminate anything that kept running in
        // its detached process group, then give pipes a short chance to flush.
        if (pid) signalProcessGroup(pid, "SIGTERM");
        if (!closeResolved) {
          await Promise.race([closed, delay(250)]);
        }
        if (pid) signalProcessGroup(pid, "SIGKILL");

        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (forceKillHandle) clearTimeout(forceKillHandle);
        if (signal) signal.removeEventListener("abort", onAbort);
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
    },
  };
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group may already be gone. Cleanup is best-effort and must never
    // crash the server from a timeout or abort callback.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
