import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { adaptPiSdkSource } from "../src/pi-sdk-adaptation.js";

test("SDK adaptation is idempotent for the shipped SDK and rejects a changed required seam", () => {
  const directory = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const source = readFileSync(join(directory, "core/agent-session.js"), "utf8");
  assert.equal(adaptPiSdkSource("@earendil-works/pi-coding-agent", "dist/core/agent-session.js", source), source);
  assert.throws(() => adaptPiSdkSource("@earendil-works/pi-coding-agent", "dist/core/agent-session.js", "export class ChangedSession {}"), /required seam/);
  assert.equal(adaptPiSdkSource("@earendil-works/pi-ai", "dist/index.js", "unchanged"), "unchanged");
  const responses = readFileSync(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/api/openai-responses-shared")), "utf8");
  assert.equal(adaptPiSdkSource("@earendil-works/pi-ai", "dist/api/openai-responses-shared.js", responses), responses);
  assert.throws(() => adaptPiSdkSource("@earendil-works/pi-ai", "dist/api/openai-responses-shared.js", "changed parser"), /required seam/);
  const responsesProvider = readFileSync(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/api/openai-responses")), "utf8");
  assert.equal(adaptPiSdkSource("@earendil-works/pi-ai", "dist/api/openai-responses.js", responsesProvider), responsesProvider);
  assert.throws(() => adaptPiSdkSource("@earendil-works/pi-ai", "dist/api/openai-responses.js", "changed provider"), /required seam/);
  const coreDirectory = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-agent-core")));
  const core = readFileSync(join(coreDirectory, "agent.js"), "utf8");
  assert.equal(adaptPiSdkSource("@earendil-works/pi-agent-core", "dist/agent.js", core), core);
  assert.throws(() => adaptPiSdkSource("@earendil-works/pi-agent-core", "dist/agent.js", "export class ChangedAgent {}"), /required seam/);
});
