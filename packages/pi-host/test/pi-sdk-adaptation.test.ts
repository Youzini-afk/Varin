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
});
