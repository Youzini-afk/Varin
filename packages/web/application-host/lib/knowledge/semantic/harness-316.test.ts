import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDocumentAuthorityHarness } from "../../documents/contract-fixtures.js";
import { createStructureSource } from "../../structure/source.js";
import { createTreeSitterStructureProvider } from "../../structure/native-provider.test-helper.js";
import { createHashEmbedder, hashEmbed } from "./embedder.js";
import { createEmbedScheduler } from "./embed-scheduler.js";
import { createSemanticBackend } from "./backend.js";
import { createRemoteEmbedder } from "./remote-embedder.js";
import { createSemanticIndexRuntime } from "./runtime.js";
import { createSemanticGenerationStore } from "./store.js";
import { createVectorCache } from "./vector-cache.js";
import { pinSemanticQueryView } from "./query-view.js";
import { remoteEmbeddingSpaceId, workspaceScope } from "./identity.js";
import { blockIdentity } from "./identity.js";
import type { SemanticChunk } from "./chunker.js";

const dirs: string[] = [];
const disposes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposes.splice(0).reverse()) await dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const chunk = (documentId: string, body: string, startLine = 1): SemanticChunk => ({
  blockId: blockIdentity(documentId, startLine, startLine),
  parentUnitId: `${encodeURIComponent(documentId)}#run#function`,
  documentId,
  parentName: "run",
  parentKind: "function",
  parentSignature: "function run()",
  startLine,
  endLine: startLine,
  contentHash: `hash-${body}`,
  body,
  embedText: body,
  fallback: false,
});

describe("3.16 vector reuse, scheduler, overlays, and remote spaces", () => {
  it("reuses the same embedText and only re-embeds a changed block", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "varin-reuse-"));
    dirs.push(dataDir);
    const sent: string[] = [];
    const base = createHashEmbedder();
    const embedder = {
      ...base,
      embed: async (texts: readonly string[]) => {
        sent.push(...texts);
        return base.embed(texts);
      },
    };
    const store = createSemanticGenerationStore({
      dataDir,
      hostId: "host",
      scope: workspaceScope("ws"),
      embedder,
    });
    disposes.push(() => store.close());
    await store.publishDocument({
      documentId: "src/a.ts",
      revision: "r1",
      chunks: [chunk("src/a.ts", "stable pineapple"), chunk("src/a.ts", "changing coconut", 2)],
    });
    await store.publishDocument({
      documentId: "src/a.ts",
      revision: "r2",
      chunks: [chunk("src/a.ts", "stable pineapple"), chunk("src/a.ts", "changing coconut now", 2)],
    });
    expect(sent.filter((text) => text === "stable pineapple")).toHaveLength(1);
    expect(sent.filter((text) => text === "changing coconut now")).toHaveLength(1);
  });

  it("runs a foreground query before the next background batch", async () => {
    const scheduler = createEmbedScheduler();
    const order: string[] = [];
    const background1 = scheduler.enqueue("background", async () => {
      order.push("bg1-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("bg1-end");
    });
    let resolveQuery!: () => void;
    const queryStarted = new Promise<void>((resolve) => { resolveQuery = resolve; });
    const query = scheduler.enqueue("foreground", async () => {
      resolveQuery();
      order.push("fg");
    });
    const background2 = scheduler.enqueue("background", async () => {
      order.push("bg2");
    });
    await queryStarted;
    await Promise.all([background1, query, background2]);
    expect(order.indexOf("fg")).toBeLessThan(order.indexOf("bg2"));
    expect(order.indexOf("bg1-end")).toBeLessThan(order.indexOf("fg"));
  });

  it("masks disk vectors immediately and does not mix overlay gaps with missing bodies", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "varin-overlay-"));
    dirs.push(dataDir);
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    writeFileSync(join(documents.workspaceRoot, "draft.ts"), "export const staleDisk = \"old pineapple\";\n", "utf8");
    const runtime = createSemanticIndexRuntime({
      dataDir,
      hostId: "host",
      documents: documents.authority,
      structureSource: createStructureSource([createTreeSitterStructureProvider({ parseBudgetMs: 5_000 })]),
      searchFilesystemFiles: async () => [{
        name: "draft.ts",
        path: join(documents.workspaceRoot, "draft.ts"),
        relativePath: "draft.ts",
      }],
      embedder: createHashEmbedder(),
    });
    disposes.push(() => runtime.dispose());
    const scope = workspaceScope(documents.identity.workspaceId);
    await runtime.scanScope(scope);
    const disk = await runtime.search(scope, "old pineapple", 4);
    expect(disk.hits[0]?.documentId).toBe("draft.ts");
    const masked = await runtime.search(scope, "old pineapple", 4, {
      overlays: [{
        path: "draft.ts",
        content: "export const freshDraft = \"new coconut\";\n",
        revision: "surface-draft:1",
        origin: "surface-draft",
      }],
    });
    expect(masked.hits.some((hit) => hit.body.includes("old pineapple"))).toBe(false);
    expect(masked.hits.some((hit) => hit.documentId === "draft.ts")).toBe(false);
    expect(masked.gaps).toContainEqual({ path: "draft.ts", reason: "draft-vector-pending" });
    await runtime.drain();
    const readyDraft = await runtime.search(scope, "new coconut", 4, {
      overlays: [{
        path: "draft.ts",
        content: "export const freshDraft = \"new coconut\";\n",
        revision: "surface-draft:1",
        origin: "surface-draft",
      }],
    });
    expect(readyDraft.hits.some((hit) => hit.body.includes("new coconut"))).toBe(true);

    const view = await pinSemanticQueryView({
      inputContext: {
        source: "surface",
        roots: [{ workspaceId: "ws", dirtyPaths: ["missing.ts"] }],
        snapshot: { status: "unavailable", reason: "surface-unavailable" },
      },
      draftPaths: ["missing.ts"],
      readDraft: () => ({ status: "unavailable" }),
    });
    expect(view.overlays[0]?.gap).toBe("draft-unavailable");
    expect(view.overlays[0]?.content).toBeNull();
  });

  it("still applies scoped Top-K after a query vector cache hit", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "varin-cache-scope-"));
    dirs.push(dataDir);
    const embedder = {
      status: "ready" as const,
      space: {
        provider: "test",
        model: "cache-scope",
        modelRevision: "r1",
        dim: 2,
        pooling: "mean" as const,
        normalize: true,
        maxTokens: 32,
      },
      prepare: async () => undefined,
      countTokens: (text: string) => Math.max(1, text.length),
      embed: async (texts: readonly string[]) => texts.map((text) => (
        text.includes("outside") ? [1, 0] : [0.2, 0.8]
      )),
      embedBatch: async () => ({ batchId: "x", space: embedder.space, items: [] }),
    };
    const store = createSemanticGenerationStore({
      dataDir,
      hostId: "host",
      scope: workspaceScope("ws-cache"),
      embedder,
    });
    disposes.push(() => store.close());
    await store.publishDocuments([
      { documentId: "outside/a.ts", revision: "r1", chunks: [chunk("outside/a.ts", "outside")] },
      { documentId: "allowed/b.ts", revision: "r1", chunks: [chunk("allowed/b.ts", "inside")] },
    ]);
    const cache = createVectorCache();
    const query = [1, 0];
    cache.set({ spaceId: store.spaceId, purpose: "query", embedText: "question" }, query);
    expect(cache.get({ spaceId: store.spaceId, purpose: "query", embedText: "question" })).toEqual(query);
    expect((await store.search(query, 1, ["allowed"]))[0]?.documentId).toBe("allowed/b.ts");
  });

  it("does not let an older revision overwrite a newer publication", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "varin-revision-"));
    dirs.push(dataDir);
    const store = createSemanticGenerationStore({
      dataDir,
      hostId: "host",
      scope: workspaceScope("ws-rev"),
      embedder: createHashEmbedder(),
    });
    disposes.push(() => store.close());
    await store.publishDocument({
      documentId: "src/a.ts",
      revision: "r2",
      chunks: [chunk("src/a.ts", "newer coconut")],
      publishToken: 2,
    });
    await store.publishDocument({
      documentId: "src/a.ts",
      revision: "r1",
      chunks: [chunk("src/a.ts", "older pineapple")],
      publishToken: 1,
    });
    const hits = await store.search(hashEmbed("newer coconut", 384), 4);
    expect(hits[0]?.revision).toBe("r2");
    expect(hits.some((hit) => hit.body.includes("older pineapple"))).toBe(false);
    await store.removeDocument("src/a.ts", 1);
    expect((await store.search(hashEmbed("newer coconut", 384), 4))[0]?.revision).toBe("r2");
  });

  it("does not let an embedding already in flight resurrect a later deletion", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "varin-delete-race-"));
    dirs.push(dataDir);
    const base = createHashEmbedder();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const delayed = {
      ...base,
      embed: async (texts: readonly string[]) => {
        entered();
        await new Promise<void>((resolve) => { release = resolve; });
        return base.embed(texts);
      },
    };
    const store = createSemanticGenerationStore({
      dataDir, hostId: "host", scope: workspaceScope("ws-delete-race"), embedder: delayed,
    });
    disposes.push(() => store.close());
    const oldPublish = store.publishDocument({
      documentId: "src/a.ts", revision: "r1", chunks: [chunk("src/a.ts", "old body")], publishToken: 1,
    });
    await started;
    await store.removeDocument("src/a.ts", 2);
    release();
    await oldPublish;
    expect(await store.listDocumentIds()).toEqual([]);
  });

  it("uses the remote space for both publish and query and does not mix local vectors", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "varin-remote-space-"));
    dirs.push(dataDir);
    const configurationId = "remote-config-1";
    const remote = createRemoteEmbedder({
      binding: { protocol: "openai-compatible", providerId: "openai", modelId: "text-embedding-3-small", dimensions: 2, configurationId },
      client: {
        embed: async (params) => ({
          batchId: params.batchId,
          space: {
            providerId: "openai",
            modelId: "text-embedding-3-small",
            protocol: "openai-compatible",
            configurationId,
            dim: 2,
            maxTokens: 8192,
            spaceId: remoteEmbeddingSpaceId({
              protocol: "openai-compatible",
              providerId: "openai",
              modelId: "text-embedding-3-small",
              configurationId,
              maxTokens: 8192,
              dimensions: 2,
            }),
          },
          items: params.items.map((item, index) => ({
            id: item.id,
            index,
            vector: item.text.includes("remote") ? [1, 0] : [0, 1],
          })),
        }),
      },
    });
    const store = createSemanticGenerationStore({
      dataDir,
      hostId: "host",
      scope: workspaceScope("ws-remote"),
      embedder: remote,
    });
    disposes.push(() => store.close());
    await store.publishDocument({
      documentId: "src/a.ts",
      revision: "r1",
      chunks: [chunk("src/a.ts", "remote unique token")],
    });
    const [query] = await remote.embed(["remote unique token"], { purpose: "query" });
    const hits = await store.search(query!, 4);
    expect(hits[0]?.spaceId).toBe(remote.space.spaceId);
    expect(hits[0]?.documentId).toBe("src/a.ts");
    expect(remote.space.dim).toBe(2);
    expect(remote.space.maxTokens).toBe(8192);
  });

  it("freezes an automatically resolved remote dimension before an opened store can drift", async () => {
    const configurationId = "dimension-config";
    let call = 0;
    const remote = createRemoteEmbedder({
      binding: { protocol: "openai-compatible", providerId: "p", modelId: "m", configurationId },
      client: {
        embed: async (params) => {
          call += 1;
          const dim = call === 1 ? 2 : 3;
          return {
            batchId: params.batchId,
            space: {
              providerId: "p", modelId: "m", protocol: "openai-compatible", configurationId,
              dim, maxTokens: 8192,
              spaceId: remoteEmbeddingSpaceId({
                protocol: "openai-compatible", providerId: "p", modelId: "m", configurationId,
                maxTokens: 8192, dimensions: dim,
              }),
            },
            items: params.items.map((item, index) => ({ id: item.id, index, vector: new Array(dim).fill(1) })),
          };
        },
      },
    });
    await remote.embed(["first"], { purpose: "query" });
    const frozenSpace = { dim: remote.space.dim, spaceId: remote.space.spaceId };
    await expect(remote.embed(["second"], { purpose: "query" })).rejects.toThrow(/dimension changed/);
    expect({ dim: remote.space.dim, spaceId: remote.space.spaceId }).toEqual(frozenSpace);
  });

  it("does not fall back to the local MiniLM space when a remote binding is configured", () => {
    const local = createHashEmbedder();
    const backend = createSemanticBackend({ local });
    const embedder = backend.bind({
      protocol: "openai-compatible",
      providerId: "openai",
      modelId: "text-embedding-3-small",
      configurationId: "unavailable-config",
    });
    expect(backend.kind).toBe("remote");
    expect(embedder.status).toBe("unavailable");
    expect(embedder.space.model).toBe(local.space.model);
    expect(backend.local).toBe(local);
    backend.replaceLocal(createHashEmbedder({ ...local.space, modelRevision: "new-local-component" }));
    expect(backend.embedder).toBe(embedder);
    expect(backend.kind).toBe("remote");
  });

  it("keeps the model identity held by a query when a local component is replaced", () => {
    const previous = createHashEmbedder();
    const backend = createSemanticBackend({ local: previous });
    const queryEmbedder = backend.embedder;
    const next = createHashEmbedder({ ...previous.space, modelRevision: "new-local-component" });
    backend.replaceLocal(next);
    expect(backend.embedder).toBe(next);
    expect(queryEmbedder.space.modelRevision).toBe("test-hash");
  });

  it("treats a dirty path without a body as an immediate disk mask, not a missing body", async () => {
    const deleted = await pinSemanticQueryView({
      inputContext: {
        source: "surface",
        roots: [{ workspaceId: "ws", dirtyPaths: ["gone.ts"] }],
        snapshot: { status: "ready", ref: "surface" },
      },
      draftPaths: ["gone.ts"],
      readDraft: () => ({ status: "deleted" }),
    });
    expect(deleted.overlays[0]).toMatchObject({ path: "gone.ts", content: null, origin: "surface-draft" });
    expect(deleted.overlays[0]?.gap).toBeUndefined();

    const superseded = await pinSemanticQueryView({
      inputContext: {
        source: "surface",
        roots: [{ workspaceId: "ws", dirtyPaths: ["written.ts"] }],
        snapshot: { status: "ready", ref: "surface" },
      },
      draftPaths: ["written.ts"],
      readDraft: () => ({ status: "disk", superseded: true }),
    });
    expect(superseded.overlays).toEqual([]);
  });

  it("keeps sibling thread overlays from seeing each other's paths", async () => {
    const childA = await pinSemanticQueryView({
      inputContext: { source: "disk" },
      threadDocuments: [
        { path: "src/parent.ts", content: null, revision: "thread-a-missing" },
        { path: "src/a.ts", content: "export const a = \"alpha sibling\";\n", revision: "thread-a" },
      ],
    });
    const childB = await pinSemanticQueryView({
      inputContext: { source: "disk" },
      threadDocuments: [
        { path: "src/parent.ts", content: "export const parent = \"parent drift\";\n", revision: "thread-b-parent" },
        { path: "src/b.ts", content: "export const b = \"beta sibling\";\n", revision: "thread-b" },
      ],
    });
    expect(childA.view).toBe("working-state");
    expect(childA.overlays.some((overlay) => overlay.path === "src/b.ts")).toBe(false);
    expect(childB.overlays.some((overlay) => overlay.path === "src/a.ts")).toBe(false);
  });

  it("merges concurrent scans of the same scope and recovers a published checkpoint", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    writeFileSync(join(documents.workspaceRoot, "keep.ts"), "export const keep = \"checkpoint pineapple\";\n", "utf8");
    const dataDir = mkdtempSync(join(tmpdir(), "varin-scan-merge-"));
    dirs.push(dataDir);
    let embeds = 0;
    const base = createHashEmbedder();
    const embedder = {
      ...base,
      embed: async (texts: readonly string[]) => {
        embeds += 1;
        return base.embed(texts);
      },
    };
    const first = createSemanticIndexRuntime({
      dataDir,
      hostId: "restart-host",
      documents: documents.authority,
      structureSource: createStructureSource([createTreeSitterStructureProvider({ parseBudgetMs: 5_000 })]),
      searchFilesystemFiles: async () => [{
        name: "keep.ts",
        path: join(documents.workspaceRoot, "keep.ts"),
        relativePath: "keep.ts",
      }],
      embedder,
    });
    const scope = workspaceScope(documents.identity.workspaceId);
    await Promise.all([first.scanScope(scope), first.scanScope(scope)]);
    expect(embeds).toBe(1);
    const before = await first.search(scope, "checkpoint pineapple", 4);
    expect(before.hits[0]?.documentId).toBe("keep.ts");
    await first.dispose();

    const restarted = createSemanticIndexRuntime({
      dataDir,
      hostId: "restart-host",
      documents: documents.authority,
      structureSource: createStructureSource([createTreeSitterStructureProvider({ parseBudgetMs: 5_000 })]),
      searchFilesystemFiles: async () => [{
        name: "keep.ts",
        path: join(documents.workspaceRoot, "keep.ts"),
        relativePath: "keep.ts",
      }],
      embedder: createHashEmbedder(),
    });
    disposes.push(() => restarted.dispose());
    const after = await restarted.search(scope, "checkpoint pineapple", 4, { waitForFirstPublish: false });
    expect(after.status.coverage === "partial" || after.status.coverage === "complete").toBe(true);
    expect(after.hits[0]?.documentId).toBe("keep.ts");
  });

  it("can query a partial generation after the first published batch", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const files = Array.from({ length: 9 }, (_, index) => `f${index}.ts`);
    for (const [index, file] of files.entries()) {
      writeFileSync(
        join(documents.workspaceRoot, file),
        `export const value_${index} = "${index === 0 ? "first batch pineapple" : `later coconut ${index}`}";\n`,
        "utf8",
      );
    }
    const dataDir = mkdtempSync(join(tmpdir(), "varin-partial-"));
    dirs.push(dataDir);
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let batches = 0;
    const base = createHashEmbedder();
    const embedder = {
      ...base,
      embed: async (texts: readonly string[], request?: { purpose?: "document" | "query" }) => {
        if (request?.purpose === "query") return base.embed(texts);
        batches += 1;
        if (batches > 1) await secondGate;
        return base.embed(texts);
      },
    };
    const runtime = createSemanticIndexRuntime({
      dataDir,
      hostId: "partial-host",
      documents: documents.authority,
      structureSource: createStructureSource([createTreeSitterStructureProvider({ parseBudgetMs: 5_000 })]),
      searchFilesystemFiles: async () => files.map((name) => ({
        name,
        path: join(documents.workspaceRoot, name),
        relativePath: name,
      })),
      embedder,
    });
    disposes.push(() => runtime.dispose());
    const scope = workspaceScope(documents.identity.workspaceId);
    const scanning = runtime.scanScope(scope);
    const partial = await runtime.search(scope, "first batch pineapple", 4);
    expect(partial.status.coverage).toBe("partial");
    expect(partial.hits[0]?.documentId).toBe("f0.ts");
    releaseSecond();
    await scanning;
  });
});
