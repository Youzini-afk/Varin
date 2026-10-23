import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveHarnessModelSlot,
  mergeHarnessSettings,
  parseHarnessAgent,
  observePresets,
  type PresetId,
} from "../src/index.js";

const builtinTools = {
  worker: ["file_read"],
  verifier: ["file_read"],
  retrieval: ["file_read"],
} satisfies Record<PresetId, string[]>;

describe("Harness model slots", () => {
  it("disabled roles retain their configured model and cannot inherit the main model", () => {
    const main = { providerId: "p", modelId: "main" };
    const slots = { worker: { ...main, enabled: false }, researchInvestigation: { ...main, enabled: false } };
    assert.equal(resolveHarnessModelSlot("worker", slots, main), null);
    assert.equal(observePresets(slots, main, {}, undefined, 'agent', builtinTools).find(profile => profile.id === "worker")!.availability, "disabled");
    assert.equal(slots.worker.modelId, "main");
    assert.deepEqual(resolveHarnessModelSlot("worker", { worker: { ...slots.worker, enabled: true } }, main), main);
  });

  it("custom agents are user-owned and resolve their tools, instructions and mode without a second executor", () => {
    const agent = parseHarnessAgent({ name: "Investigator", description: "Trace source facts", instructions: "Cite source lines.", enabled: true,
      tools: ["read", "grep"], worktree: "none", workFocus: ["research"] });
    const main = { providerId: "p", modelId: "main" };
    const settings = mergeHarnessSettings({ agents: { facts: agent } }, { agents: { facts: { ...agent, instructions: "untrusted override" } } });
    assert.equal(settings.agents.facts?.instructions, "Cite source lines.");
    assert.equal(observePresets({}, main, settings.agents, "code", "agent", builtinTools).find(profile => profile.id === "custom:facts")!.availability, "scope_unavailable");
    const profile = observePresets({}, main, settings.agents, "research", "agent", builtinTools).find(profile => profile.id === "custom:facts")!;
    assert.deepEqual(profile.model, main);
    assert.equal(profile.modelSource, "inherit");
    const explicitlySame = observePresets({}, main, { facts: { ...agent, model: main } }, "research", "agent", builtinTools).find(profile => profile.id === "custom:facts")!;
    assert.equal(explicitlySame.modelSource, "selected");
    assert.equal(observePresets({ worker: { ...main } }, main, {}, undefined, 'agent', builtinTools).find(profile => profile.id === "worker")!.modelSource, "selected");
    assert.equal(observePresets({}, main, {}, undefined, 'agent', builtinTools).find(profile => profile.id === "worker")!.modelSource, "inherit");
    assert.deepEqual(profile.definition.tools, ["read", "grep"]);
    assert.equal(profile.definition.systemPromptFragment, agent.instructions);
    assert.equal(observePresets({}, main, { facts: { ...agent, enabled: false } }, "research", "agent", builtinTools).find(profile => profile.id === "custom:facts")!.availability, "disabled");
    assert.throws(() => parseHarnessAgent({ ...agent, workFocus: ["invented"] }), /Invalid agent/);
    assert.throws(() => mergeHarnessSettings({ models: { worker: { providerId: "p" } } }, {}), /Invalid binding/);
  });
  it("defaults workers to main and resolves configured auxiliary slots", () => {
    const main = { providerId: "openai", modelId: "gpt-main" };
    assert.deepEqual(resolveHarnessModelSlot("worker", {}, main), main);
    assert.equal(resolveHarnessModelSlot("reader", {}, main), null);
    assert.deepEqual(resolveHarnessModelSlot("reader", {
      reader: { providerId: "anthropic", modelId: "claude-haiku" },
    }, main), { providerId: "anthropic", modelId: "claude-haiku" });
  });


});

describe('Runtime tool selections', () => {
  it('keeps user arrays exact and resolves explicit runtime choices in one place', async () => {
    const { parseAgentToolSelection, resolveAgentTools, updateAgentToolSelection } = await import('../src/index.js');
    const original = ['read', 'plugin_tool'];
    assert.deepEqual(resolveAgentTools(original, 'agent'), { source: 'explicit', names: original });
    const edited = updateAgentToolSelection(['file_read']);
    assert.deepEqual(edited, ['file_read']);
    assert.equal(updateAgentToolSelection(null), undefined);
    assert.deepEqual(original, ['read', 'plugin_tool']);
    assert.deepEqual(resolveAgentTools([], 'agent'), { source: 'explicit', names: [] });
    assert.throws(() => parseAgentToolSelection({ future: ['read'] }), /array/);
    const settings = mergeHarnessSettings({ agents: { reader: { name: 'Reader', description: '', instructions: '', enabled: true,
      tools: ['file_read'], worktree: 'none', workFocus: [] } } }, {});
    const model = { providerId: 'provider', modelId: 'model' };
    const native = observePresets({}, model, settings.agents, undefined, 'agent', { ...builtinTools, worker: ['file_write'] });
    assert.deepEqual(native.find(p => p.id === 'worker')?.definition.tools, ['file_write']);
    assert.deepEqual(native.find(p => p.id === 'custom:reader')?.definition.tools, ['file_read']);
    const retrieval = native.find(p => p.id === 'retrieval');
    assert.equal(retrieval?.availability, 'available');
    assert.deepEqual(retrieval?.model, model);
    assert.equal(retrieval?.modelSource, 'inherit');
    assert.equal(observePresets({ retrievalAgent: { inherit: false } }, model, {}, undefined, 'agent', builtinTools)
      .find(p => p.id === 'retrieval')?.availability, 'unconfigured');
  });
});
