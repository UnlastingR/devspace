import assert from "node:assert/strict";
import { isJsonRpcCandidate } from "./post-message-transport.js";

assert.equal(isJsonRpcCandidate({ jsonrpc: "2.0", method: "ui/initialize" }), true);
assert.equal(isJsonRpcCandidate({ jsonrpc: "2.0", id: 1, result: {} }), true);

assert.equal(isJsonRpcCandidate({ type: "visibility", checkId: "abc", visible: true }), false);
assert.equal(isJsonRpcCandidate({ jsonrpc: "1.0", method: "ui/initialize" }), false);
assert.equal(isJsonRpcCandidate(null), false);
assert.equal(isJsonRpcCandidate("2.0"), false);

console.log("post-message-transport tests passed");
