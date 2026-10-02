import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PROVIDER_INFERENCE_PROTOCOLS, type ProviderInferenceCapability } from "@varin/protocol";
import { ProviderConfigurationManager } from "../src/provider-configuration.js";
import { discoverProviderModels } from "../src/provider-model-discovery.js";

describe("provider model discovery", () => {
  it("discovers each inference capability using its connection and credential owner before saving", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-inference-discovery-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    await mkdir(agentDir);
    await mkdir(cwd);
    const requests: Array<{ url: string; authorization: string | undefined }> = [];
    const server = createServer((request, response) => {
      requests.push({ url: request.url!, authorization: request.headers.authorization });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.url === "/decision/v1/models"
        ? { models: [{ name: "jev-latest", description: "General-purpose system one model.", release_date: "2026-09-15" }] }
        : { data: [{ id: "models/shared", name: "Shared" }, { id: "chat-model" }, { id: "models/shared" }] }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const runtime = await ModelRuntime.create({ allowModelNetwork: false,
      authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
    const configuration = new ProviderConfigurationManager({ agentDir });
    try {
      await configuration.upsert(runtime, cwd, "user", {
        id: "credential-owner", api: "openai-completions", baseUrl, models: [],
      }, true);
      await runtime.setRuntimeApiKey("credential-owner", "owner-key");
      for (const capability of ["embedding", "rerank", "decision"] as ProviderInferenceCapability[]) {
        const result = await discoverProviderModels({
          capability, runtime, configuration, cwd, projectTrusted: true, providerId: "draft-provider",
          apiKey: "wrong-provider-key",
          config: { id: "draft-provider", api: "anthropic-messages", baseUrl: `${baseUrl}/chat`,
            capabilities: { chat: false, [capability]: {
              protocol: PROVIDER_INFERENCE_PROTOCOLS[capability],
              baseUrl: `${baseUrl}/${capability}/v1`, endpoint: "/only-for-inference", credentialRef: "credential-owner",
            } } },
        });
        assert.deepEqual(requests.at(-1), { url: `/${capability}/v1/models`, authorization: "Bearer owner-key" });
        assert.equal(result.baseUrl, `${baseUrl}/${capability}/v1`);
        assert.deepEqual(result.models, capability === "decision"
          ? [{ id: "jev-latest", name: "jev-latest", type: "classifier", api: "typesafe-system-one" }]
          : [{ id: "models/shared", name: "Shared" }, { id: "chat-model", name: "chat-model" }]);
      }
      await discoverProviderModels({ capability: "embedding", runtime, configuration, cwd,
        projectTrusted: true, providerId: "draft-provider", apiKey: "draft-key",
        config: { id: "draft-provider", baseUrl: `${baseUrl}/inherited`, capabilities: { chat: false,
          embedding: { protocol: "openai-compatible" } } },
      });
      assert.deepEqual(requests.at(-1), { url: "/inherited/models", authorization: "Bearer draft-key" });
      assert.equal(runtime.getProviderAuthStatus("draft-provider").configured, false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps saved inference discovery free of project addresses and auth headers, and reports provider failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-inference-discovery-scopes-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    await mkdir(agentDir);
    await mkdir(join(cwd, ".pi"), { recursive: true });
    let status = 200;
    let payload: unknown = { data: [{ id: "embedding-model" }] };
    const server = createServer((request, response) => {
      assert.equal(request.url, "/v1/models");
      assert.equal(request.headers.authorization, "Bearer user-key");
      assert.equal(request.headers["x-discovery-scope"], "user");
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { local: {
      api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [],
      apiKey: "user-key", headers: { "x-discovery-scope": "user" },
      capabilities: { embedding: { protocol: "openai-compatible" } },
    } } }));
    await writeFile(join(cwd, ".pi", "models.json"), JSON.stringify({ providers: { local: {
      apiKey: "project-key", baseUrl: "http://invalid.local/project", headers: { "x-discovery-scope": "project" },
      capabilities: { embedding: { protocol: "openai-compatible", baseUrl: "http://invalid.local/embedding" } },
    } } }));
    const runtime = await ModelRuntime.create({ allowModelNetwork: false,
      authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
    const configuration = new ProviderConfigurationManager({ agentDir });
    try {
      await configuration.apply(runtime, cwd, true);
      const discover = () => discoverProviderModels({ capability: "embedding", runtime, configuration, cwd,
        projectTrusted: true, providerId: "local" });
      assert.equal((await discover()).models[0]?.id, "embedding-model");
      status = 404;
      payload = { error: { message: "No model list for Bearer user-key" } };
      await assert.rejects(discover(), { code: "provider_discovery_failed", message: "No model list for [redacted]" });
      status = 200;
      payload = { unrelated: [] };
      await assert.rejects(discover(), { code: "provider_discovery_invalid_response" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(root, { force: true, recursive: true });
    }
  });

  it("supports authenticated HTTP providers on localhost without a special opt-in", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-provider-discovery-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    let authorization = "";
    let requestedUrl = "";
    const server = createServer((request, response) => {
      authorization = request.headers.authorization ?? "";
      requestedUrl = request.url ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: [
            {
              capabilities: { reasoning: true },
              context_window: 65_536,
              id: "discovered-model",
              input_modalities: ["text", "image"],
              max_output_tokens: 8_192,
              name: "Discovered model",
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const runtime = await ModelRuntime.create({
      allowModelNetwork: false,
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const manager = new ProviderConfigurationManager({ agentDir });
    try {
      await manager.upsert(runtime, cwd, "user", {
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        id: "discovery-test",
        models: [],
        name: "Discovery test",
      }, true);
      await runtime.setRuntimeApiKey("discovery-test", "secret-test-key");
      const result = await discoverProviderModels({
        configuration: manager,
        cwd,
        providerId: "discovery-test",
        projectTrusted: true,
        runtime,
      });
      assert.equal(requestedUrl, "/v1/models");
      assert.equal(authorization, "Bearer secret-test-key");
      assert.deepEqual(result.models, [
        {
          contextWindow: 65_536,
          id: "discovered-model",
          input: ["text", "image"],
          maxTokens: 8_192,
          name: "Discovered model",
          reasoning: true,
        },
      ]);
    } finally {
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
      await rm(root, { force: true, recursive: true });
    }
  });

  it("discovers models from anonymous HTTP endpoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-provider-anonymous-discovery-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const authorizations: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      authorizations.push(request.headers.authorization);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "anonymous-model" }] }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const runtime = await ModelRuntime.create({
      allowModelNetwork: false,
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const manager = new ProviderConfigurationManager({ agentDir });
    try {
      const result = await discoverProviderModels({
        config: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          id: "anonymous-discovery",
          models: [],
        },
        configuration: manager,
        cwd,
        providerId: "anonymous-discovery",
        projectTrusted: true,
        runtime,
      });
      assert.equal(authorizations[0], undefined);
      assert.equal(result.models[0]?.id, "anonymous-model");
      await discoverProviderModels({
        apiKey: "one-shot-draft-key",
        config: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          id: "anonymous-discovery",
          models: [],
        },
        configuration: manager,
        cwd,
        providerId: "anonymous-discovery",
        projectTrusted: true,
        runtime,
      });
      assert.equal(authorizations[1], "Bearer one-shot-draft-key");
      assert.equal(runtime.getProviderAuthStatus("anonymous-discovery").configured, false);
    } finally {
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
      await rm(root, { force: true, recursive: true });
    }
  });
});
