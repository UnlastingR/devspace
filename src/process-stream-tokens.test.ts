import assert from "node:assert/strict";
import test from "node:test";
import { ProcessStreamTokenService } from "./process-stream-tokens.js";

test("process stream tokens are scoped, signed, and expire", () => {
  let now = Date.parse("2026-08-13T12:00:00.000Z");
  const tokens = new ProcessStreamTokenService({
    secret: Buffer.alloc(32, 7),
    ttlMs: 60_000,
    now: () => now,
  });

  const issued = tokens.issue("ws_example", 42);
  assert.deepEqual(tokens.verify(issued.token), {
    workspaceId: "ws_example",
    sessionId: 42,
    expiresAt: "2026-08-13T12:01:00.000Z",
  });
  assert.equal(issued.grant.expiresAt, "2026-08-13T12:01:00.000Z");

  const [payload, signature] = issued.token.split(".");
  assert.equal(tokens.verify(`${payload}x.${signature}`), undefined);
  assert.equal(tokens.verify(`${payload}.${signature}x`), undefined);

  now += 60_001;
  assert.equal(tokens.verify(issued.token), undefined);
});

test("process stream tokens reject invalid issuance inputs", () => {
  const tokens = new ProcessStreamTokenService({ secret: Buffer.alloc(32, 3) });
  assert.throws(() => tokens.issue("", 1), /workspace ID/);
  assert.throws(() => tokens.issue("ws_example", 0), /session ID/);
});
