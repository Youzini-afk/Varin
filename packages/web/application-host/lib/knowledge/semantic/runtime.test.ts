import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync, unlinkSync, statSync, utimesSync, promises as fsPromises } from "node:fs";
import { join } from "node:path";
import { createDocumentAuthorityHarness } from "../../documents/contract-fixtures.js";
import type { WorkingBranchQuerySnapshot } from "../../harness/working-state/working-branch-query.js";
import { createStructureSource } from "../../structure/source.js";
import { createTreeSitterStructureProvider } from "../../structure/native-provider.test-helper.js";
import { createHashEmbedder } from "./embedder.js";
import { workspaceScope, remoteEmbeddingSpaceId } from "./identity.js";
import { createSemanticIndexRuntime } from "./runtime.js";
import { createRemoteEmbedder } from "./remote-embedder.js";

const disposes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposes.splice(0).reverse()) await dispose();
});

const parsingSource = () => createStructureSource([
  createTreeSitterStructureProvider({ parseBudgetMs: 30_000 }),
]);

const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("semantic index runtime", () => {
  it("indexes a selected child directory without enumerating its multi-project parent", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const child = join(documents.workspaceRoot, "selected-project");
    mkdirSync(child);
    writeFileSync(join(child, "entry.ts"), 'export const marker = "selected project";\n');
    const searchedRoots: string[] = [];
    const runtime = createSemanticIndexRuntime({
      dataDir: documents.dataDir, hostId: "selected-subdirectory", documents: documents.authority,
      structureSource: parsingSource(), embedder: createHashEmbedder(), indexDirectories: [child],
      searchFilesystemFiles: async (root) => {
        searchedRoots.push(root);
        return [{ name: "entry.ts", path: join(child, "entry.ts"), relativePath: "entry.ts" }];
      },
    });
    disposes.push(() => runtime.dispose());
    const scope = workspaceScope(documents.identity.workspaceId);
    await runtime.scanScope(scope);
    const result = await runtime.search(scope, "selected project", 5);
    expect(searchedRoots).toEqual([await fsPromises.realpath(child)]);
    expect(result.hits.map((hit) => hit.documentId)).toContain("selected-project/entry.ts");
  });

  it("does not report an aborted background update as an indexing failure", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const onError = vi.fn();
    const runtime = createSemanticIndexRuntime({
      dataDir: documents.dataDir,
      hostId: "cancelled-index-update",
      documents: {
        inspectWorkspace: async () => { throw new DOMException("This operation was aborted", "AbortError"); },
        read: documents.authority.read,
      },
      structureSource: parsingSource(),
      embedder: createHashEmbedder(),
      onError,
    });
    disposes.push(() => runtime.dispose());
    runtime.observeDocumentMutation({ workspaceId: documents.identity.workspaceId, resourceId: "src/file.ts", kind: "modified" });
    await runtime.drain();
    expect(onError).not.toHaveBeenCalled();
  });

  it("builds a virtual-thread semantic overlay from native fixed-view units without reading whole file bodies", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const native = parsingSource();
    let fixedCalls = 0;
    let bodyReads = 0;
    const structureSource = {
      ...native,
      unitsFixed: async (request: Parameters<NonNullable<typeof native.unitsFixed>>[0]) => {
        fixedCalls += 1;
        expect(request.path).toBe("src/thread.ts");
        expect(request.languageId).toBe("typescript");
        expect(request.compute).toBe(threadQuery.compute);
        return {
          status: "ready" as const,
          revision: "rev-thread",
          units: [{
            startLine: 1,
            endLine: 1,
            parentName: "threadValue",
            parentKind: "function",
            parentSignature: "export function threadValue()",
            docComments: "",
            text: "export function threadValue() { return 'fixed thread token'; }",
            fallback: false,
          }],
        };
      },
    };
    const threadQuery: WorkingBranchQuerySnapshot = {
      sessionId: "thread-session",
      workspaceId: documents.identity.workspaceId,
      branchId: "thread-branch",
      writeRevision: 1,
      revision: 0,
      root: "sha256-thread-root",
      pinId: "thread-pin",
      async compute() { throw new Error("custom unitsFixed owns the compute assertion"); },
      async listFiles() { return [{ path: "src/thread.ts", revision: "rev-thread" }]; },
      async search() { return { status: "empty", generation: undefined }; },
      async readFile() { bodyReads += 1; throw new Error("semantic fixed-view ingestion must not read full bodies"); },
      async release() { /* caller owns this query pin */ },
    };
    const runtime = createSemanticIndexRuntime({
      dataDir: documents.dataDir,
      hostId: "fixed-thread-overlay",
      documents: documents.authority,
      structureSource,
      embedder: createHashEmbedder(),
    });
    disposes.push(() => runtime.dispose());
    const scope = workspaceScope(documents.identity.workspaceId);

    const first = await runtime.search(scope, "fixed thread token", 5, {
      threadQuery,
      view: "working-state",
      waitForFirstPublish: false,
    });
    expect(first.gaps).toEqual([{ path: "src/thread.ts", reason: "thread-vector-pending" }]);
    await runtime.drain();
    const second = await runtime.search(scope, "fixed thread token", 5, {
      threadQuery,
      view: "working-state",
      waitForFirstPublish: false,
    });
    expect(second.hits[0]?.documentId).toBe("src/thread.ts");
    expect(second.hits[0]?.body).toContain("fixed thread token");
    expect(bodyReads).toBe(0);
    expect(fixedCalls).toBeGreaterThanOrEqual(2);
  });

  it("indexes a workspace on disk and stays unavailable when the model pack is missing", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    writeFileSync(join(documents.workspaceRoot, "ready.ts"), [
      "export function publishedZebra() {",
      "  return \"published zebra token\";",
      "}",
    ].join("\n"), "utf8");

    const ready = createHashEmbedder();
    const runtime = createSemanticIndexRuntime({
      dataDir: documents.dataDir,
      hostId: "semantic-host",
      documents: documents.authority,
      structureSource: parsingSource(),
      searchFilesystemFiles: async () => [{
        name: "ready.ts",
        path: join(documents.workspaceRoot, "ready.ts"),
        relativePath: "ready.ts",
      }],
      embedder: ready,
    });
    disposes.push(() => runtime.dispose());
    await runtime.scanScope(workspaceScope(documents.identity.workspaceId));
    const found = await runtime.search(workspaceScope(documents.identity.workspaceId), "published zebra token", 8);
    expect(found.status.coverage).toBe("complete");
    expect(found.status.lifecycle).toBe("ready");
    expect(found.hits[0]?.documentId).toBe("ready.ts");

    const missing = createHashEmbedder();
    missing.status = "unavailable";
    const dark = createSemanticIndexRuntime({
      dataDir: documents.dataDir,
      hostId: "semantic-host-dark",
      documents: documents.authority,
      structureSource: parsingSource(),
      searchFilesystemFiles: async () => [{
        name: "ready.ts",
        path: join(documents.workspaceRoot, "ready.ts"),
        relativePath: "ready.ts",
      }],
      embedder: missing,
    });
    disposes.push(() => dark.dispose());
    await dark.scanScope(workspaceScope(documents.identity.workspaceId));
    const status = dark.statusFor(workspaceScope(documents.identity.workspaceId));
    expect(status.status).toBe("unavailable");
    expect((await dark.search(workspaceScope(documents.identity.workspaceId), "published zebra token", 8)).hits).toEqual([]);
  });

  it("omits semantic hits whose indexed document changed after the last scan", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const filePath = join(documents.workspaceRoot, "changed.ts");
    writeFileSync(filePath, 'export function changed() { return "old indexed needle"; }\n', "utf8");
    const originalStat = statSync(filePath);
    const runtime = createSemanticIndexRuntime({
      dataDir: documents.dataDir,
      hostId: "semantic-hit-version",
      documents: documents.authority,
      structureSource: parsingSource(),
      searchFilesystemFiles: async () => [{ name: "changed.ts", path: filePath, relativePath: "changed.ts", metadata: { byteLength: String(originalStat.size), modifiedTimeNs: "same-stat" } }],
      embedder: createHashEmbedder(),
    });
    disposes.push(() => runtime.dispose());
    const scope = workspaceScope(documents.identity.workspaceId);
    await runtime.scanScope(scope);
    expect((await runtime.search(scope, "old indexed needle", 8)).hits[0]?.documentId).toBe("changed.ts");

    writeFileSync(filePath, 'export function changed() { return "new indexed phrase"; }\n', "utf8");
    utimesSync(filePath, originalStat.atime, originalStat.mtime);
    await runtime.scanScope(scope);
    const result = await runtime.search(scope, "old indexed needle", 8);

    expect(result.hits).toEqual([]);
    expect(result.status.status).toBe("incomplete");
    expect(result.gaps).toContainEqual({ path: "changed.ts", reason: "content-changed" });
    await runtime.drain();
    expect((await runtime.search(scope, "new indexed phrase", 8)).hits[0]?.body).toContain("new indexed phrase");
  });

  it("uses inventory metadata to skip stable bodies while discovering a new file", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const oldPath = join(documents.workspaceRoot, "old.ts");
    const newPath = join(documents.workspaceRoot, "new.ts");
    writeFileSync(oldPath, 'export const oldValue = "existing marker";\n', "utf8");
    const metadata = { byteLength: String(Buffer.byteLength('export const oldValue = "existing marker";\n')), modifiedTimeNs: "stable" };
    let inventory = [{ name: "old.ts", path: oldPath, relativePath: "old.ts", metadata }];
    const native = parsingSource();
    const processed: string[] = [];
    const runtime = createSemanticIndexRuntime({
      dataDir: documents.dataDir,
      hostId: "semantic-metadata-inventory",
      documents: documents.authority,
      structureSource: {
        ...native,
        unitsFile: async (request) => {
          processed.push(request.path);
          return native.unitsFile!(request);
        },
      },
      searchFilesystemFiles: async (_root, request) => {
        expect(request.includeRevisions).toBeUndefined();
        return inventory;
      },
      embedder: createHashEmbedder(),
    });
    disposes.push(() => runtime.dispose());
    const scope = workspaceScope(documents.identity.workspaceId);

    await runtime.scanScope(scope);
    inventory = [
      ...inventory,
      { name: "new.ts", path: newPath, relativePath: "new.ts", metadata: { byteLength: String(Buffer.byteLength('export const newValue = "newly discovered marker";\n')), modifiedTimeNs: "new" } },
    ];
    writeFileSync(newPath, 'export const newValue = "newly discovered marker";\n', "utf8");
    await runtime.scanScope(scope);

    expect(processed).toEqual(["old.ts", "new.ts"]);
    const found = await runtime.search(scope, "newly discovered marker", 1);
    expect(found.hits[0]?.documentId).toBe("new.ts");
    expect(found.gaps).toContainEqual({ path: ".", reason: "index-watch-unavailable" });
    expect(found.status.coverage).toBe("partial");
    expect(found.status.status).toBe("incomplete");
    await runtime.scanScope(scope, { forceContentVerification: true });
    expect(processed).toEqual(["old.ts", "new.ts", "old.ts", "new.ts"]);
    const verified = await runtime.search(scope, "newly discovered marker", 1);
    expect(verified.status.coverage).toBe("complete");
    expect(verified.gaps).toEqual([]);
  });

  it("increments from Documents revisions and can sit at partial coverage", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    writeFileSync(join(documents.workspaceRoot, "one.ts"), "export function one() { return \"alpha unique\"; }\n", "utf8");
    writeFileSync(join(documents.workspaceRoot, "two.ts"), "export function two() { return \"beta unique\"; }\n", "utf8");
    const embedder = createHashEmbedder();
    const runtime = createSemanticIndexRuntime({
      dataDir: documents.dataDir,
      hostId: "semantic-host",
      documents: documents.authority,
      structureSource: parsingSource(),
      searchFilesystemFiles: async () => [{
        name: "one.ts",
        path: join(documents.workspaceRoot, "one.ts"),
        relativePath: "one.ts",
      }],
      embedder,
    });
    disposes.push(() => runtime.dispose());
    await runtime.scanScope(workspaceScope(documents.identity.workspaceId));
    expect((await runtime.search(workspaceScope(documents.identity.workspaceId), "alpha unique", 8)).hits[0]?.documentId).toBe("one.ts");
    expect((await runtime.search(workspaceScope(documents.identity.workspaceId), "beta unique", 8)).hits.some((hit) => hit.documentId === "two.ts")).toBe(false);

    runtime.observeDocumentMutation({
      workspaceId: documents.identity.workspaceId,
      resourceId: "one.ts",
      kind: "modified",
      owner: { kind: "web-route", id: "editor" },
    });
    await runtime.drain();
    writeFileSync(join(documents.workspaceRoot, "one.ts"), "export function one() { return \"alpha unique changed\"; }\n", "utf8");
    runtime.observeDocumentMutation({
      workspaceId: documents.identity.workspaceId,
      resourceId: "one.ts",
      kind: "modified",
      owner: { kind: "web-route", id: "editor" },
    });
    await runtime.drain();
    const again = await runtime.search(workspaceScope(documents.identity.workspaceId), "alpha unique changed", 8);
    expect(again.hits[0]?.documentId).toBe("one.ts");
  });

  it("prepares a filesystem batch before one embedding publication", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const files = ["one.ts", "two.ts"];
    for (const [index, file] of files.entries()) {
      writeFileSync(join(documents.workspaceRoot, file), `export const value_${index} = ${index};\n`, "utf8");
    }
    const base = createHashEmbedder();
    const embedCalls: string[][] = [];
    const embedder = {
      ...base,
      embed: async (texts: readonly string[]) => {
        embedCalls.push([...texts]);
        return base.embed(texts);
      },
    };
    const runtime = createSemanticIndexRuntime({
      dataDir: documents.dataDir,
      hostId: "semantic-host-batch",
      documents: documents.authority,
      structureSource: parsingSource(),
      searchFilesystemFiles: async () => files.map((name) => ({
        name,
        path: join(documents.workspaceRoot, name),
        relativePath: name,
      })),
      embedder,
    });
    disposes.push(() => runtime.dispose());

    const scope = workspaceScope(documents.identity.workspaceId);
    const progress: Array<{ processedFiles: number; totalFiles: number; publishedDocuments: number }> = [];
    await runtime.scanScope(scope, { onBatchComplete: (sample) => progress.push(sample) });
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]).toHaveLength(2);
    expect(progress).toEqual([{ processedFiles: 2, totalFiles: 2, publishedDocuments: 2 }]);
    expect(runtime.statusFor(scope).coverage).toBe("complete");
  });

  it("stops waiting for an in-flight query embedding when the caller cancels", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const base = createHashEmbedder();
    let resolveEmbedding!: (vectors: number[][]) => void;
    const embedding = new Promise<number[][]>((resolve) => { resolveEmbedding = resolve; });
    const runtime = createSemanticIndexRuntime({
      dataDir: documents.dataDir,
      hostId: "semantic-host-cancel",
      documents: documents.authority,
      structureSource: parsingSource(),
      embedder: { ...base, embed: async () => embedding },
    });
    disposes.push(() => runtime.dispose());
    const controller = new AbortController();
    const pending = runtime.search(
      workspaceScope(documents.identity.workspaceId),
      "cancel this query",
      8,
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    resolveEmbedding([new Array(base.space.dim).fill(0)]);
  });

  it("does not reveal an older publication while the next edit is still being embedded", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const file = join(documents.workspaceRoot, "edit.ts");
    writeFileSync(file, 'export const value = "initial";');
    const enteredOne = gate(), enteredTwo = gate(), releaseOne = gate(), releaseTwo = gate();
    const base = createHashEmbedder();
    const runtime = createSemanticIndexRuntime({
      dataDir: documents.dataDir, hostId: "edit-race", documents: documents.authority, structureSource: parsingSource(),
      searchFilesystemFiles: async () => [{ name: "edit.ts", path: file, relativePath: "edit.ts" }],
      embedder: { ...base, embed: async (texts, request) => {
        if (request?.purpose === "document" && texts.some((text) => text.includes("version-one"))) {
          enteredOne.resolve(); await releaseOne.promise;
        }
        if (request?.purpose === "document" && texts.some((text) => text.includes("version-two"))) {
          enteredTwo.resolve(); await releaseTwo.promise;
        }
        return base.embed(texts, request);
      } },
    });
    disposes.push(() => runtime.dispose());
    const scope = workspaceScope(documents.identity.workspaceId);
    const mutate = () => runtime.observeDocumentMutation({ workspaceId: scope.scopeId, resourceId: "edit.ts", kind: "modified", owner: { kind: "web-route", id: "editor" } });
    try {
      await runtime.scanScope(scope);
      await runtime.search(scope, "value", 5); // Reuse the query vector while the document batch is held.
      writeFileSync(file, 'export const value = "version-one";'); mutate();
      await enteredOne.promise;
      writeFileSync(file, 'export const value = "version-two";'); mutate();
      releaseOne.resolve();
      await enteredTwo.promise;
      const during = await runtime.search(scope, "value", 5);
      expect(during.hits).toEqual([]);
      expect(during.status.status).toBe("incomplete");
      releaseTwo.resolve(); await runtime.drain();
      expect((await runtime.search(scope, "value", 5)).hits[0]?.body).toContain("version-two");
    } finally { releaseOne.resolve(); releaseTwo.resolve(); }
  });

  it("keeps read failures explicit, masks the old body, and recovers after a successful rescan", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const file = join(documents.workspaceRoot, "read.ts");
    writeFileSync(file, 'export const secret = "old current body";');
    let fail = false;
    const nativeStructure = parsingSource();
    const runtime = createSemanticIndexRuntime({
      dataDir: documents.dataDir, hostId: "read-failure", embedder: createHashEmbedder(), documents: documents.authority,
      structureSource: {
        ...nativeStructure,
        unitsFile: async (input) => fail
          ? { status: "failed", revision: "", units: [], message: "native read failed" }
          : nativeStructure.unitsFile!(input),
      },
      searchFilesystemFiles: async () => [{ name: "read.ts", path: file, relativePath: "read.ts" }],
    });
    disposes.push(() => runtime.dispose());
    const scope = workspaceScope(documents.identity.workspaceId);
    await runtime.scanScope(scope);
    fail = true; await runtime.scanScope(scope);
    const failed = await runtime.search(scope, "body", 5);
    expect(failed.hits).toEqual([]);
    expect(failed.status.status).toBe("incomplete");
    expect(failed.gaps).toEqual([{ path: "read.ts", reason: "index-read-failed" }]);
    fail = false; await runtime.scanScope(scope);
    const recovered = await runtime.search(scope, "body", 5);
    expect(recovered.status.coverage).toBe("complete");
    expect(recovered.gaps).toEqual([]);
    expect(recovered.hits[0]?.documentId).toBe("read.ts");
  });

  it("does not delete a later mutation using an older empty catalog", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const file = join(documents.workspaceRoot, "later.ts");
    writeFileSync(file, 'export const value = "old";');
    const listingEntered = gate(), releaseListing = gate();
    let first = true;
    const runtime = createSemanticIndexRuntime({
      dataDir: documents.dataDir, hostId: "catalog-race", documents: documents.authority, structureSource: parsingSource(), embedder: createHashEmbedder(),
      searchFilesystemFiles: async () => {
        if (first) { first = false; return [{ name: "later.ts", path: file, relativePath: "later.ts" }]; }
        listingEntered.resolve(); await releaseListing.promise; return [];
      },
    });
    disposes.push(() => runtime.dispose());
    const scope = workspaceScope(documents.identity.workspaceId);
    await runtime.scanScope(scope);
    const scan = runtime.scanScope(scope);
    try {
      await listingEntered.promise;
      writeFileSync(file, 'export const value = "newly-created";');
      runtime.observeDocumentMutation({ workspaceId: scope.scopeId, resourceId: "later.ts", kind: "modified", owner: { kind: "web-route", id: "editor" } });
      releaseListing.resolve(); await scan; await runtime.drain();
      expect((await runtime.search(scope, "newly-created", 5)).hits[0]?.body).toContain("newly-created");
    } finally { releaseListing.resolve(); }
  });

  it("reconciles an empty cold catalog after a real query resolves the remote dimension", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const file = join(documents.workspaceRoot, "gone.ts");
    writeFileSync(file, 'export const gone = "previous process";');
    const requests: string[][] = [];
    const remote = () => createRemoteEmbedder({
      binding: { protocol: "openai-compatible", providerId: "p", modelId: "m", configurationId: "c" },
      client: { embed: async (input) => {
        requests.push(input.items.map((item) => item.text));
        return { batchId: input.batchId, space: { providerId: "p", modelId: "m", protocol: "openai-compatible", configurationId: "c", dim: 2, maxTokens: 8192,
          spaceId: remoteEmbeddingSpaceId({ protocol: "openai-compatible", providerId: "p", modelId: "m", configurationId: "c", dimensions: 2, maxTokens: 8192 }) },
        items: input.items.map((item, index) => ({ id: item.id, index, vector: [1, 0] })) };
      } },
    });
    const scope = workspaceScope(documents.identity.workspaceId);
    const first = createSemanticIndexRuntime({ dataDir: documents.dataDir, hostId: "empty-restart", documents: documents.authority, structureSource: parsingSource(), embedder: remote(),
      searchFilesystemFiles: async () => [{ name: "gone.ts", path: file, relativePath: "gone.ts" }],
    });
    await first.scanScope(scope); await first.dispose(); unlinkSync(file); requests.length = 0;
    const restarted = createSemanticIndexRuntime({ dataDir: documents.dataDir, hostId: "empty-restart", documents: documents.authority, structureSource: parsingSource(), embedder: remote(), searchFilesystemFiles: async () => [] });
    disposes.push(() => restarted.dispose());
    await restarted.scanScope(scope);
    expect(requests).toEqual([]);
    const result = await restarted.search(scope, "real query", 5);
    expect(requests).toEqual([["real query"]]);
    expect(result.hits).toEqual([]);
    expect(result.status.coverage).toBe("complete");
  });

  it("keeps the selected backend when configuration changes during a query", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const selected = createHashEmbedder();
    let current = selected;
    const runtime = createSemanticIndexRuntime({ dataDir: documents.dataDir, hostId: "fixed-query", documents: documents.authority, structureSource: parsingSource(), embedder: selected, getEmbedder: () => current });
    disposes.push(() => runtime.dispose());
    const query = runtime.search(workspaceScope(documents.identity.workspaceId), "query", 5);
    current = { ...selected, space: { ...selected.space, dim: 0 }, status: "unavailable" };
    expect((await query).status.status).toBe("empty");
  });

  it("checks mutation eligibility before reading or sending a document and limits draft inputs to roots", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const base = createHashEmbedder();
    const sent: string[] = [];
    let nativeReads = 0;
    const nativeStructure = parsingSource();
    const runtime = createSemanticIndexRuntime({ dataDir: documents.dataDir, hostId: "eligible",
      documents: documents.authority,
      structureSource: { ...nativeStructure, unitsFile: async (input) => { nativeReads++; return nativeStructure.unitsFile!(input); } },
      isIndexablePath: async () => false,
      embedder: { ...base, embed: async (texts, request) => { sent.push(...texts); return base.embed(texts, request); } },
    });
    disposes.push(() => runtime.dispose());
    const scope = workspaceScope(documents.identity.workspaceId);
    runtime.observeDocumentMutation({ workspaceId: scope.scopeId, resourceId: "ignored.ts", kind: "modified", owner: { kind: "web-route", id: "editor" } });
    await runtime.drain();
    expect(nativeReads).toBe(0); expect(sent).toEqual([]);
    await runtime.search(scope, "question", 5, { roots: ["src"], overlays: [{ path: "outside.ts", content: "do not embed", revision: "1", origin: "surface-draft" }] });
    await runtime.drain();
    expect(sent).toEqual(["question"]);
  });

  it("shares draft construction and finishes it after the query's source window closes", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const base = createHashEmbedder();
    const entered = gate(), release = gate();
    let draftCalls = 0;
    const runtime = createSemanticIndexRuntime({ dataDir: documents.dataDir, hostId: "draft-lifetime", documents: documents.authority, structureSource: parsingSource(),
      embedder: { ...base, embed: async (texts, request) => {
        if (request?.purpose === "document") {
          draftCalls++; entered.resolve(); await release.promise;
          request.signal?.throwIfAborted();
        }
        return base.embed(texts, request);
      } },
    });
    disposes.push(() => runtime.dispose());
    const source = new AbortController();
    const scope = workspaceScope(documents.identity.workspaceId);
    const overlays = [{ path: "draft.ts", content: 'export const draft = "captured body";', revision: "fixed-1", origin: "surface-draft" as const }];
    try {
      const first = await runtime.search(scope, "captured body", 5, { overlays, signal: source.signal });
      await entered.promise;
      expect(first.gaps[0]?.reason).toBe("draft-vector-pending");
      source.abort();
      await runtime.search(scope, "captured body", 5, { overlays });
      release.resolve(); await runtime.drain();
      const next = await runtime.search(scope, "captured body", 5, { overlays });
      expect(draftCalls).toBe(1);
      expect(next.gaps).toEqual([]);
      expect(next.hits[0]?.body).toContain("captured body");
    } finally { release.resolve(); }
  });
});
