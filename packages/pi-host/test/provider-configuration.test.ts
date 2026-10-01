import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderConfigInput } from "@varin/protocol";
import { ProviderConfigurationManager } from "../src/provider-configuration.js";

function config(
  id: string,
  modelId: string,
  baseUrl = "https://models.example.test/v1",
): ProviderConfigInput {
  return {
    api: "openai-completions",
    baseUrl,
    id,
    models: [
      {
        contextWindow: 32_768,
        id: modelId,
        input: ["text", "image"],
        maxTokens: 4_096,
        name: modelId,
        reasoning: true,
      },
    ],
    name: `Provider ${id}`,
  };
}

describe("ProviderConfigurationManager", () => {
  it("retains native typed models with shared IDs and publishes a project-free classifier catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-native-model-types-"));
    const agentDir = join(root, "agent"); const cwd = join(root, "workspace");
    await mkdir(agentDir); await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { mixed: {
      baseUrl: "https://user.example/v1", api: "openai-completions", models: [
        { id: "shared", type: "chat", contextWindow: 32000, maxTokens: 2048, compat: { supportsStore: false } },
        { id: "shared", type: "classifier", api: "typesafe-system-one", contextWindow: 12000 },
        { id: "shared", type: "image", api: "openai-images", output: ["image"] },
      ],
    } } }));
    await writeFile(join(cwd, ".pi", "models.json"), JSON.stringify({ providers: { mixed: {
      baseUrl: "https://project.example/v1", models: [{ id: "project-only", type: "classifier", api: "typesafe-system-one" }],
    } } }));
    const runtime = await ModelRuntime.create({ allowModelNetwork: false,
      authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
    const manager = new ProviderConfigurationManager({ agentDir });
    try {
      assert.equal(runtime.getModelOfType("classifier", "mixed", "shared")?.contextWindow, 12000);
      assert.equal(runtime.getModelOfType("image", "mixed", "shared")?.output[0], "image");
      await manager.apply(runtime, cwd, true);
      assert.ok(runtime.getModelOfType("classifier", "mixed", "project-only"));
      const details = await manager.getDetails(runtime, cwd, "mixed", true);
      assert.deepEqual(details.capabilities?.decision?.models?.map(model => model.id), ["shared"]);
      assert.ok((await manager.getDetails(runtime, cwd, "typesafe", true)).capabilities?.decision?.models?.length);
      const userConfig = (await manager.getDetails(runtime, cwd, "mixed", false)).config!;
      await manager.upsert(runtime, cwd, "user", { ...userConfig, capabilities: { chat: false } }, true);
      assert.equal(runtime.getModels("mixed").length, 0);
      assert.ok(runtime.getModelOfType("classifier", "mixed", "shared"));
      assert.ok(runtime.getModelOfType("image", "mixed", "shared"));
      const saved = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8"));
      assert.equal(saved.providers.mixed.models[0].compat.supportsStore, false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("keeps native model definitions when chat is disabled and resolves a higher-scope enable", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-capability-layers-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    const customPath = join(root, "operator", "models.json");
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const runtime = await ModelRuntime.create({ allowModelNetwork: false, authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
    const manager = new ProviderConfigurationManager({ agentDir, customConfigPath: customPath });
    try {
      await manager.upsert(runtime, cwd, "user", { ...config("mixed", "chat-model"), capabilities: { chat: false,
        decision: { protocol: "pi-classifier", models: [{ id: "jev-1.13" }] } } }, true);
      assert.equal(runtime.getModels("mixed").length, 0);
      const saved = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8"));
      assert.equal(saved.providers.mixed.models[0].id, "chat-model");
      await manager.upsert(runtime, cwd, "custom", { id: "mixed", capabilities: { chat: true } }, true);
      assert.equal(runtime.getModel("mixed", "chat-model")?.id, "chat-model");
      const effective = await manager.getDetails(runtime, cwd, "mixed", true);
      assert.equal(effective.capabilities?.decision?.models?.[0]?.id, "jev-1.13");
      await manager.delete(runtime, cwd, "mixed", "custom", true);
      assert.equal(runtime.getModels("mixed").length, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("writes native Pi models.json while preserving comments and configured keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-provider-config-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(agentDir, "models.json"),
      `{
  // Keep this operator note.
  "providers": {
    "local": {
      "name": "Old name",
      "baseUrl": "https://old.example.test/v1",
      "api": "openai-completions",
      "apiKey": "$VARIN_TEST_KEY",
      "models": []
    }
  }
}
`,
      { mode: 0o600 },
    );
    const runtime = await ModelRuntime.create({
      allowModelNetwork: false,
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const manager = new ProviderConfigurationManager({ agentDir });
    try {
      const details = await manager.upsert(runtime, cwd, "user", config("local", "local-model"), true);
      assert.equal(details.effectiveScope, "user");
      assert.equal(details.config?.models?.[0]?.id, "local-model");
      assert.equal(details.locations.user.exists, true);
      const content = await readFile(join(agentDir, "models.json"), "utf8");
      assert.match(content, /Keep this operator note/);
      assert.match(content, /\$VARIN_TEST_KEY/);
      assert.doesNotMatch(JSON.stringify(details), /VARIN_TEST_KEY/);
      assert.equal(runtime.getModel("local", "local-model")?.input.includes("image"), true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("layers project and explicit custom Pi configurations over the user catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-provider-layers-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    const customPath = join(root, "operator", "models.json");
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const runtime = await ModelRuntime.create({
      allowModelNetwork: false,
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const manager = new ProviderConfigurationManager({ agentDir, customConfigPath: customPath });
    try {
      await manager.upsert(runtime, cwd, "user", config("layered", "user-model"), true);
      await manager.upsert(runtime, cwd, "project", config("layered", "project-model"), true);
      const details = await manager.upsert(
        runtime,
        cwd,
        "custom",
        config("layered", "custom-model"),
        true,
      );
      assert.equal(details.effectiveScope, "custom");
      assert.deepEqual(
        runtime.getModels("layered").map((model) => model.id),
        ["user-model", "project-model", "custom-model"],
      );
      assert.equal(details.locations.project.exists, true);
      assert.equal(details.locations.custom.exists, true);

      const projectPath = join(cwd, ".pi", "models.json");
      const project = JSON.parse(await readFile(projectPath, "utf8"));
      const tier = { inputTokensAbove: 20_000, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2 };
      Object.assign(project.providers.layered.models[0], {
        promptCache: { short: 300, long: 3_600 }, samplingParams: { top_k: 40, temperature: 0.5 },
        inputLimits: { images: { resize: { maxWidth: 1_024, maxHeight: 768 } } },
        cost: { ...project.providers.layered.models[0].cost, tiers: [tier] },
      });
      project.providers.layered.modelOverrides = { "project-model": {
        promptCache: { short: 600 }, samplingParams: { temperature: 0.8 },
        inputLimits: { images: { resize: { maxWidth: 800 } } },
      } };
      await writeFile(projectPath, JSON.stringify(project));
      assert.deepEqual(await manager.apply(runtime, cwd, true), []);
      const native = runtime.getModel("layered", "project-model");
      assert.deepEqual(native?.promptCache, { short: 600, long: 3_600 });
      assert.deepEqual(native?.samplingParams, { top_k: 40, temperature: 0.8 });
      assert.deepEqual(native?.cost.tiers, [tier]);
      assert.equal(native?.inputLimits?.images?.resize?.maxWidth, 800);
      assert.equal(native?.inputLimits?.images?.resize?.maxHeight, 768);

      const afterCustomDelete = await manager.delete(runtime, cwd, "layered", "custom", true);
      assert.equal(afterCustomDelete.effectiveScope, "project");
      assert.deepEqual(
        runtime.getModels("layered").map((model) => model.id),
        ["user-model", "project-model"],
      );
      const afterAllDelete = await manager.delete(runtime, cwd, "layered", "all", true);
      assert.equal(afterAllDelete.effectiveScope, undefined);
      assert.equal(runtime.getProvider("layered"), undefined);

      await manager.upsert(runtime, cwd, "user", config("partial", "base-model"), true);
      const partial = await manager.upsert(runtime, cwd, "project", {
        baseUrl: "http://127.0.0.1:11434/v1",
        id: "partial",
      }, true);
      assert.equal(partial.effectiveScope, "project");
      assert.equal(partial.config?.api, undefined);
      assert.equal(partial.config?.models, undefined);
      assert.equal(runtime.getModel("partial", "base-model")?.baseUrl, "http://127.0.0.1:11434/v1");

      const longProviderId = `provider-${"x".repeat(512)}`;
      const longIdDetails = await manager.upsert(
        runtime,
        cwd,
        "project",
        config(longProviderId, "long-id-model"),
        true,
      );
      assert.equal(longIdDetails.providerId, longProviderId);

      const unrestrictedProviderId = "本地 provider/@experimental";
      const unrestrictedIdDetails = await manager.upsert(
        runtime,
        cwd,
        "project",
        config(unrestrictedProviderId, "unrestricted-id-model"),
        true,
      );
      assert.equal(unrestrictedIdDetails.providerId, unrestrictedProviderId);

      await assert.rejects(
        manager.upsert(runtime, cwd, "project", {
          id: "invalid-model-definition",
          models: [{ id: "missing-api-and-base-url" }],
        }, true),
        /does not define an API/,
      );
      assert.equal(
        (await manager.getDetails(runtime, cwd, "invalid-model-definition", true)).locations.project.exists,
        false,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("replaces editable fields without deleting native credentials or unknown keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-provider-replace-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(join(agentDir, "models.json"), `{
  // Keep the native document and fields Varin does not own.
  "providers": {
    "editable": {
      "name": "Remove me",
      "baseUrl": "https://remove.example.test/v1",
      "api": "openai-completions",
      "authHeader": true,
      "apiKey": "$EDITABLE_PROVIDER_KEY",
      "futureSetting": { "keep": true },
      "models": [{
        "id": "editable-model",
        "api": "openai-completions",
        "baseUrl": "https://model.example.test/v1"
      }]
    }
  }
}\n`);
    const runtime = await ModelRuntime.create({
      allowModelNetwork: false,
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const manager = new ProviderConfigurationManager({ agentDir });
    try {
      await manager.upsert(runtime, cwd, "user", {
        api: "openai-completions",
        id: "editable",
        models: [{
          api: "openai-completions",
          baseUrl: "https://model.example.test/v1",
          id: "editable-model",
        }],
      }, true);

      const content = await readFile(join(agentDir, "models.json"), "utf8");
      assert.match(content, /Keep the native document/);
      assert.match(content, /\$EDITABLE_PROVIDER_KEY/);
      assert.match(content, /futureSetting/);
      assert.doesNotMatch(content, /Remove me/);
      assert.doesNotMatch(content, /remove\.example\.test/);
      assert.doesNotMatch(content, /authHeader/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not read or mutate project providers until the project is trusted", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-provider-trust-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "models.json"), JSON.stringify({
      providers: {
        "project-only": {
          api: "openai-completions",
          baseUrl: "https://project.example.test/v1",
          models: [{ id: "project-model" }],
        },
      },
    }));
    const runtime = await ModelRuntime.create({
      allowModelNetwork: false,
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const manager = new ProviderConfigurationManager({ agentDir });
    try {
      await manager.apply(runtime, cwd, false);
      assert.equal(runtime.getProvider("project-only"), undefined);
      const hiddenDetails = await manager.getDetails(runtime, cwd, "project-only", false);
      assert.equal(hiddenDetails.locations.project.available, false);
      assert.equal(hiddenDetails.locations.project.exists, false);
      await assert.rejects(
        manager.upsert(runtime, cwd, "project", config("blocked", "blocked-model"), false),
        /Project is not trusted/,
      );

      await manager.apply(runtime, cwd, true);
      assert.ok(runtime.getProvider("project-only"));
      const trustedDetails = await manager.getDetails(runtime, cwd, "project-only", true);
      assert.equal(trustedDetails.locations.project.available, true);
      assert.equal(trustedDetails.locations.project.exists, true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
