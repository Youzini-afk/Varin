import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspaceKnowledge } from "../store.js";
import { createKnowledgeVectorRuntime } from "./runtime.js";
import { createEmbedScheduler } from "../semantic/embed-scheduler.js";
import { createVectorCache } from "../semantic/vector-cache.js";
import { createRemoteEmbedder } from "../semantic/remote-embedder.js";
import { remoteEmbeddingSpaceId } from "../semantic/identity.js";
import { spaceIdOf } from "../semantic/identity.js";
import { createHashEmbedder } from "../semantic/embedder.js";
import { executeRecall } from "../../harness/recall-tool.js";
import { knowledgeStoreKeyForScope } from '../../harness/owner-scope.js';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "varin-knowledge-acceptance-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const authority = await openWorkspaceKnowledge({ dataDir, hostId: "host", workspaceId: "workspace", embedding: null });
  cleanup.push(() => authority.close());
  await authority.putKnowledge({ scope: "workspace", status: "accepted", content: "Prefer bun", trigger: "install" });
  return { dataDir, authority };
}

describe("knowledge recall acceptance", () => {
  it('retires only the deleted Bot and prevents late work from recreating its vector directory', async () => {
    const { dataDir, authority } = await fixture();
    const scopeId = 'bot:10b6af44-89e4-4e1a-b042-4d03344fe8af';
    const key = knowledgeStoreKeyForScope(scopeId);
    const botStore = await openWorkspaceKnowledge({ dataDir, hostId: 'host', workspaceId: key, scope: 'bot', embedding: null });
    cleanup.push(() => botStore.close());
    await botStore.putKnowledge({ scope: 'bot', status: 'accepted', content: 'Keep Bot memory', trigger: 'policy' });
    const embedder = createHashEmbedder();
    const runtime = createKnowledgeVectorRuntime({ dataDir, hostId: 'host', scheduler: createEmbedScheduler(), cache: createVectorCache(), resolveEmbedder: async () => ({ status: 'ready', embedder }) });
    cleanup.push(() => runtime.close());
    runtime.scheduleReconcile(botStore, 'bot', scopeId, scopeId);
    runtime.scheduleReconcile(authority, 'workspace', 'workspace', 'workspace');
    await Promise.all([runtime.waitForBuild('bot', scopeId, scopeId), runtime.waitForBuild('workspace', 'workspace', 'workspace')]);
    const directory = join(dataDir, 'knowledge', 'host', 'semantic', 'knowledge-bot', key);
    expect(existsSync(directory)).toBe(true);
    await runtime.releaseScope('bot', scopeId);
    rmSync(directory, { recursive: true, force: true });
    runtime.notify(botStore, 'bot', scopeId, scopeId, [1]);
    runtime.scheduleReconcile(botStore, 'bot', scopeId, scopeId);
    expect(await runtime.search({ authority: botStore, scope: 'bot', scopeId, workspaceId: scopeId, query: 'policy', limit: 5 })).toEqual({ status: 'unavailable', hits: [] });
    expect(existsSync(directory)).toBe(false);
    const other = await runtime.search({ authority, scope: 'workspace', scopeId: 'workspace', workspaceId: 'workspace', query: 'bun', limit: 5 });
    expect(other.hits).toHaveLength(1);
    await runtime.releaseScope('bot', scopeId);
  });

  it('cancels a retired owner while embedding configuration is still resolving', async () => {
    const { dataDir, authority } = await fixture();
    let resolve!: (value: { status: 'unconfigured' }) => void;
    const gate = new Promise<{ status: 'unconfigured' }>((done) => { resolve = done; });
    const onError = vi.fn();
    const runtime = createKnowledgeVectorRuntime({ dataDir, hostId: 'host', scheduler: createEmbedScheduler(), cache: createVectorCache(), resolveEmbedder: () => gate, onError });
    cleanup.push(() => runtime.close());
    runtime.scheduleReconcile(authority, 'bot', 'bot:pending', 'bot:pending');
    await runtime.releaseScope('bot', 'bot:pending');
    resolve({ status: 'unconfigured' });
    expect(onError).not.toHaveBeenCalled();
  });

  it("builds accepted knowledge with automatic remote dimensions without relying on a code scan", async () => {
    const { dataDir, authority } = await fixture();
    const purposes: string[] = [];
    const embedder = createRemoteEmbedder({
      binding: { protocol: "openai-compatible", providerId: "p", modelId: "m", configurationId: "c" },
      client: { embed: async (params) => {
        purposes.push(params.purpose);
        return {
          batchId: params.batchId,
          space: { protocol: "openai-compatible", providerId: "p", modelId: "m", configurationId: "c", dim: 2, maxTokens: 8192,
            spaceId: remoteEmbeddingSpaceId({ protocol: "openai-compatible", providerId: "p", modelId: "m", configurationId: "c", dimensions: 2, maxTokens: 8192 }) },
          items: params.items.map((item, index) => ({ id: item.id, index, vector: [1, 0] })),
        };
      } },
    });
    const runtime = createKnowledgeVectorRuntime({ dataDir, hostId: "host", scheduler: createEmbedScheduler(), cache: createVectorCache(), resolveEmbedder: async () => ({ status: "ready", embedder }) });
    cleanup.push(() => runtime.close());
    runtime.scheduleReconcile(authority, "workspace", "workspace", "workspace");
    await runtime.waitForBuild("workspace", "workspace", "workspace");
    await executeRecall("package policy", 5, { workspaceStore: authority, userStore: null, workspaceId: "workspace", vectors: runtime });
    await runtime.waitForBuild("workspace", "workspace", "workspace");
    const result = await executeRecall("package policy", 5, { workspaceStore: authority, userStore: null, workspaceId: "workspace", vectors: runtime });
    expect(purposes).toContain("document");
    expect(result.results[0]?.via).toBe("vector");
  });

  it("keeps text recall when binding resolution throws", async () => {
    const { dataDir, authority } = await fixture();
    const runtime = createKnowledgeVectorRuntime({ dataDir, hostId: "host", scheduler: createEmbedScheduler(), cache: createVectorCache(), resolveEmbedder: async () => { throw new Error("workspace unavailable"); } });
    cleanup.push(() => runtime.close());
    const result = await executeRecall("bun", 5, { workspaceStore: authority, userStore: null, workspaceId: "workspace", vectors: runtime });
    expect(result.results[0]?.via).toBe("text");
    expect(["unavailable", "failed"]).toContain(result.details.vector);
  });

  it.each(["unconfigured", "failed"] as const)("does not automatically retry a %s binding", async (status) => {
    const { dataDir, authority } = await fixture();
    let resolutions = 0;
    const runtime = createKnowledgeVectorRuntime({
      dataDir, hostId: "host", scheduler: createEmbedScheduler(), cache: createVectorCache(),
      resolveEmbedder: async () => {
        resolutions += 1;
        if (status === "failed") throw new Error("provider unavailable");
        return { status: "unconfigured" };
      },
    });
    cleanup.push(() => runtime.close());
    runtime.scheduleReconcile(authority, "workspace", "workspace", "workspace");
    await runtime.waitForBuild("workspace", "workspace", "workspace");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resolutions).toBe(1);
    runtime.scheduleReconcile(authority, "workspace", "workspace", "workspace");
    await runtime.waitForBuild("workspace", "workspace", "workspace");
    expect(resolutions).toBe(2);
  });

  it("keeps each query vector distinct while they await the same document dimension bootstrap", async () => {
    const { dataDir, authority } = await fixture();
    let started!: () => void;
    const documentStarted = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const documentGate = new Promise<void>((resolve) => { release = resolve; });
    const queries: string[] = [];
    let firstDocument = true;
    const embedder = createRemoteEmbedder({
      binding: { protocol: "openai-compatible", providerId: "p", modelId: "m", configurationId: "c" },
      client: { embed: async (params) => {
        if (params.purpose === "document" && firstDocument) {
          firstDocument = false;
          started();
          await documentGate;
        }
        if (params.purpose === "query") queries.push(...params.items.map((item) => item.text));
        return {
          batchId: params.batchId,
          space: { protocol: "openai-compatible", providerId: "p", modelId: "m", configurationId: "c", dim: 2, maxTokens: params.maxTokens,
            spaceId: remoteEmbeddingSpaceId({ protocol: "openai-compatible", providerId: "p", modelId: "m", configurationId: "c", dimensions: 2, maxTokens: params.maxTokens }) },
          items: params.items.map((item, index) => ({
            id: item.id, index, vector: item.text === "alpha-question" ? [0, 1] : item.text === "beta-question" ? [-1, 0] : [1, 0],
          })),
        };
      } },
    });
    const cache = createVectorCache();
    const runtime = createKnowledgeVectorRuntime({ dataDir, hostId: "host", scheduler: createEmbedScheduler(), cache, resolveEmbedder: async () => ({ status: "ready", embedder }) });
    cleanup.push(() => runtime.close());
    runtime.scheduleReconcile(authority, "workspace", "workspace", "workspace");
    await documentStarted;
    const query = (text: string) => runtime.search({ authority, scope: "workspace", scopeId: "workspace", workspaceId: "workspace", query: text, limit: 5 });
    const pending = Promise.all([query("alpha-question"), query("beta-question")]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await pending;
    expect(queries.sort()).toEqual(["alpha-question", "beta-question"]);
    expect(cache.get({ spaceId: spaceIdOf(embedder.space), purpose: "query", embedText: "alpha-question" })).toEqual([0, 1]);
    expect(cache.get({ spaceId: spaceIdOf(embedder.space), purpose: "query", embedText: "beta-question" })).toEqual([-1, 0]);
  });

  it("cancels resolver waits and ignores their result after shutdown", async () => {
    const { dataDir, authority } = await fixture();
    let release!: (value: { status: "ready"; embedder: ReturnType<typeof createHashEmbedder> }) => void;
    const resolution = new Promise<{ status: "ready"; embedder: ReturnType<typeof createHashEmbedder> }>((resolve) => { release = resolve; });
    let resolves = 0;
    const runtime = createKnowledgeVectorRuntime({
      dataDir, hostId: "host", scheduler: createEmbedScheduler(), cache: createVectorCache(),
      resolveEmbedder: async () => { resolves += 1; return resolution; },
    });
    cleanup.push(() => runtime.close());
    runtime.scheduleReconcile(authority, "workspace", "workspace", "workspace");
    const controller = new AbortController();
    const pending = runtime.search({ authority, scope: "workspace", scopeId: "workspace", workspaceId: "workspace", query: "bun", limit: 5, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    await runtime.close();
    release({ status: "ready", embedder: createHashEmbedder() });
    await new Promise<void>((resolve) => setImmediate(resolve));
    runtime.scheduleReconcile(authority, "workspace", "workspace", "workspace");
    expect((await runtime.search({ authority, scope: "workspace", scopeId: "workspace", workspaceId: "workspace", query: "bun", limit: 5 })).status).toBe("unavailable");
    expect(resolves).toBe(2);
  });
});
