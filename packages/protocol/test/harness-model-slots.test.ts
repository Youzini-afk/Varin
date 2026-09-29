import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyHarnessModelPreset,
  resolveHarnessModelSlot,
} from "../src/index.js";

describe("Harness model slots", () => {
  it("defaults implementation/review to main and resolves configured auxiliary slots", () => {
    const main = { providerId: "openai", modelId: "gpt-main" };
    assert.deepEqual(resolveHarnessModelSlot("hardImplement", {}, main), main);
    assert.deepEqual(resolveHarnessModelSlot("review", {}, main), main);
    assert.equal(resolveHarnessModelSlot("reader", {}, main), null);
    assert.deepEqual(resolveHarnessModelSlot("reader", {
      reader: { providerId: "anthropic", modelId: "claude-haiku" },
    }, main), { providerId: "anthropic", modelId: "claude-haiku" });
  });

  it("fills auxiliary slots from an available provider family without overwriting main-default slots", () => {
    const anthropic = applyHarnessModelPreset("anthropic", {
      providerId: "anthropic",
      modelIds: ["claude-sonnet", "claude-3-5-haiku"],
    });
    assert.equal(anthropic.reader?.modelId, "claude-3-5-haiku");
    assert.equal(anthropic.frontend?.modelId, "claude-3-5-haiku");
    assert.equal(anthropic.memoryOrganizer?.modelId, "claude-3-5-haiku");
    assert.equal(anthropic.nextStep, undefined, "a model preset must not enable next-step suggestions");
    assert.equal(anthropic.hardImplement, undefined);
    assert.equal(anthropic.review, undefined);

    const openai = applyHarnessModelPreset("openai", {
      providerId: "openai",
      modelIds: ["gpt-5", "gpt-5-mini", "gpt-5-nano"],
    });
    assert.equal(openai.explore?.modelId, "gpt-5-nano");
    assert.deepEqual(applyHarnessModelPreset("gemini", {
      providerId: "google",
      modelIds: ["gemini-pro"],
    }), {});
  });
});
