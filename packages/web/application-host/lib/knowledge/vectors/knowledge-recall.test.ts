import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { embeddingSettingsFromSnapshot } from "../semantic/backend.js";
import { createSemanticBackend } from "../semantic/backend.js";
import { createHashEmbedder, type SemanticEmbedder } from "../semantic/index.js";
import { createEmbedScheduler } from "../semantic/embed-scheduler.js";
import { createVectorCache } from "../semantic/vector-cache.js";
import { remoteEmbeddingSpaceId } from "../semantic/identity.js";
import { resolveInferenceBinding } from "../semantic/workspace-inference.js";
import { openWorkspaceKnowledge, type KnowledgeStore } from "../store.js";
import { createKnowledgeContextRuntime } from "../context-runtime.js";
import { executeRecall } from "../../harness/recall-tool.js";
import { createRecallSearchService } from "../../harness/harness-services.js";
import { createKnowledgeVectorRuntime } from "./runtime.js";
import { knowledgeEmbedText } from "./identity.js";
import { REMOTE_EMBEDDING_DEFAULT_MAX_TOKENS } from "@varin/protocol";
import type { HarnessEmbedResult, HarnessResolvedEmbeddingBinding, PiSettingsSnapshot } from "@varin/protocol";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "varin-knowledge-recall-"));
  cleanup.unshift(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

type MappedEmbedder = SemanticEmbedder & { map(text: string, vector: number[]): void; submitted: string[] };

const mappedEmbedder = (space = createHashEmbedder().space): MappedEmbedder => {
  const vectors = new Map<string, number[]>();
  const embedder: MappedEmbedder = {
    status: "ready",
    space: { ...space, dim: 2, modelRevision: "mapped" },
    prepare: async () => undefined,
    countTokens: (text) => Math.max(1, text.length),
    embed: async (texts) => {
      embedder.submitted.push(...texts);
      return texts.map((text) => vectors.get(text) ?? [0, 1]);
    },
    embedBatch: async (request) => {
      request.signal?.throwIfAborted();
      const items = request.items.map((item, index) => ({
        id: item.id,
        index,
        vector: vectors.get(item.text) ?? [0, 1],
      }));
      return { batchId: request.batchId, space: embedder.space, items };
    },
    map(text, vector) { vectors.set(text, vector); },
    submitted: [],
  };
  return embedder;
};

async function openAuthority(dir: string, workspaceId: string): Promise<KnowledgeStore> {
  mkdirSync(dir, { recursive: true });
  const store = await openWorkspaceKnowledge({
    dataDir: dir,
    hostId: "host",
    workspaceId,
    embedding: null,
  });
  cleanup.push(() => store.close());
  return store;
}

describe("knowledge semantic recall", () => {
  it("returns via:vector from a query that does not text-match", async () => {
    const dir = tempDir();
    const store = await openAuthority(dir, "ws");
    const embedder = mappedEmbedder();
    const document = knowledgeEmbedText("Always prefer bun for installs", "installs");
    embedder.map(document, [1, 0]);
    embedder.map("package manager policy", [1, 0]);
    await store.putKnowledge({
      scope: "workspace",
      status: "accepted",
      content: "Always prefer bun for installs",
      trigger: "installs",
    });
    const runtime = createKnowledgeVectorRuntime({
      dataDir: dir,
      hostId: "host",
      scheduler: createEmbedScheduler(),
      cache: createVectorCache(),
      resolveEmbedder: async () => ({ status: "ready", embedder }),
    });
    cleanup.push(() => runtime.close());
    runtime.scheduleReconcile(store, "workspace", "ws", "ws");
    await runtime.waitForBuild("workspace", "ws", "ws");
    const recalled = await executeRecall("package manager policy", 5, {
      workspaceStore: store,
      userStore: null,
      workspaceId: "ws",
      vectors: runtime,
    });
    expect(recalled.results).toHaveLength(1);
    expect(recalled.results[0]?.via).toBe("vector");
    expect(recalled.results[0]?.node.payload.content).toBe("Always prefer bun for installs");
    expect(recalled.details.vector).toBe("used");
  });

  it("encodes a long knowledge entry in complete backend-sized chunks", async () => {
    const dir = tempDir();
    const store = await openAuthority(dir, "ws");
    const embedder = mappedEmbedder();
    const content = `long-entry-start ${"semantic-body ".repeat(120)} long-entry-end`;
    await store.putKnowledge({
      scope: "workspace",
      status: "accepted",
      content,
      trigger: "long-entry-trigger",
    });
    const runtime = createKnowledgeVectorRuntime({
      dataDir: dir,
      hostId: "host",
      scheduler: createEmbedScheduler(),
      cache: createVectorCache(),
      resolveEmbedder: async () => ({ status: "ready", embedder }),
    });
    cleanup.push(() => runtime.close());
    runtime.scheduleReconcile(store, "workspace", "ws", "ws");
    await runtime.waitForBuild("workspace", "ws", "ws");
    expect(embedder.submitted.length).toBeGreaterThan(1);
    expect(embedder.submitted.every((text) => embedder.countTokens(text) <= embedder.space.maxTokens)).toBe(true);
    expect(embedder.submitted.some((text) => text.includes("long-entry-start"))).toBe(true);
    expect(embedder.submitted.some((text) => text.includes("long-entry-end"))).toBe(true);
  });

  it("keeps suggested, invalid, and other-workspace entries out of Top-K", async () => {
    const dir = tempDir();
    const storeA = await openAuthority(dir, "ws-a");
    const storeB = await openAuthority(dir, "ws-b");
    const embedder = mappedEmbedder();
    const good = knowledgeEmbedText("workspace A accepted fact", "fact");
    const noise = knowledgeEmbedText("suggested only", "fact");
    embedder.map(good, [1, 0]);
    embedder.map(noise, [1, 0]);
    embedder.map("fact", [1, 0]);
    const superseded = await storeA.putKnowledge({
      scope: "workspace",
      status: "accepted",
      content: "old superseded fact",
      trigger: "fact",
    });
    const pending = await storeA.putKnowledge({
      scope: "workspace",
      status: "suggested",
      content: "workspace A accepted fact",
      trigger: "fact",
    });
    await storeA.acceptKnowledge(pending, { supersedes: [superseded] });
    await storeA.putKnowledge({
      scope: "workspace",
      status: "suggested",
      content: "suggested only",
      trigger: "fact",
    });
    const runtime = createKnowledgeVectorRuntime({
      dataDir: dir,
      hostId: "host",
      scheduler: createEmbedScheduler(),
      cache: createVectorCache(),
      resolveEmbedder: async () => ({ status: "ready", embedder }),
    });
    cleanup.push(() => runtime.close());
    runtime.scheduleReconcile(storeA, "workspace", "ws-a", "ws-a");
    await runtime.waitForBuild("workspace", "ws-a", "ws-a");
    const fromA = await executeRecall("fact", 5, {
      workspaceStore: storeA, userStore: null, workspaceId: "ws-a", vectors: runtime,
    });
    expect(fromA.results.map((row) => row.node.payload.content)).toEqual(["workspace A accepted fact"]);
    const fromB = await executeRecall("fact", 5, {
      workspaceStore: storeB, userStore: null, workspaceId: "ws-b", vectors: runtime,
    });
    expect(fromB.results).toEqual([]);
  });

  it("does not let a late embedding overwrite a newer revision", async () => {
    const dir = tempDir();
    const store = await openAuthority(dir, "ws");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let embeds = 0;
    const embedder: SemanticEmbedder = {
      status: "ready",
      space: { ...createHashEmbedder().space, dim: 2, modelRevision: "late" },
      prepare: async () => undefined,
      countTokens: (text) => Math.max(1, text.length),
      embed: async (texts, request) => {
        embeds += 1;
        if (request?.purpose === "document" && embeds === 1) await gate;
        return texts.map(() => [embeds === 1 ? 1 : 0, embeds === 1 ? 0 : 1]);
      },
      embedBatch: async () => {
        throw new Error("unused");
      },
    };
    const first = await store.putKnowledge({
      scope: "workspace",
      status: "accepted",
      content: "first body",
      trigger: "body",
    });
    const runtime = createKnowledgeVectorRuntime({
      dataDir: dir,
      hostId: "host",
      scheduler: createEmbedScheduler(),
      cache: createVectorCache(),
      resolveEmbedder: async () => ({ status: "ready", embedder }),
    });
    cleanup.push(() => runtime.close());
    runtime.scheduleReconcile(store, "workspace", "ws", "ws");
    const replacement = await store.putKnowledge({
      scope: "workspace",
      status: "suggested",
      content: "second body",
      trigger: "body",
    });
    await store.acceptKnowledge(replacement, { supersedes: [first] });
    runtime.notify(store, "workspace", "ws", "ws", [first, replacement]);
    release();
    await runtime.waitForBuild("workspace", "ws", "ws");
    const recalled = await executeRecall("second body", 5, {
      workspaceStore: store, userStore: null, workspaceId: "ws", vectors: runtime,
    });
    expect(recalled.results.some((row) => row.node.payload.content === "second body")).toBe(true);
    expect(recalled.results.some((row) => row.node.payload.content === "first body")).toBe(false);
  });

  it("keeps text recall when the provider fails and does not claim via:vector", async () => {
    const dir = tempDir();
    const store = await openAuthority(dir, "ws");
    await store.putKnowledge({
      scope: "workspace",
      status: "accepted",
      content: "Keep the text path",
      trigger: "text path",
    });
    const runtime = createKnowledgeVectorRuntime({
      dataDir: dir,
      hostId: "host",
      scheduler: createEmbedScheduler(),
      cache: createVectorCache(),
      resolveEmbedder: async () => ({ status: "failed", message: "provider down" }),
    });
    cleanup.push(() => runtime.close());
    const recalled = await executeRecall("text path", 5, {
      workspaceStore: store, userStore: null, workspaceId: "ws", vectors: runtime,
    });
    expect(recalled.results[0]?.via).toBe("text");
    expect(recalled.details.vector).toBe("failed");
  });

  it("restores published vectors after reopen and does not mix spaces", async () => {
    const dir = tempDir();
    const store = await openAuthority(dir, "ws");
    const first = createHashEmbedder({
      ...createHashEmbedder().space,
      modelRevision: "space-a",
      dim: 4,
    });
    await store.putKnowledge({
      scope: "workspace",
      status: "accepted",
      content: "stable knowledge body",
      trigger: "stable",
    });
    const runtimeA = createKnowledgeVectorRuntime({
      dataDir: dir,
      hostId: "host",
      scheduler: createEmbedScheduler(),
      cache: createVectorCache(),
      resolveEmbedder: async () => ({ status: "ready", embedder: first }),
    });
    runtimeA.scheduleReconcile(store, "workspace", "ws", "ws");
    await runtimeA.waitForBuild("workspace", "ws", "ws");
    runtimeA.close();
    const runtimeB = createKnowledgeVectorRuntime({
      dataDir: dir,
      hostId: "host",
      scheduler: createEmbedScheduler(),
      cache: createVectorCache(),
      resolveEmbedder: async () => ({ status: "ready", embedder: first }),
    });
    cleanup.push(() => runtimeB.close());
    const restored = await executeRecall("stable knowledge body", 5, {
      workspaceStore: store, userStore: null, workspaceId: "ws", vectors: runtimeB,
    });
    expect(restored.results[0]?.via).toBe("vector");
    const second = createHashEmbedder({
      ...createHashEmbedder().space,
      modelRevision: "space-b",
      dim: 4,
    });
    const runtimeC = createKnowledgeVectorRuntime({
      dataDir: dir,
      hostId: "host",
      scheduler: createEmbedScheduler(),
      cache: createVectorCache(),
      resolveEmbedder: async () => ({ status: "ready", embedder: second }),
    });
    cleanup.push(() => runtimeC.close());
    const switched = await runtimeC.search({
      authority: store,
      scope: "workspace",
      scopeId: "ws",
      workspaceId: "ws",
      query: "stable knowledge body",
      limit: 5,
    });
    expect(switched.spaceId).not.toBe(restored.details.spaceId);
    expect(switched.hits).toEqual([]);
    await runtimeC.waitForBuild("workspace", "ws", "ws");
    const rebuilt = await runtimeC.search({
      authority: store,
      scope: "workspace",
      scopeId: "ws",
      workspaceId: "ws",
      query: "stable knowledge body",
      limit: 5,
    });
    expect(rebuilt.hits[0]?.contentRevision).toBeDefined();
  });
});

describe("production settings bind to public recall", () => {
  it("parses harness.embedding, binds the Host remote embedder, and returns the original knowledge", async () => {
    const dir = tempDir();
    const store = await openAuthority(dir, "prod-ws");
    const snapshot: PiSettingsSnapshot = {
      global: {
        harness: {
          embedding: {
            protocol: "openai-compatible",
            providerId: "openai",
            modelId: "text-embedding-3-small",
            dimensions: 2,
          },
        },
      },
      globalRevision: "1",
      project: {},
      projectRevision: "1",
      projectTrusted: false,
    };
    const settings = embeddingSettingsFromSnapshot(snapshot);
    expect(settings?.modelId).toBe("text-embedding-3-small");
    const described = {
      embedding: {
        status: "ready" as const,
        binding: {
          protocol: "openai-compatible" as const,
          providerId: "openai",
          modelId: "text-embedding-3-small",
          dimensions: 2,
          configurationId: "cfg-prod",
        } satisfies HarnessResolvedEmbeddingBinding,
      },
      rerank: { status: "unconfigured" as const },
    };
    const binding = resolveInferenceBinding(
      { status: "fulfilled", value: snapshot },
      { status: "fulfilled", value: described },
    );
    expect(binding.embedding.status).toBe("ready");
    const spaceId = remoteEmbeddingSpaceId({
      protocol: "openai-compatible",
      providerId: "openai",
      modelId: "text-embedding-3-small",
      configurationId: "cfg-prod",
      maxTokens: REMOTE_EMBEDDING_DEFAULT_MAX_TOKENS,
      dimensions: 2,
    });
    const calls: string[] = [];
    const backend = createSemanticBackend({
      local: createHashEmbedder(),
      embedClient: {
        embed: async (params) => {
          calls.push(params.purpose);
          const result: HarnessEmbedResult = {
            batchId: params.batchId,
            space: {
              configurationId: params.configurationId,
              providerId: params.providerId,
              modelId: params.modelId,
              protocol: "openai-compatible",
              dim: 2,
              maxTokens: params.maxTokens,
              spaceId,
            },
            items: params.items.map((item, index) => ({
              id: item.id,
              index,
              vector: item.text.includes("pineapple") || item.text.includes("unique-token") ? [1, 0] : [0, 1],
            })),
          };
          return result;
        },
      },
    });
    if (binding.embedding.status !== "ready") throw new Error("expected ready binding");
    backend.bind(binding.embedding.binding);
    expect(backend.kind).toBe("remote");
    await store.putKnowledge({
      scope: "workspace",
      status: "accepted",
      content: "Remember the unique-token pineapple rule",
      trigger: "pineapple",
    });
    const runtime = createKnowledgeVectorRuntime({
      dataDir: dir,
      hostId: "host",
      scheduler: createEmbedScheduler(),
      cache: createVectorCache(),
      resolveEmbedder: async () => ({ status: "ready", embedder: backend.embedder }),
    });
    cleanup.push(() => runtime.close());
    runtime.scheduleReconcile(store, "workspace", "prod-ws", "prod-ws");
    await runtime.waitForBuild("workspace", "prod-ws", "prod-ws");
    const service = createRecallSearchService({
      recallDepsProvider: async () => ({
        workspaceStore: store,
        userStore: null,
        workspaceId: "prod-ws",
        vectors: runtime,
      }),
    } as never);
    const result = await service.handle({ query: "pineapple", k: 5 }, {
      actor: { sessionId: "s", workspaceId: "prod-ws" },
      signal: new AbortController().signal,
    } as never);
    expect(result.results[0]?.title).toContain("unique-token pineapple");
    expect(result.results[0]?.via).toBe("vector");
    expect(result.details?.vector).toBe("used");
    expect(calls).toContain("document");
    expect(calls).toContain("query");
    const zone = createKnowledgeContextRuntime({
      getStore: async () => store,
      recall: async ({ workspaceId, store: authority, query }) => {
        const { results } = await executeRecall(query, 5, {
          workspaceStore: authority,
          userStore: null,
          workspaceId,
          vectors: runtime,
        });
        return results;
      },
    });
    zone.bindSession("s", "prod-ws");
    const material = await zone.zone2Material({
      sessionId: "s",
      sinceTurn: 0,
      query: "pineapple",
      contextUsage: null,
    });
    expect(material.material.knowledge.some((item) => item.title.includes("unique-token pineapple"))).toBe(true);
  });
});
