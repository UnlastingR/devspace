import assert from "node:assert/strict";
import { getProviderLogo } from "./icons.js";

const codexLogo = getProviderLogo("codex");
assert.ok(codexLogo);
assert.equal(codexLogo.light, codexLogo.dark);
assert.equal(codexLogo.invertInLight, true);
assert.match(codexLogo.light, /openai-dark/);

const copilotLogo = getProviderLogo("copilot");
assert.ok(copilotLogo);
assert.equal(copilotLogo.light, copilotLogo.dark);
assert.equal(copilotLogo.invertInLight, true);
assert.match(copilotLogo.light, /copilot-dark/);

const cursorLogo = getProviderLogo("cursor");
assert.ok(cursorLogo);
assert.notEqual(cursorLogo.light, cursorLogo.dark);
assert.match(cursorLogo.light, /cursor-light/);
assert.match(cursorLogo.dark, /cursor-dark/);

const piLogo = getProviderLogo("pi");
assert.ok(piLogo);
assert.equal(piLogo.light, piLogo.dark);
assert.equal(piLogo.invertInLight, true);
assert.match(piLogo.light, /pi-on-dark/);

assert.deepEqual(getProviderLogo("  CoDeX  "), codexLogo);
assert.equal(getProviderLogo("unknown"), undefined);
