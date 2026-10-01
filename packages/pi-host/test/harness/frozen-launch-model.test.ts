import { fauxProvider } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { SessionHost } from "../../src/session-host.js";

const registerModels = (services: AgentSessionServices, models: Model<string>[], faux: ReturnType<typeof fauxProvider>) => {
  const first = models[0]!;
  services.modelRuntime.registerProvider(first.provider, {
    streamSimple: faux.provider.streamSimple,
    api: first.api,
    baseUrl: first.baseUrl,
    models: models.map((model) => ({
      api: model.api,
      baseUrl: model.baseUrl,
      contextWindow: model.contextWindow,
      cost: model.cost,
      id: model.id,
      input: [...model.input],
      maxTokens: model.maxTokens,
      name: model.name,
      reasoning: model.reasoning,
    })),
  });
};

/**
 * The frozen launch selection is the Run's actual model authority (7B/D-300):
 * it must reach the created session rather than silently resolve the session
 * default or the prior session file's model.
 */
describe("frozen launch model", () => {
  it("creates the session on the caller-selected model, not the configured default", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-frozen-model-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    await Promise.all([mkdir(agentDir), mkdir(cwd)]);
    const faux = fauxProvider({ models: [{ id: "faux-default" }, { id: "faux-upgrade" }] });
    const defaultModel = faux.getModel("faux-default")!;
    const upgradeModel = faux.getModel("faux-upgrade")!;
    const host = new SessionHost({
      agentDir,
      configureServices: async (services) => {
        registerModels(services, [defaultModel, upgradeModel], faux);
        await services.modelRuntime.setRuntimeApiKey(defaultModel.provider, "faux-key");
        return { model: defaultModel };
      },
      emit: () => {},
      projectTrustOverride: true,
    });
    try {
      await host.create(cwd, "Frozen", undefined, undefined, {
        providerId: upgradeModel.provider,
        modelId: upgradeModel.id,
      });
      assert.equal(host.snapshot().model?.id, "faux-upgrade");
    } finally {
      await host.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reopens a retained session on the new frozen model and records the switch", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-frozen-reopen-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    await Promise.all([mkdir(agentDir), mkdir(cwd)]);
    const faux = fauxProvider({ models: [{ id: "faux-first" }, { id: "faux-second" }] });
    const first = faux.getModel("faux-first")!;
    const second = faux.getModel("faux-second")!;
    const host = new SessionHost({
      agentDir,
      configureServices: async (services) => {
        registerModels(services, [first, second], faux);
        await services.modelRuntime.setRuntimeApiKey(first.provider, "faux-key");
        return { model: first };
      },
      emit: () => {},
      projectTrustOverride: true,
    });
    try {
      const created = await host.create(cwd, "Origin", undefined, undefined, {
        providerId: first.provider,
        modelId: first.id,
      });
      // Give the session durable content so the reopen has a restored model.
      host.session.sessionManager.appendMessage({ role: "user", content: "earlier turn", timestamp: 1 });
      const sessionFile = created.sessionFile!;
      await host.open({
        cwd,
        sessionFile,
        model: { providerId: second.provider, modelId: second.id },
      });
      assert.equal(host.snapshot().model?.id, "faux-second");
      const changes = host.session.sessionManager.getBranch()
        .filter((entry) => entry.type === "model_change");
      assert.ok(
        changes.some((entry) => entry.type === "model_change" && entry.modelId === "faux-second"),
        "the continuation model switch is recorded on the session transcript",
      );
    } finally {
      await host.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });
});
