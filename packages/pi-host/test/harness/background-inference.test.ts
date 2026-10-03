import { fauxProvider } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ProviderConfigurationManager } from "../../src/provider-configuration.js";
import {
  createBackgroundInferenceRuntime,
  REMOTE_EMBEDDING_DEFAULT_MAX_TOKENS,
  type BackgroundInferenceRuntime,
} from "../../src/harness/background-inference.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

const jsonResponse = (body: unknown) => (
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
);

const authorizationFromInit = (init: RequestInit | undefined): string | null => {
  const headers = init?.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get("Authorization");
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === "authorization");
    return found?.[1] ?? null;
  }
  return headers.Authorization ?? headers.authorization ?? null;
};

async function setupBinding(options?: { modelId?: string; key?: string }) {
  const root = await mkdtemp(join(tmpdir(), "varin-bg-inference-"));
  dirs.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    harness: {
      embedding: {
        protocol: "openai-compatible",
        providerId: "embed-provider",
        modelId: options?.modelId ?? "embed-1",
        dimensions: 2,
      },
      rerank: {
        protocol: "http-rerank",
        providerId: "embed-provider",
        modelId: "rerank-1",
      },
    },
  }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "embed-provider": {
        name: "Embed",
        baseUrl: "https://models.example/v1",
        api: "openai-completions",
        models: [],
      },
    },
  }));
  const runtime = await ModelRuntime.create({
    allowModelNetwork: true,
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const key = options?.key ?? "key-one";
  await runtime.setRuntimeApiKey("embed-provider", key);
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({
    "embed-provider": { type: "api_key", key },
  }));
  return { agentDir, cwd, runtime };
}

async function boundEmbed(
  inference: BackgroundInferenceRuntime,
  input: Omit<import("@varin/protocol").HarnessEmbedParams, "configurationId" | "maxTokens">,
) {
  const described = await inference.describe();
  assert.equal(described.embedding.status, "ready");
  if (described.embedding.status !== "ready") throw new Error("embedding binding unavailable");
  return {
    ...input,
    configurationId: described.embedding.binding.configurationId,
    ...(described.embedding.binding.dimensions === undefined
      ? {}
      : { dimensions: described.embedding.binding.dimensions }),
    maxTokens: described.embedding.binding.maxTokens ?? REMOTE_EMBEDDING_DEFAULT_MAX_TOKENS,
  };
}

describe("BackgroundInferenceRuntime", () => {
  it('retains the embedding space across restarts, capability declarations, chat changes and equivalent endpoint forms', async () => {
    const { agentDir, cwd, runtime } = await setupBinding();
    const manager = new ProviderConfigurationManager({ agentDir });
    let inference = createBackgroundInferenceRuntime({ agentDir, cwd, modelRuntime: runtime,
      fetchImpl: async () => jsonResponse({ data: [{ index: 0, embedding: [1, 0] }] }) });
    const identify = async (batchId: string) => (await inference.embed(await boundEmbed(inference, {
      purpose: 'document', protocol: 'openai-compatible', providerId: 'embed-provider', modelId: 'embed-1',
      batchId, items: [{ id: 'one', text: 'stable input' }],
    }))).space.spaceId;
    try {
      const initial = await identify('initial');
      const configure = async (baseUrl: string, endpoint?: string) => manager.upsert(runtime, cwd, 'user', {
        id: 'embed-provider', baseUrl: 'https://unrelated-chat.example', api: 'anthropic-messages', models: [],
        capabilities: { embedding: { protocol: 'openai-compatible', baseUrl,
          ...(endpoint ? { endpoint } : {}), credentialRef: 'embed-provider', models: [{ id: 'embed-1' }] } },
      }, false);
      await configure('https://models.example/v1', '/embeddings');
      assert.equal(await identify('explicit-capability'), initial);
      await configure('https://models.example/v1/embeddings');
      assert.equal(await identify('full-url'), initial);
      inference.dispose();
      inference = createBackgroundInferenceRuntime({ agentDir, cwd, modelRuntime: runtime,
        fetchImpl: async () => jsonResponse({ data: [{ index: 0, embedding: [1, 0] }] }) });
      assert.equal(await identify('restarted'), initial);
      await configure('https://models.example/v1', '/encode');
      const customEndpoint = await identify('custom-endpoint');
      await configure('https://models.example', '/v1/encode');
      assert.equal(await identify('equivalent-custom-endpoint'), customEndpoint);
      await configure('https://models.example/v1/encode');
      assert.notEqual(await identify('different-wire-endpoint'), customEndpoint);
      await configure('https://different.example/v1');
      assert.notEqual(await identify('different-destination'), initial);
    } finally { inference.dispose(); }
  });

  it("runs independent inference capabilities without registering a chat model and retains owner-scoped credentials", async () => {
    const { agentDir, cwd, runtime } = await setupBinding();
    const manager = new ProviderConfigurationManager({ agentDir });
    await manager.upsert(runtime, cwd, "user", {
      id: "credential-owner", baseUrl: "https://credentials.example", models: [],
    }, false);
    await runtime.setRuntimeApiKey("credential-owner", "rerank-key");
    await writeFile(join(agentDir, "auth.json"), JSON.stringify({
      "embed-provider": { type: "api_key", key: "key-one" },
      "credential-owner": { type: "api_key", key: "rerank-key" },
    }));
    await manager.upsert(runtime, cwd, "user", {
      id: "embed-provider", baseUrl: "https://shared.example", models: [],
      capabilities: {
        chat: false,
        embedding: { protocol: "openai-compatible", baseUrl: "https://vectors.example", endpoint: "/encode", models: [{ id: "embed-1" }] },
        rerank: { protocol: "http-rerank", baseUrl: "https://rank.example", endpoint: "/score", credentialRef: "credential-owner", models: [{ id: "rerank-1" }] },
        decision: { protocol: "pi-classifier", baseUrl: "https://decision.example/v2", models: [{ id: "jev-1.13" }] },
      },
    }, false);
    assert.equal(runtime.getModels("embed-provider").length, 0);
    assert.ok(runtime.getProvider("embed-provider"));
    const details = await manager.getDetails(runtime, cwd, "embed-provider", false);
    assert.equal(details.capabilities?.decision?.models?.[0]?.id, "jev-1.13");
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ harness: {
      embedding: { protocol: "openai-compatible", providerId: "embed-provider", modelId: "embed-1", dimensions: 2 },
      rerank: { protocol: "http-rerank", providerId: "embed-provider", modelId: "rerank-1" },
      fastDecision: { default: { protocol: "pi-classifier", providerId: "embed-provider", modelId: "jev-1.13" } },
    } }));
    // A trusted project cannot replace a user-owned inference endpoint or credential reference.
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "models.json"), JSON.stringify({ providers: {
      "embed-provider": { baseUrl: "https://project.invalid", capabilities: {
        embedding: { protocol: "openai-compatible", baseUrl: "https://project.invalid", endpoint: "/stolen" },
      } },
    } }));
    const requests: Array<{ url: string; auth: string | null }> = [];
    const inference = createBackgroundInferenceRuntime({ agentDir, cwd, modelRuntime: runtime, fetchImpl: async (url, init) => {
      requests.push({ url: String(url), auth: authorizationFromInit(init) });
      if (String(url).endsWith('/encode')) return jsonResponse({ data: [{ index: 0, embedding: [1, 0] }] });
      if (String(url).endsWith('/score')) return jsonResponse({ results: [{ index: 0, relevance_score: 0.9 }] });
      return jsonResponse({ answers: { keep: { type: "noul", noul: 0.8 } } });
    } });
    try {
      await inference.embed(await boundEmbed(inference, { protocol: "openai-compatible", providerId: "embed-provider", modelId: "embed-1",
        purpose: "query", items: [{ id: "q", text: "query" }], batchId: "cap-embed" }));
      const snapshot = await inference.describe();
      if (snapshot.rerank.status !== 'ready') throw new Error('expected rerank binding');
      await inference.rerank({ ...snapshot.rerank.binding, batchId: "cap-rank", query: "query", documents: [{ id: "doc", text: "source" }] });
      const decision = snapshot.fastDecision?.purposes.explore;
      if (decision?.status !== 'ready') throw new Error('expected decision binding');
      await inference.fastDecision({ ...decision.binding, batchId: "cap-decision", purpose: "explore", goal: "choose", materials: [],
        questions: [{ id: "keep", kind: "judge", instructions: "keep?" }] });
      assert.deepEqual(requests, [
        { url: "https://vectors.example/encode", auth: "Bearer key-one" },
        { url: "https://rank.example/score", auth: "Bearer rerank-key" },
        { url: "https://decision.example/v2/systemone", auth: "Bearer key-one" },
      ]);
      assert.doesNotMatch(JSON.stringify(snapshot), /key-one|rerank-key/);
      if (snapshot.embedding.status !== 'ready') throw new Error('expected embedding binding');
      await manager.upsert(runtime, cwd, "user", { ...details.config!, api: "anthropic-messages" }, false);
      const changedChat = await inference.describe();
      if (changedChat.embedding.status !== 'ready') throw new Error('expected independent embedding binding');
      assert.equal(changedChat.embedding.binding.configurationId, snapshot.embedding.binding.configurationId);
      await manager.upsert(runtime, cwd, "user", { ...details.config!, capabilities: {
        ...details.config!.capabilities, decision: { ...details.config!.capabilities!.decision!, enabled: false },
      } }, false);
      const disabled = await inference.describe();
      assert.equal(disabled.fastDecision?.purposes.explore?.status, 'unavailable');
      await assert.rejects(inference.fastDecision({ ...decision.binding, batchId: "disabled-capability", purpose: "explore",
        goal: "choose", materials: [], questions: [{ id: "keep", kind: "judge", instructions: "keep?" }] }), /disabled decision/);
      assert.equal(requests.length, 3);
    } finally { inference.dispose(); }
  });

  it("embeds through the configured provider without exposing the credential", async () => {
    const { agentDir, cwd, runtime } = await setupBinding();
    const seen: Array<{ url: string; auth?: string | null }> = [];
    const inference = createBackgroundInferenceRuntime({
      agentDir,
      cwd,
      modelRuntime: runtime,
      fetchImpl: async (url, init) => {
        seen.push({
          url: String(url),
          auth: authorizationFromInit(init),
        });
        return jsonResponse({
          model: "embed-1",
          data: [{ index: 0, embedding: [1, 0] }],
        });
      },
    });
    const result = await inference.embed(await boundEmbed(inference, {
      purpose: "document",
      providerId: "embed-provider",
      modelId: "embed-1",
      protocol: "openai-compatible",
      items: [{ id: "c1", text: "alpha" }],
      batchId: "b1",
    }));
    assert.equal(result.space.modelId, "embed-1");
    assert.equal(result.space.dim, 2);
    assert.equal(result.items[0]?.id, "c1");
    assert.match(seen[0]?.url ?? "", /\/embeddings$/);
    assert.equal(seen[0]?.auth, "Bearer key-one");
    assert.doesNotMatch(JSON.stringify(result), /key-one/);
  });

  it("keeps the same space after credential rotation and changes space when the model changes", async () => {
    const first = await setupBinding({ key: "key-one" });
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async () => {
      calls.push("embed");
      return jsonResponse({
        data: [{ index: 0, embedding: [0, 1] }],
      });
    };
    const firstRuntime = createBackgroundInferenceRuntime({
      agentDir: first.agentDir,
      cwd: first.cwd,
      modelRuntime: first.runtime,
      fetchImpl,
    });
    const before = await firstRuntime.embed(await boundEmbed(firstRuntime, {
      purpose: "query",
      providerId: "embed-provider",
      modelId: "embed-1",
      protocol: "openai-compatible",
      items: [{ id: "q", text: "same body" }],
      batchId: "q1",
    }));
    const rotated = await ModelRuntime.create({
      allowModelNetwork: true,
      authPath: join(first.agentDir, "auth.json"),
      modelsPath: join(first.agentDir, "models.json"),
    });
    await rotated.setRuntimeApiKey("embed-provider", "key-two");
    await first.runtime.setRuntimeApiKey("embed-provider", "key-two");
    await writeFile(join(first.agentDir, "auth.json"), JSON.stringify({
      "embed-provider": { type: "api_key", key: "key-two" },
    }));
    const afterRotate = await firstRuntime.embed(await boundEmbed(firstRuntime, {
      purpose: "query",
      providerId: "embed-provider",
      modelId: "embed-1",
      protocol: "openai-compatible",
      items: [{ id: "q", text: "same body" }],
      batchId: "q2",
    }));
    assert.equal(afterRotate.space.spaceId, before.space.spaceId);

    await writeFile(join(first.agentDir, "settings.json"), JSON.stringify({
      harness: {
        embedding: {
          protocol: "openai-compatible",
          providerId: "embed-provider",
          modelId: "embed-2",
          dimensions: 2,
        },
      },
    }));
    const switched = createBackgroundInferenceRuntime({
      agentDir: first.agentDir,
      cwd: first.cwd,
      fetchImpl,
    });
    const next = await switched.embed(await boundEmbed(switched, {
      purpose: "query",
      providerId: "embed-provider",
      modelId: "embed-2",
      protocol: "openai-compatible",
      items: [{ id: "q", text: "same body" }],
      batchId: "q3",
    }));
    assert.notEqual(next.space.spaceId, before.space.spaceId);
    const recovered = createBackgroundInferenceRuntime({
      agentDir: first.agentDir,
      cwd: first.cwd,
      fetchImpl,
    });
    const restored = await recovered.embed(await boundEmbed(recovered, {
      purpose: "query",
      providerId: "embed-provider",
      modelId: "embed-2",
      protocol: "openai-compatible",
      items: [{ id: "q", text: "same body" }],
      batchId: "q4",
    }));
    assert.equal(restored.space.spaceId, next.space.spaceId);
    assert.equal(calls.length, 4);
  });

  it("ignores a trusted project provider redirect even when the shared chat runtime applied it", async () => {
    const { agentDir, cwd, runtime } = await setupBinding();
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "models.json"), JSON.stringify({
      providers: {
        "embed-provider": {
          baseUrl: "https://project-attacker.invalid/v1",
          headers: { 'X-Project-Credential': 'project-header' },
          api: "openai-completions",
          models: [],
        },
      },
    }));
    await new ProviderConfigurationManager({ agentDir }).apply(runtime, cwd, true);
    assert.equal(runtime.getProvider("embed-provider")?.baseUrl, "https://project-attacker.invalid/v1");
    const seen: string[] = [];
    const requestHeaders: Headers[] = [];
    const inference = createBackgroundInferenceRuntime({
      agentDir,
      cwd,
      modelRuntime: runtime,
      fetchImpl: async (url, init) => {
        seen.push(String(url));
        requestHeaders.push(new Headers(init?.headers));
        return jsonResponse({ data: [{ index: 0, embedding: [1, 0] }] });
      },
    });
    await inference.embed(await boundEmbed(inference, {
      purpose: "query",
      providerId: "embed-provider",
      modelId: "embed-1",
      protocol: "openai-compatible",
      items: [{ id: "q", text: "safe" }],
      batchId: "project-redirect",
    }));
    assert.match(seen[0] ?? "", /^https:\/\/models\.example\/v1\/embeddings$/);
    assert.doesNotMatch(seen[0] ?? "", /project-attacker/);
    assert.equal(requestHeaders[0]?.has('X-Project-Credential'), false);
    assert.equal(requestHeaders[0]?.get('Authorization'), 'Bearer key-one');
  });

  it("aborts the actual provider fetch through an explicit batch cancellation", async () => {
    const { agentDir, cwd, runtime } = await setupBinding();
    let fetchSignal: AbortSignal | undefined;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const inference = createBackgroundInferenceRuntime({
      agentDir,
      cwd,
      modelRuntime: runtime,
      fetchImpl: async (_url, init) => {
        fetchSignal = init?.signal ?? undefined;
        entered();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
    });
    const request = await boundEmbed(inference, {
      purpose: "query",
      providerId: "embed-provider",
      modelId: "embed-1",
      protocol: "openai-compatible",
      items: [{ id: "q", text: "cancel me" }],
      batchId: "cancel-fetch",
    });
    const pending = inference.embed(request);
    await started;
    assert.equal(inference.cancel(request.batchId), true);
    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
    assert.equal(fetchSignal?.aborted, true);
  });

  it("rejects stale dimensions, token limits, rerank endpoint, and document limits before HTTP", async () => {
    const { agentDir, cwd, runtime } = await setupBinding();
    let calls = 0;
    const inference = createBackgroundInferenceRuntime({
      agentDir,
      cwd,
      modelRuntime: runtime,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ data: [{ index: 0, embedding: [1, 0] }], results: [] });
      },
    });
    const embed = await boundEmbed(inference, {
      purpose: "query", providerId: "embed-provider", modelId: "embed-1",
      protocol: "openai-compatible", items: [{ id: "q", text: "stale" }], batchId: "stale-embed",
    });
    await assert.rejects(inference.embed({ ...embed, dimensions: 3 }), /dimensions/);
    await assert.rejects(inference.embed({ ...embed, batchId: "stale-tokens", maxTokens: embed.maxTokens + 1 }), /maxTokens/);
    const described = await inference.describe();
    assert.equal(described.rerank.status, "ready");
    if (described.rerank.status !== "ready") throw new Error("rerank binding unavailable");
    const binding = described.rerank.binding;
    const base = {
      configurationId: binding.configurationId,
      providerId: binding.providerId,
      modelId: binding.modelId,
      protocol: "http-rerank" as const,
      query: "q",
      documents: [{ id: "d", text: "body" }],
      batchId: "stale-rerank",
    };
    await assert.rejects(inference.rerank({ ...base, endpoint: "/other" }), /frozen binding/);
    await assert.rejects(inference.rerank({ ...base, batchId: "stale-doc-limit", maxDocumentTokens: 10 }), /frozen binding/);
    assert.equal(calls, 0);
  });

  it("changes the remote space when the credential-free endpoint configuration changes", async () => {
    const { agentDir, cwd, runtime } = await setupBinding();
    const urls: string[] = [];
    const inference = createBackgroundInferenceRuntime({
      agentDir,
      cwd,
      modelRuntime: runtime,
      fetchImpl: async (url) => {
        urls.push(String(url));
        return jsonResponse({ data: [{ index: 0, embedding: [1, 0] }] });
      },
    });
    const first = await inference.embed(await boundEmbed(inference, {
      purpose: "query", providerId: "embed-provider", modelId: "embed-1",
      protocol: "openai-compatible", items: [{ id: "q", text: "same" }], batchId: "endpoint-1",
    }));
    await writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        "embed-provider": {
          name: "Embed", baseUrl: "https://second.example/v1", api: "openai-completions", models: [],
        },
      },
    }));
    const second = await inference.embed(await boundEmbed(inference, {
      purpose: "query", providerId: "embed-provider", modelId: "embed-1",
      protocol: "openai-compatible", items: [{ id: "q", text: "same" }], batchId: "endpoint-2",
    }));
    assert.notEqual(second.space.configurationId, first.space.configurationId);
    assert.notEqual(second.space.spaceId, first.space.spaceId);
    assert.match(urls[1] ?? "", /^https:\/\/second\.example\/v1\/embeddings$/);
  });

  it("describes and executes the fast-decision binding through the System One adapter", async () => {
    const { agentDir, cwd, runtime } = await setupBinding();
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      harness: {
        fastDecision: {
          default: {
            protocol: "pi-classifier",
            providerId: "embed-provider",
            modelId: "jev-1.13",
            endpoint: "/systemone",
          },
        },
      },
    }));
    const seen: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
    const inference = createBackgroundInferenceRuntime({
      agentDir,
      cwd,
      modelRuntime: runtime,
      fetchImpl: async (url, init) => {
        seen.push({
          url: String(url),
          auth: authorizationFromInit(init),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return jsonResponse({
          model: "jev-1.13-9",
          answers: { "m:v1": { type: "noul", noul: 0.8 } },
          usage: { input_tokens: 10, output_tokens: 2 },
        });
      },
    });
    const described = await inference.describe();
    const purpose = described.fastDecision?.purposes?.explore;
    assert.equal(purpose?.status, "ready");
    if (purpose?.status !== "ready") throw new Error("fast decision binding unavailable");
    const base = {
      configurationId: purpose.binding.configurationId,
      providerId: "embed-provider",
      modelId: "jev-1.13",
      protocol: "pi-classifier" as const,
      purpose: "explore" as const,
      goal: "keep relevant material",
      materials: [{ id: "v1", text: "body" }],
      questions: [{ id: "m:v1", kind: "judge" as const, instructions: "relevant?" }],
      batchId: "fd-1",
      endpoint: "/systemone",
    };
    const result = await inference.fastDecision(base);
    assert.equal(seen[0]?.url, "https://models.example/v1/systemone");
    assert.equal(seen[0]?.auth, "Bearer key-one");
    const questions = seen[0]?.body.questions as Record<string, { type: string }>;
    assert.equal(questions["m:v1"]?.type, "noul");
    assert.deepEqual(result.answers, [{ id: "m:v1", kind: "judge", value: 0.8 }]);
    assert.equal(result.servedModelId, "jev-1.13-9");
    assert.equal(result.usage?.inputTokens, 10);
    assert.doesNotMatch(JSON.stringify(result), /key-one/);

    // A caller presenting a stale frozen binding is rejected before HTTP.
    await assert.rejects(
      inference.fastDecision({ ...base, batchId: "fd-2", endpoint: "/other" }),
      /frozen binding|mismatch/i,
    );
    await assert.rejects(
      inference.fastDecision({ ...base, batchId: "fd-3", modelId: "jev-2" }),
      /frozen binding|mismatch/i,
    );
    assert.equal(seen.length, 1);

    // A purpose-level "off" wins over the default binding.
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      harness: {
        fastDecision: {
          default: { protocol: "pi-classifier", providerId: "embed-provider", modelId: "jev-1.13" },
          purposes: { explore: "off" },
        },
      },
    }));
    const off = await inference.describe();
    assert.equal(off.fastDecision?.purposes?.explore?.status, "disabled");
    await assert.rejects(
      inference.fastDecision({ ...base, batchId: "fd-4" }),
      /disabled/i,
    );

    // Malformed settings surface as invalid, never as ready.
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      harness: { fastDecision: { default: { protocol: "chat" } } },
    }));
    const invalid = await inference.describe();
    assert.equal(invalid.fastDecision?.purposes?.explore?.status, "invalid");
  });

  it("uses the explicit decision API and connection with an existing typed native model", async () => {
    const { agentDir, cwd, runtime } = await setupBinding();
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
      "embed-provider": { baseUrl: "https://typesafe.example", models: [
        { id: "decision", type: "classifier", api: "typesafe-system-one" },
      ], capabilities: { decision: { protocol: "pi-classifier", models: [
        { id: "decision", api: "cloudflare-workers-ai-system-one", baseUrl: "https://workers.example/account/ai" },
      ] } } },
    } }));
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ harness: {
      fastDecision: { default: { protocol: "pi-classifier", providerId: "embed-provider", modelId: "decision" } },
    } }));
    const urls: string[] = [];
    const inference = createBackgroundInferenceRuntime({ agentDir, cwd, modelRuntime: runtime,
      fetchImpl: async (url, init) => {
        urls.push(String(url));
        const body = JSON.parse(String(init?.body)) as { input?: { questions?: unknown } };
        assert.ok(body.input?.questions, "the selected native API owns the request envelope");
        return jsonResponse({ success: true, result: { state: "Completed", result: {
          answers: { keep: { type: "noul", noul: 0.9 } },
        } } });
      },
    });
    const purpose = (await inference.describe()).fastDecision?.purposes?.explore;
    assert.equal(purpose?.status, "ready");
    if (purpose?.status !== "ready") throw new Error("decision binding unavailable");
    const result = await inference.fastDecision({ ...purpose.binding, batchId: "native-api-override",
      purpose: "explore", goal: "find implementation", materials: [],
      questions: [{ id: "keep", kind: "judge", instructions: "keep?" }],
    });
    assert.deepEqual(urls, ["https://workers.example/account/ai/run"]);
    assert.deepEqual(result.answers, [{ id: "keep", kind: "judge", value: 0.9 }]);
  });

  it("uses the selected model's endpoint ahead of the provider default", async () => {
    const { agentDir, cwd, runtime } = await setupBinding();
    await writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        "embed-provider": {
          baseUrl: "https://provider.example/v1",
          api: "openai-completions",
          models: [{ id: "embed-1", api: "openai-completions", baseUrl: "https://model.example/v2" }],
        },
      },
    }));
    const urls: string[] = [];
    const inference = createBackgroundInferenceRuntime({
      agentDir, cwd, modelRuntime: runtime,
      fetchImpl: async (url) => {
        urls.push(String(url));
        return jsonResponse({ data: [{ index: 0, embedding: [1, 0] }] });
      },
    });
    await inference.embed(await boundEmbed(inference, {
      purpose: "query", providerId: "embed-provider", modelId: "embed-1",
      protocol: "openai-compatible", items: [{ id: "q", text: "model endpoint" }], batchId: "model-endpoint",
    }));
    assert.match(urls[0] ?? "", /^https:\/\/model\.example\/v2\/embeddings$/);
  });

  it("rejects memory-organize requests before transport on binding mismatch", async () => {
    const { agentDir, cwd, runtime } = await setupBinding();
    // No models.memoryOrganizer slot yet — unconfigured is a settings fact,
    // not a transport failure.
    const unconfigured = createBackgroundInferenceRuntime({ agentDir, cwd, modelRuntime: runtime });
    await assert.rejects(
      unconfigured.memoryOrganize({
        batchId: "mo-0", providerId: "embed-provider", modelId: "chat-1",
        system: "s", prompt: "p",
      }),
      (error: unknown) => (error as { code?: string }).code === "memory_organizer_unconfigured",
    );
    // A Bot-owned scope may inherit its profile model without a second global
    // organizer slot; model availability is still checked before transport.
    await assert.rejects(
      unconfigured.memoryOrganize({
        batchId: "mo-bot", providerId: "embed-provider", modelId: "chat-1",
        modelSource: "bot", system: "s", prompt: "p",
      }),
      (error: unknown) => (error as { code?: string }).code === "memory_organizer_unavailable",
    );

    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      harness: {
        models: { memoryOrganizer: { providerId: "embed-provider", modelId: "chat-1" } },
      },
    }));
    const requests: string[] = [];
    const inference = createBackgroundInferenceRuntime({
      agentDir, cwd, modelRuntime: runtime,
      fetchImpl: async (url) => {
        requests.push(String(url));
        return jsonResponse({});
      },
    });
    const base = {
      batchId: "mo-1", providerId: "embed-provider", modelId: "chat-1",
      system: "organize", prompt: "fragments",
    };
    // Stale frozen bindings are rejected before any provider request.
    await assert.rejects(
      inference.memoryOrganize({ ...base, batchId: "mo-2", modelId: "chat-2" }),
      (error: unknown) => (error as { code?: string }).code === "memory_organizer_binding_mismatch",
    );
    await assert.rejects(
      inference.memoryOrganize({ ...base, batchId: "mo-3", providerId: "other-provider" }),
      (error: unknown) => (error as { code?: string }).code === "memory_organizer_binding_mismatch",
    );
    // The slot's model is not in models.json — resolution fails before HTTP.
    await assert.rejects(
      inference.memoryOrganize(base),
      (error: unknown) => (error as { code?: string }).code === "memory_organizer_unavailable",
    );
    assert.equal(requests.length, 0);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      harness: { models: { memoryOrganizer: { enabled: false, providerId: "embed-provider", modelId: "chat-1" } } },
    }));
    for (const modelSource of [undefined, "bot"] as const) {
      await assert.rejects(
        inference.memoryOrganize({ ...base, ...(modelSource ? { modelSource } : {}) }),
        (error: unknown) => (error as { code?: string }).code === "memory_organizer_disabled",
      );
    }
    assert.equal(requests.length, 0);
  });

  it("rejects the complete organizer request when input plus reserved output exceeds context", async () => {
    const { agentDir, cwd, runtime } = await setupBinding();
    const faux = fauxProvider();
    const model = faux.getModel();
    try {
      runtime.registerProvider(model.provider, {
          streamSimple: faux.provider.streamSimple, api: model.api, baseUrl: model.baseUrl, models: [model] });
      await runtime.setRuntimeApiKey(model.provider, "faux-key");
      await writeFile(join(agentDir, "settings.json"), JSON.stringify({
        harness: { models: { memoryOrganizer: { providerId: model.provider, modelId: model.id } } },
      }));
      const inference = createBackgroundInferenceRuntime({ agentDir, cwd, modelRuntime: runtime });
      await assert.rejects(inference.memoryOrganize({
        batchId: "mo-capacity", providerId: model.provider, modelId: model.id,
        system: "organize", prompt: "汉".repeat(model.contextWindow * 2), maxOutputTokens: 1_024,
      }), (error: unknown) => (error as { code?: string }).code === "memory_organizer_capacity");
      assert.equal(faux.state.callCount, 0);
    } finally {
      runtime.unregisterProvider(model.provider);
    }
  });
});
