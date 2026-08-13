import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const DEFAULT_PROCESS_STREAM_TTL_MS = 60 * 60 * 1_000;

export interface ProcessStreamGrant {
  workspaceId: string;
  sessionId: number;
  expiresAt: string;
}

interface ProcessStreamTokenPayload {
  v: 1;
  workspaceId: string;
  sessionId: number;
  expiresAtMs: number;
}

interface ProcessStreamTokenServiceOptions {
  secret?: Buffer;
  ttlMs?: number;
  now?: () => number;
}

export class ProcessStreamTokenService {
  private readonly secret: Buffer;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: ProcessStreamTokenServiceOptions = {}) {
    this.secret = options.secret ?? randomBytes(32);
    this.ttlMs = options.ttlMs ?? DEFAULT_PROCESS_STREAM_TTL_MS;
    this.now = options.now ?? Date.now;

    if (this.secret.length < 32) {
      throw new Error("Process stream token secret must be at least 32 bytes.");
    }
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1) {
      throw new Error("Process stream token TTL must be a positive integer.");
    }
  }

  issue(workspaceId: string, sessionId: number): { token: string; grant: ProcessStreamGrant } {
    if (!workspaceId) throw new Error("Process stream workspace ID is required.");
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) {
      throw new Error("Process stream session ID must be a positive integer.");
    }

    const expiresAtMs = this.now() + this.ttlMs;
    const payload: ProcessStreamTokenPayload = {
      v: 1,
      workspaceId,
      sessionId,
      expiresAtMs,
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = this.sign(encodedPayload);

    return {
      token: `${encodedPayload}.${signature}`,
      grant: {
        workspaceId,
        sessionId,
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
    };
  }

  verify(token: string): ProcessStreamGrant | undefined {
    const [encodedPayload, encodedSignature, ...extra] = token.split(".");
    if (!encodedPayload || !encodedSignature || extra.length > 0) return undefined;

    let actualSignature: Buffer;
    let expectedSignature: Buffer;
    try {
      actualSignature = Buffer.from(encodedSignature, "base64url");
      expectedSignature = Buffer.from(this.sign(encodedPayload), "base64url");
    } catch {
      return undefined;
    }

    if (
      actualSignature.length !== expectedSignature.length
      || !timingSafeEqual(actualSignature, expectedSignature)
    ) {
      return undefined;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    } catch {
      return undefined;
    }

    if (!isProcessStreamTokenPayload(payload) || payload.expiresAtMs <= this.now()) {
      return undefined;
    }

    return {
      workspaceId: payload.workspaceId,
      sessionId: payload.sessionId,
      expiresAt: new Date(payload.expiresAtMs).toISOString(),
    };
  }

  private sign(encodedPayload: string): string {
    return createHmac("sha256", this.secret)
      .update(encodedPayload)
      .digest("base64url");
  }
}

function isProcessStreamTokenPayload(value: unknown): value is ProcessStreamTokenPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<ProcessStreamTokenPayload>;
  return payload.v === 1
    && typeof payload.workspaceId === "string"
    && payload.workspaceId.length > 0
    && Number.isSafeInteger(payload.sessionId)
    && Number(payload.sessionId) > 0
    && Number.isSafeInteger(payload.expiresAtMs)
    && Number(payload.expiresAtMs) > 0;
}
