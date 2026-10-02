import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyHarnessModelPreset,
  resolveHarnessModelSlot,
  mergeHarnessSettings,
  parseHarnessAgent,
  resolvePresets,
  resolveResearchCapabilities,
} from "../src/index.js";

describe("Harness model slots", () => {
  it("disabled roles retain their configured model and cannot inherit the main model", () => {
    const main = { providerId: "p", modelId: "main" };
    const slots = { hardImplement: { ...main, enabled: false }, review: { enabled: false }, researchInvestigation: { ...main, enabled: false } };
    assert.equal(resolveHarnessModelSlot("hardImplement", slots, main), null);
    assert.equal(resolveHarnessModelSlot("review", slots, main), null);
    assert.deepEqual(resolvePresets(slots, main), []);
    assert.deepEqual(resolveResearchCapabilities(slots), []);
    assert.equal(slots.hardImplement.modelId, "main");
    assert.deepEqual(resolveHarnessModelSlot("hardImplement", { hardImplement: { ...slots.hardImplement, enabled: true } }, main), main);
  });

  it("custom agents are user-owned and resolve their tools, instructions and mode without a second executor", () => {
    const agent = parseHarnessAgent({ name: "Investigator", description: "Trace source facts", instructions: "Cite source lines.", enabled: true,
      tools: ["read", "grep"], worktree: "none", workFocus: ["research"] });
    const main = { providerId: "p", modelId: "main" };
    const settings = mergeHarnessSettings({ agents: { facts: agent } }, { agents: { facts: { ...agent, instructions: "untrusted override" } } });
    assert.equal(settings.agents.facts?.instructions, "Cite source lines.");
    assert.equal(resolvePresets({}, main, settings.agents, "code").some(profile => profile.id === "custom:facts"), false);
    const profile = resolvePresets({}, main, settings.agents, "research").find(profile => profile.id === "custom:facts")!;
    assert.deepEqual(profile.model, main);
    assert.deepEqual(profile.definition.tools, ["read", "grep"]);
    assert.equal(profile.definition.systemPromptFragment, agent.instructions);
    assert.equal(resolvePresets({}, main, { facts: { ...agent, enabled: false } }, "research").some(profile => profile.id === "custom:facts"), false);
    assert.throws(() => parseHarnessAgent({ ...agent, workFocus: ["invented"] }), /Invalid agent/);
    assert.throws(() => mergeHarnessSettings({ models: { review: { providerId: "p" } } }, {}), /Invalid binding/);
  });
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
