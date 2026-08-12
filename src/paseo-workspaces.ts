import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { DaemonClient } from "@getpaseo/client";
import type { PaseoIntegrationConfig } from "./config.js";

const WORKSPACE_PAGE_SIZE = 100;

interface PaseoWorkspaceDescriptor {
  id: string;
  workspaceDirectory?: string;
}

interface PaseoApiClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  fetchWorkspaces(options: {
    page: { limit: number; cursor?: string };
  }): Promise<{
    entries: PaseoWorkspaceDescriptor[];
    pageInfo: { hasMore: boolean; nextCursor?: string | null };
  }>;
  createWorkspace(input: {
    source: { kind: "directory"; path: string };
    title?: string;
  }): Promise<{
    workspace: PaseoWorkspaceDescriptor | null;
    error?: string | null;
  }>;
  archiveWorkspace(workspaceId: string): Promise<{
    archivedAt?: string | null;
    error?: string | null;
  }>;
}

type PaseoClientFactory = (config: PaseoIntegrationConfig) => PaseoApiClient;

export interface PaseoWorkspaceRegistration {
  workspaceId: string;
  reused: boolean;
}

export interface PaseoWorkspaceArchive {
  workspaceId: string;
  archivedAt?: string;
}

export interface PaseoWorkspaceIntegration {
  registerWorkspace(input: {
    path: string;
    title: string;
  }): Promise<PaseoWorkspaceRegistration>;
  archiveWorkspace(workspaceId: string): Promise<PaseoWorkspaceArchive>;
}

export class PaseoWorkspaceBridge implements PaseoWorkspaceIntegration {
  constructor(
    private readonly config: PaseoIntegrationConfig,
    private readonly createClient: PaseoClientFactory = createApiClient,
  ) {}

  async registerWorkspace(input: {
    path: string;
    title: string;
  }): Promise<PaseoWorkspaceRegistration> {
    return this.withClient(async (client) => {
      const existing = await findWorkspaceByPath(client, input.path);
      if (existing) {
        return { workspaceId: existing.id, reused: true };
      }

      const result = await client.createWorkspace({
        source: { kind: "directory", path: input.path },
        title: input.title,
      });
      if (!result.workspace) {
        throw new Error(result.error || "Paseo did not return a workspace.");
      }

      return { workspaceId: result.workspace.id, reused: false };
    });
  }

  async archiveWorkspace(workspaceId: string): Promise<PaseoWorkspaceArchive> {
    return this.withClient(async (client) => {
      const result = await client.archiveWorkspace(workspaceId);
      if (result.error) throw new Error(result.error);

      return {
        workspaceId,
        ...(result.archivedAt ? { archivedAt: result.archivedAt } : {}),
      };
    });
  }

  private async withClient<T>(operation: (client: PaseoApiClient) => Promise<T>): Promise<T> {
    const client = this.createClient(this.config);
    try {
      await withTimeout(client.connect(), this.config.timeoutMs, "connect to Paseo");
      return await withTimeout(operation(client), this.config.timeoutMs, "call Paseo workspace API");
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

async function findWorkspaceByPath(
  client: PaseoApiClient,
  path: string,
): Promise<PaseoWorkspaceDescriptor | undefined> {
  const target = await canonicalPath(path);
  let cursor: string | undefined;

  do {
    const result = await client.fetchWorkspaces({
      page: {
        limit: WORKSPACE_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      },
    });
    for (const workspace of result.entries) {
      if (!workspace.workspaceDirectory) continue;
      if ((await canonicalPath(workspace.workspaceDirectory)) === target) return workspace;
    }

    cursor = result.pageInfo.hasMore
      ? result.pageInfo.nextCursor ?? undefined
      : undefined;
  } while (cursor);

  return undefined;
}

async function canonicalPath(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

function createApiClient(config: PaseoIntegrationConfig): PaseoApiClient {
  return new DaemonClient({
    url: config.url,
    clientId: `devspace-${randomUUID()}`,
    clientType: "mcp",
    password: config.password,
    connectTimeoutMs: config.timeoutMs,
    reconnect: { enabled: false },
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, action: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms while trying to ${action}.`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
