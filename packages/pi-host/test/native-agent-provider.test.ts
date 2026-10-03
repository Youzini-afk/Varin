import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { SessionHost } from "../src/session-host.js";

test("native agents use revisioned user settings, preserve models on disable, and require no plugin", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-native-agents-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ harness: {
    models: { quickImplement: { providerId: "test", modelId: "small" } }, nextStep: { enabled: true },
  } }));
  const host = new SessionHost({ agentDir, projectTrustOverride: true, emit: () => {} });
  try {
    await host.openCatalogContext(root);
    const catalog = await host.listAgentProviders();
    assert.ok(catalog.providers.some(provider => provider.id === "varin"));
    assert.ok(!catalog.agents.some(agent => agent.definition?.config.slot === "explore" || agent.definition?.config.slot === "memoryOrganizer"));
    const quick = catalog.agents.find(agent => agent.id === "varin:builtin:quickImplement")!;
    const override = { name: "Patch specialist", description: "Small exact patches", instructions: "Read first, change only the requested lines.",
      tools: ["read", "apply_patch"], worktree: "none", modelSettings: { temperature: 0.35, thinkingLevel: "low" } };
    await host.runAgentProviderAction("varin", "update", quick.id, { expectedRevision: quick.definition!.revision!, config: {
      providerId: "test", modelId: "small", agent: override,
    } });
    const customized = (await host.listAgentProviders()).agents.find(agent => agent.id === quick.id)!;
    assert.equal(customized.name, "Patch specialist");
    assert.equal(customized.description, "Small exact patches");
    assert.equal(customized.definition!.config.instructions, override.instructions);
    assert.deepEqual(customized.definition!.config.tools, override.tools);
    assert.deepEqual(customized.definition!.config.modelSettings, override.modelSettings);
    await host.runAgentProviderAction("varin", "disable", quick.id, { expectedRevision: customized.definition!.revision! });
    const disabled = (await host.listAgentProviders()).agents.find(agent => agent.id === quick.id)!;
    assert.equal(disabled.status, "disabled");
    assert.equal(disabled.model, "test/small");
    await assert.rejects(host.runAgentProviderAction("varin", "enable", quick.id, { expectedRevision: quick.definition!.revision! }), { code: "config_conflict" });

    const config = { name: "Source researcher", description: "Find exact evidence", instructions: "Read sources and report the relevant lines.",
      enabled: true, tools: ["read", "grep"], worktree: "none", workFocus: ["research"], model: { providerId: "test", modelId: "research" } };
    const created = await host.runAgentProviderAction("varin", "create-agent", undefined, { expectedRevision: disabled.definition!.revision!, config });
    assert.equal(created.success, true);
    const custom = (await host.listAgentProviders()).agents.find(agent => agent.id === created.agentId)!;
    assert.deepEqual(custom.workFocus, ["research"]);
    assert.deepEqual(custom.definition!.config.agent, config);
    assert.equal((created.data as { preset: string }).preset, custom.definition!.config.preset);
    await assert.rejects(host.runAgentProviderAction("varin", "update", custom.id, { expectedRevision: custom.definition!.revision!, scope: "project", config }), { code: "invalid_params" });
    await host.runAgentProviderAction("varin", "update", custom.id, { expectedRevision: custom.definition!.revision!, config: { ...config, name: "Fact reader" } });
    const edited = (await host.listAgentProviders()).agents.find(agent => agent.id === custom.id)!;
    assert.equal(edited.name, "Fact reader");
    const document = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
    assert.deepEqual(document.harness.models.quickImplement, { enabled: false, providerId: "test", modelId: "small", agent: override });
    assert.equal(document.harness.nextStep.enabled, true);
    await host.runAgentProviderAction("varin", "delete", edited.id, { expectedRevision: edited.definition!.revision! });
    assert.ok(!(await host.listAgentProviders()).agents.some(agent => agent.id === edited.id));
  } finally {
    await host.dispose();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});
