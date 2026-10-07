import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { adaptPiSdkAsset, adaptPiSdkSource } from "../src/pi-sdk-adaptation.js";

test("SDK adaptation is idempotent for the shipped SDK and rejects a changed required seam", () => {
  const directory = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const source = readFileSync(join(directory, "core/agent-session.js"), "utf8");
  assert.equal(adaptPiSdkSource("@earendil-works/pi-coding-agent", "dist/core/agent-session.js", source), source);
  assert.throws(() => adaptPiSdkSource("@earendil-works/pi-coding-agent", "dist/core/agent-session.js", "export class ChangedSession {}"), /required seam/);
  assert.equal(adaptPiSdkSource("@earendil-works/pi-ai", "dist/index.js", "unchanged"), "unchanged");
  for (const file of ["core/system-prompt.js", "core/session-manager.js", "core/session-manager.d.ts", "core/compaction/compaction.d.ts", "core/tools/read.js", "core/tools/edit.js", "core/tools/write.js", "../docs/codemode.md"]) {
    const sourcePath = join(directory, file);
    const sdkPath = file.startsWith("../") ? file.slice(3) : `dist/${file}`;
    const original = readFileSync(sourcePath, "utf8");
    const adapted = adaptPiSdkSource("@earendil-works/pi-coding-agent", sdkPath, original);
    assert.equal(adaptPiSdkSource("@earendil-works/pi-coding-agent", sdkPath, adapted), adapted);
    assert.equal(readFileSync(sourcePath, "utf8"), original, "selected SDK files stay untouched");
    assert.throws(() => adaptPiSdkSource("@earendil-works/pi-coding-agent", sdkPath, "changed source"), /required seam/);
  }
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

test("reference adaptation preserves unrelated binary SDK assets", () => {
  const image = Buffer.from([0, 255, 128, 137, 80, 78, 71]);
  assert.equal(adaptPiSdkAsset("@earendil-works/pi-coding-agent", "docs/diagram.png", image), image);
});
