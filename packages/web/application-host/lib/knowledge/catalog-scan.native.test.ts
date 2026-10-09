import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDocumentAuthorityHarness } from "../documents/contract-fixtures.js";
import { revisionFromBytes } from "../documents/inspect.js";
import { createFsSearchRuntime } from "../fs/search.js";
import { createNativeComputeTestHarness } from "../kernel/compute.test-helper.js";
import { createStructureSource } from "../structure/source.js";
import { createTreeSitterStructureProvider } from "../structure/native-provider.test-helper.js";
import { openWorkspaceKnowledge, type KnowledgeStore } from "./store.js";
import { createSymbolGraphRuntime } from "./symbol-runtime.js";
import { CATALOG_EXTRACTOR_VERSION } from "./symbols.js";

const disposes: Array<() => Promise<void>> = [];
const kernelCompute = createNativeComputeTestHarness();
afterAll(() => kernelCompute.dispose());
afterEach(async () => {
  for (const dispose of disposes.splice(0).reverse()) await dispose();
});

const parsingSource = () => createStructureSource([
  createTreeSitterStructureProvider({ parseBudgetMs: 30_000 }),
]);

describe("cold workspace catalog scan", () => {
  it('reuses persisted file metadata after restart and only hashes unchanged files on an explicit check', async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const options = { dataDir: documents.dataDir, hostId: 'incremental-catalog', workspaceId: documents.identity.workspaceId, embedding: null };
    let store = await openWorkspaceKnowledge(options);
    disposes.push(() => store.close());
    const file = join(documents.workspaceRoot, 'kept.ts');
    writeFileSync(file, 'export function Kept() { return 1; }\n');
    writeFileSync(join(documents.workspaceRoot, 'large-unsupported.bin'), Buffer.alloc(1024 * 1024));
    const search = createFsSearchRuntime({ compute: kernelCompute, path });
    const inventory = vi.fn(search.searchFilesystemFiles);
    const source = parsingSource();
    const analyzeFile = vi.fn(source.analyzeFile!);
    const createRuntime = () => createSymbolGraphRuntime({ getStore: async () => store, documents: documents.authority,
      supervisor: {} as never, structureSource: { ...source, analyzeFile }, searchFilesystemFiles: inventory });
    let runtime = createRuntime();
    disposes.push(() => runtime.dispose());
    await runtime.scanWorkspace(documents.identity.workspaceId);
    expect(inventory.mock.calls[0]?.[1].includeRevisions).toBeUndefined();
    expect(analyzeFile).toHaveBeenCalledTimes(1);
    const generation = (await store.getFileRelations('kept.ts'))?.generation;
    await runtime.dispose(); await store.close();
    store = await openWorkspaceKnowledge(options); runtime = createRuntime();
    analyzeFile.mockClear();
    await runtime.scanWorkspace(documents.identity.workspaceId);
    expect(analyzeFile).not.toHaveBeenCalled();
    await runtime.scanWorkspace(documents.identity.workspaceId, { manual: true });
    expect(analyzeFile).toHaveBeenCalledTimes(1);
    expect(analyzeFile.mock.calls[0]?.[0].unchangedRevision).toBeTruthy();
    expect((await store.getFileRelations('kept.ts'))?.generation).toBe(generation);
    expect((await store.searchSymbols('Kept', 5))[0]?.name).toBe('Kept');
    writeFileSync(file, 'export function Edited() { return 2; }\n');
    runtime.observeDocumentMutation({ workspaceId: documents.identity.workspaceId, resourceId: 'kept.ts',
      kind: 'modified', owner: { kind: 'web-route', id: 'fixture' } });
    await runtime.drain();
    await runtime.dispose(); await store.close();
    store = await openWorkspaceKnowledge(options); runtime = createRuntime();
    analyzeFile.mockClear();
    await runtime.scanWorkspace(documents.identity.workspaceId);
    expect(analyzeFile).not.toHaveBeenCalled();
    expect((await store.searchSymbols('Edited', 5))[0]?.name).toBe('Edited');
  });

  it("indexes unmodified TS and JS files from disk and skips dirty buffers, markdown, and JSON", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const store: KnowledgeStore = await openWorkspaceKnowledge({
      dataDir: documents.dataDir,
      hostId: "catalog-host",
      workspaceId: documents.identity.workspaceId,
      embedding: null,
    });
    disposes.push(async () => { await store.close(); });
    writeFileSync(join(documents.workspaceRoot, "cold.ts"), [
      "import { join } from \"node:path\";",
      "export function coldSymbol() {",
      "  return join(\"a\");",
      "}",
      "export function boot() {",
      "  router.register(\"explore.search\");",
      "  console.log(\"explore.search\");",
      "}",
    ].join("\n"), "utf8");
    writeFileSync(join(documents.workspaceRoot, "notes.md"), "# not a catalog language\n", "utf8");
    writeFileSync(join(documents.workspaceRoot, "pkg.json"), "{\"name\":\"jsOnly\",\"nested\":{\"a\":1}}\n", "utf8");
    mkdirSync(join(documents.workspaceRoot, "src"), { recursive: true });
    writeFileSync(join(documents.workspaceRoot, "src", "cold.js"), [
      "const { join } = require(\"node:path\");",
      "function jsOnly() {",
      "  router.register(\"explore.search\");",
      "  return join(\"a\");",
      "}",
      "module.exports = { jsOnly };",
    ].join("\n"), "utf8");
    writeFileSync(join(documents.workspaceRoot, "src", "Badge.jsx"), [
      "export function Badge() {",
      "  return <span>ok</span>;",
      "}",
    ].join("\n"), "utf8");

    const disk = await documents.authority.read(documents.resource("cold.ts"));
    expect(disk.status).toBe("ready");
    if (disk.status !== "ready") throw new Error("expected disk text");

    await documents.authority.publishDirtyBuffers({
      generation: 1,
      ownerId: "surface",
      resources: [{
        baseRevision: disk.revision,
        localEditRevision: 1,
        resource: documents.resource("cold.ts"),
      }],
      workspaceId: documents.identity.workspaceId,
    });
    await documents.authority.captureAgentInputSnapshot({
      generation: 1,
      ownerId: "surface",
      resources: [{
        baseRevision: disk.revision,
        content: "export function dirtySymbol() { return 1; }\n",
        localEditRevision: 1,
        resource: documents.resource("cold.ts"),
      }],
      sessionId: "catalog-session",
    });

    const readDiskBody = vi.spyOn(documents.authority, "read");
    readDiskBody.mockClear();
    const readAgentInputSnapshot = vi.spyOn(documents.authority, "readAgentInputSnapshot");
    const search = createFsSearchRuntime({ compute: kernelCompute, path });
    const runtime = createSymbolGraphRuntime({
      getStore: async () => store,
      documents: documents.authority,
      supervisor: {
        syncDocument: async () => ({ status: "synced", documentVersion: 1 }),
        documentSymbols: async () => ({ status: "failed", message: "catalog scan must not start a language server" }),
      } as never,
      structureSource: parsingSource(),
      searchFilesystemFiles: search.searchFilesystemFiles,
    });
    disposes.push(() => runtime.dispose());

    const firstScan = runtime.scanWorkspace(documents.identity.workspaceId);
    const duplicateScan = runtime.scanWorkspace(documents.identity.workspaceId);
    expect(duplicateScan).toBe(firstScan);
    await firstScan;
    expect(readDiskBody).not.toHaveBeenCalled();
    expect(readAgentInputSnapshot).not.toHaveBeenCalled();
    expect((await store.searchSymbols("coldSymbol", 5)).map((entry) => entry.name)).toEqual(["coldSymbol"]);
    expect((await store.searchSymbols("dirtySymbol", 5))).toEqual([]);
    expect((await store.searchSymbols("jsOnly", 5)).map((entry) => entry.name)).toEqual(["jsOnly"]);
    expect((await store.searchSymbols("Badge", 5)).map((entry) => entry.name)).toEqual(["Badge"]);
    expect((await store.searchSymbols("name", 5))).toEqual([]);
    const relations = await store.getFileRelations("cold.ts");
    expect(relations).toMatchObject({
      documentRevision: disk.revision,
      danglingEdges: 0,
      imports: [expect.objectContaining({ specifier: "node:path" })],
      connections: [expect.objectContaining({ callee: "register", literal: "explore.search" })],
      associations: expect.arrayContaining([
        expect.objectContaining({ callee: "log", literal: "explore.search" }),
      ]),
    });
    const jsRelations = await store.getFileRelations("src/cold.js");
    expect(jsRelations).toMatchObject({
      danglingEdges: 0,
      imports: [expect.objectContaining({ specifier: "node:path" })],
      connections: [expect.objectContaining({ callee: "register", literal: "explore.search" })],
    });
    expect(await store.getFileRelations("notes.md")).toBeNull();
    expect(await store.getFileRelations("pkg.json")).toBeNull();
    expect(relations?.extractor).toBe(CATALOG_EXTRACTOR_VERSION);
  });

  it("resolves a late association from persisted facts without a source re-collect", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const store: KnowledgeStore = await openWorkspaceKnowledge({
      dataDir: documents.dataDir,
      hostId: "catalog-host",
      workspaceId: documents.identity.workspaceId,
      embedding: null,
    });
    disposes.push(async () => { await store.close(); });
    writeFileSync(join(documents.workspaceRoot, "a-consumer.ts"), [
      "export function consumer() {",
      "  console.log(\"late.channel\");",
      "}",
    ].join("\n"), "utf8");
    writeFileSync(join(documents.workspaceRoot, "z-producer.ts"), [
      "export function producer() {",
      "  router.register(\"late.channel\");",
      "}",
    ].join("\n"), "utf8");

    const baseSource = parsingSource();
    const sourceCalls = { outline: 0, imports: 0, literalCalls: 0 };
    const structureSource = {
      outline: (request: Parameters<typeof baseSource.outline>[0]) => {
        sourceCalls.outline += 1;
        return baseSource.outline(request);
      },
      classifyHits: (request: Parameters<typeof baseSource.classifyHits>[0]) => baseSource.classifyHits(request),
      imports: (request: Parameters<typeof baseSource.imports>[0]) => {
        sourceCalls.imports += 1;
        return baseSource.imports(request);
      },
      literalCalls: (request: Parameters<typeof baseSource.literalCalls>[0]) => {
        sourceCalls.literalCalls += 1;
        return baseSource.literalCalls(request);
      },
    };
    let consumerRevision = revisionFromBytes(Buffer.from([
      "export function consumer() {",
      "  console.log(\"late.channel\");",
      "}",
    ].join("\n")));
    const producerRevision = revisionFromBytes(Buffer.from([
      "export function producer() {",
      "  router.register(\"late.channel\");",
      "}",
    ].join("\n")));
    const searchFilesystemFiles = vi.fn(async () => [
      {
        name: "a-consumer.ts",
        path: join(documents.workspaceRoot, "a-consumer.ts"),
        relativePath: "a-consumer.ts",
        revision: consumerRevision,
      },
      {
        name: "z-producer.ts",
        path: join(documents.workspaceRoot, "z-producer.ts"),
        relativePath: "z-producer.ts",
        revision: producerRevision,
      },
    ]);
    const read = vi.spyOn(documents.authority, "read");
    const runtime = createSymbolGraphRuntime({
      getStore: async () => store,
      documents: documents.authority,
      supervisor: {
        syncDocument: async () => ({ status: "synced", documentVersion: 1 }),
        documentSymbols: async () => ({ status: "failed", message: "catalog scan must not start a language server" }),
      } as never,
      structureSource,
      searchFilesystemFiles,
    });
    disposes.push(() => runtime.dispose());

    const firstScan = runtime.scanWorkspace(documents.identity.workspaceId);
    const duplicateScan = runtime.scanWorkspace(documents.identity.workspaceId);
    expect(duplicateScan).toBe(firstScan);
    await firstScan;
    expect(await store.getFileRelations("a-consumer.ts")).toMatchObject({
      associations: [{ callee: "log", literal: "late.channel" }],
    });
    expect(await store.getFileRelations("z-producer.ts")).toMatchObject({
      connections: [{ callee: "register", literal: "late.channel" }],
    });
    // Two file rows + two symbol rows + two active link rows; the retained
    // unresolved candidate metadata is part of the file row, not a placeholder
    // graph node.
    expect(await store.catalogStats()).toMatchObject({ linkCount: 2, nodeCount: 6 });
    // This explicit legacy provider seam still needs one body read per actual
    // extraction. Catalog revision checks no longer add a Documents read;
    // production receives native inventory revisions instead.
    expect(read).toHaveBeenCalledTimes(2);
    expect(sourceCalls).toEqual({ outline: 2, imports: 2, literalCalls: 2 });

    // An external disk write does not emit Documents' mutation callback. An
    // explicit scan still re-checks revisions and refreshes only the changed
    // file, while reusing the unchanged producer's graph facts.
    writeFileSync(join(documents.workspaceRoot, "a-consumer.ts"), [
      "export function consumerRenamed() {",
      "  console.log(\"late.channel\");",
      "}",
    ].join("\n"), "utf8");
    consumerRevision = revisionFromBytes(Buffer.from([
      "export function consumerRenamed() {",
      "  console.log(\"late.channel\");",
      "}",
    ].join("\n")));
    await runtime.scanWorkspace(documents.identity.workspaceId);
    expect(searchFilesystemFiles).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(3);
    expect(sourceCalls).toEqual({ outline: 3, imports: 3, literalCalls: 3 });
    expect((await store.searchSymbols("consumer", 5)).map((entry) => entry.name)).not.toContain("consumer");
    expect(await store.searchSymbols("consumerRenamed", 5)).toHaveLength(1);

    // Removing the last producer connection withdraws the relation while
    // retaining the consumer's compact candidate fact. Restoring the producer
    // activates it again without collecting the consumer a second time.
    writeFileSync(join(documents.workspaceRoot, "z-producer.ts"), [
      "export function producer() {",
      "  return 1;",
      "}",
    ].join("\n"), "utf8");
    runtime.observeDocumentMutation({
      workspaceId: documents.identity.workspaceId,
      resourceId: "z-producer.ts",
      kind: "modified",
      owner: { kind: "web-route", id: "editor" },
    });
    await runtime.drain();
    expect((await store.getFileRelations("z-producer.ts"))?.connections).toEqual([]);
    expect((await store.getFileRelations("a-consumer.ts"))?.associations).toEqual([]);

    writeFileSync(join(documents.workspaceRoot, "z-producer.ts"), [
      "export function producer() {",
      "  router.register(\"late.channel\");",
      "}",
    ].join("\n"), "utf8");
    runtime.observeDocumentMutation({
      workspaceId: documents.identity.workspaceId,
      resourceId: "z-producer.ts",
      kind: "modified",
      owner: { kind: "web-route", id: "editor" },
    });
    await runtime.drain();
    expect((await store.getFileRelations("a-consumer.ts"))?.associations).toEqual([
      expect.objectContaining({ callee: "log", literal: "late.channel" }),
    ]);
    expect(read).toHaveBeenCalledTimes(5);
    expect(sourceCalls).toEqual({ outline: 5, imports: 5, literalCalls: 5 });
  });

  it("leaves the prior graph intact when a structure collection is cancelled", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const store: KnowledgeStore = await openWorkspaceKnowledge({
      dataDir: documents.dataDir,
      hostId: "catalog-host",
      workspaceId: documents.identity.workspaceId,
      embedding: null,
    });
    disposes.push(async () => { await store.close(); });
    const path = "cancelled.ts";
    writeFileSync(join(documents.workspaceRoot, path), "export function oldSymbol() {}\n", "utf8");
    let block = false;
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const structureSource = {
      outline: async (request: { signal?: AbortSignal; revision: string }) => {
        if (block) {
          enteredResolve?.();
          await new Promise<void>((resolve) => {
            if (request.signal?.aborted) resolve();
            else request.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return { status: "cancelled" as const, provider: "tree-sitter" as const, revision: request.revision, symbols: [] };
        }
        return {
          status: "ready" as const,
          provider: "tree-sitter" as const,
          revision: request.revision,
          symbols: [{ name: "oldSymbol", kind: "function", range: { startLine: 1, endLine: 1 }, signature: { startLine: 1, endLine: 1 } }],
        };
      },
      imports: async (request: { revision: string }) => ({
        status: "empty" as const, provider: "tree-sitter" as const, revision: request.revision, imports: [],
      }),
      literalCalls: async (request: { revision: string }) => ({
        status: "empty" as const, provider: "tree-sitter" as const, revision: request.revision, calls: [],
      }),
      classifyHits: async (request: { revision: string }) => ({
        status: "unsupported" as const, provider: null, revision: request.revision, hits: [],
      }),
    };
    const runtime = createSymbolGraphRuntime({
      getStore: async () => store,
      documents: documents.authority,
      supervisor: {
        syncDocument: async () => ({ status: "synced", documentVersion: 1 }),
        documentSymbols: async () => ({ status: "failed", message: "cancel test must not start a language server" }),
      } as never,
      structureSource,
      searchFilesystemFiles: async () => [{
        name: path,
        path: join(documents.workspaceRoot, path),
        relativePath: path,
      }],
    });
    disposes.push(() => runtime.dispose());

    await runtime.scanWorkspace(documents.identity.workspaceId);
    expect(await store.searchSymbols("oldSymbol", 5)).toHaveLength(1);
    writeFileSync(join(documents.workspaceRoot, path), "export function newSymbol() {}\n", "utf8");
    block = true;
    const controller = new AbortController();
    const scan = runtime.scanWorkspace(documents.identity.workspaceId, { signal: controller.signal });
    await entered;
    controller.abort();
    await scan;
    expect(await store.searchSymbols("oldSymbol", 5)).toHaveLength(1);
    expect(await store.searchSymbols("newSymbol", 5)).toEqual([]);
  });

  it("reconciles an externally deleted producer only after a complete rescan", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const store: KnowledgeStore = await openWorkspaceKnowledge({
      dataDir: documents.dataDir,
      hostId: "catalog-host",
      workspaceId: documents.identity.workspaceId,
      embedding: null,
    });
    disposes.push(async () => { await store.close(); });
    const consumerPath = join(documents.workspaceRoot, "consumer.ts");
    const producerPath = join(documents.workspaceRoot, "producer.ts");
    writeFileSync(consumerPath, "export function consumer() { console.log(\"external.event\"); }\n", "utf8");
    writeFileSync(producerPath, "export function producer() { router.register(\"external.event\"); }\n", "utf8");
    const search = createFsSearchRuntime({ compute: kernelCompute, path });
    const runtime = createSymbolGraphRuntime({
      getStore: async () => store,
      documents: documents.authority,
      supervisor: {
        syncDocument: async () => ({ status: "synced", documentVersion: 1 }),
        documentSymbols: async () => ({ status: "failed", message: "catalog scan must not start a language server" }),
      } as never,
      structureSource: parsingSource(),
      searchFilesystemFiles: search.searchFilesystemFiles,
    });
    disposes.push(() => runtime.dispose());

    await runtime.scanWorkspace(documents.identity.workspaceId);
    expect((await store.getFileRelations("consumer.ts"))?.associations).toEqual([
      expect.objectContaining({ callee: "log", literal: "external.event" }),
    ]);

    // Bypass Documents mutation notifications: explicit complete inventory
    // reconciliation must notice the missing producer and withdraw its edge.
    rmSync(producerPath, { force: true });
    await runtime.scanWorkspace(documents.identity.workspaceId);
    expect(await store.getFileRelations("producer.ts")).toBeNull();
    expect((await store.getFileRelations("consumer.ts"))?.associations).toEqual([]);

    // Recreating the producer and explicitly rescanning restores the relation
    // from the consumer's retained candidate metadata.
    writeFileSync(producerPath, "export function producer() { router.register(\"external.event\"); }\n", "utf8");
    await runtime.scanWorkspace(documents.identity.workspaceId);
    expect((await store.getFileRelations("producer.ts"))?.connections).toEqual([
      expect.objectContaining({ callee: "register", literal: "external.event" }),
    ]);
    expect((await store.getFileRelations("consumer.ts"))?.associations).toEqual([
      expect.objectContaining({ callee: "log", literal: "external.event" }),
    ]);

    // An actually empty workspace inventory clears both old graph files.
    rmSync(consumerPath, { force: true });
    rmSync(producerPath, { force: true });
    await runtime.scanWorkspace(documents.identity.workspaceId);
    expect((await store.catalogStats()).fileCount).toBe(0);
  });

  it("never treats a failed, cancelled, or incomplete inventory as an empty directory", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const store: KnowledgeStore = await openWorkspaceKnowledge({
      dataDir: documents.dataDir,
      hostId: "catalog-host",
      workspaceId: documents.identity.workspaceId,
      embedding: null,
    });
    disposes.push(async () => { await store.close(); });
    const oldPath = join(documents.workspaceRoot, "old.ts");
    writeFileSync(oldPath, "export function oldSymbol() {}\n", "utf8");
    await store.replaceFileSymbols("old.ts", "typescript", [
      { name: "oldSymbol", kind: "function", range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 30 } },
    ], "old-revision");
    rmSync(oldPath, { force: true });

    let status: "incomplete" | "failed" | "complete" = "incomplete";
    const inventory = () => {
      const result: Array<never> & { enumerationStatus?: typeof status } = [];
      Object.defineProperty(result, "enumerationStatus", { value: status, enumerable: false });
      return result;
    };
    const runtime = createSymbolGraphRuntime({
      getStore: async () => store,
      documents: documents.authority,
      supervisor: {
        syncDocument: async () => ({ status: "synced", documentVersion: 1 }),
        documentSymbols: async () => ({ status: "failed", message: "catalog scan must not start a language server" }),
      } as never,
      structureSource: parsingSource(),
      searchFilesystemFiles: async () => inventory(),
    });
    disposes.push(() => runtime.dispose());

    await runtime.scanWorkspace(documents.identity.workspaceId);
    expect(await store.getFileRelations("old.ts")).not.toBeNull();
    status = "failed";
    await runtime.scanWorkspace(documents.identity.workspaceId);
    expect(await store.getFileRelations("old.ts")).not.toBeNull();
    status = "complete";
    const controller = new AbortController();
    controller.abort();
    await runtime.scanWorkspace(documents.identity.workspaceId, { signal: controller.signal });
    expect(await store.getFileRelations("old.ts")).not.toBeNull();

    // An actually complete empty inventory is allowed to remove the missing
    // path.
    await runtime.scanWorkspace(documents.identity.workspaceId);
    expect(await store.getFileRelations("old.ts")).toBeNull();
  });

  it("keeps a stale path when it is recreated during reconciliation", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const store: KnowledgeStore = await openWorkspaceKnowledge({
      dataDir: documents.dataDir,
      hostId: "catalog-host",
      workspaceId: documents.identity.workspaceId,
      embedding: null,
    });
    disposes.push(async () => { await store.close(); });
    const racePath = join(documents.workspaceRoot, "race.ts");
    writeFileSync(racePath, "export function oldRace() {}\n", "utf8");
    await store.replaceFileSymbols("race.ts", "typescript", [
      { name: "oldRace", kind: "function", range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 29 } },
    ], "old-race-revision");
    rmSync(racePath, { force: true });

    let recreated = false;
    const inventory = [] as Array<never> & { enumerationStatus: "complete" };
    Object.defineProperty(inventory, "enumerationStatus", { value: "complete", enumerable: false });
    const runtime = createSymbolGraphRuntime({
      getStore: async () => store,
      documents: documents.authority,
      supervisor: {
        syncDocument: async () => ({ status: "synced", documentVersion: 1 }),
        documentSymbols: async () => ({ status: "failed", message: "catalog scan must not start a language server" }),
      } as never,
      structureSource: parsingSource(),
      searchFilesystemFiles: async () => inventory,
      isIndexablePath: async (_workspaceId, resourceId) => {
        if (resourceId !== "race.ts") return false;
        if (!recreated) {
          recreated = true;
          writeFileSync(racePath, "export function newRace() {}\n", "utf8");
        }
        return true;
      },
    });
    disposes.push(() => runtime.dispose());

    await runtime.scanWorkspace(documents.identity.workspaceId);
    expect(await store.searchSymbols("oldRace", 5)).toEqual([]);
    expect(await store.searchSymbols("newRace", 5)).toHaveLength(1);
  });

  it("does not delete when cancellation arrives while stale removal is queued", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const store: KnowledgeStore = await openWorkspaceKnowledge({
      dataDir: documents.dataDir,
      hostId: "catalog-host",
      workspaceId: documents.identity.workspaceId,
      embedding: null,
    });
    disposes.push(async () => { await store.close(); });
    const oldPath = join(documents.workspaceRoot, "queued-delete.ts");
    writeFileSync(oldPath, "export function oldQueued() {}\n", "utf8");
    await store.replaceFileSymbols("queued-delete.ts", "typescript", [
      { name: "oldQueued", kind: "function", range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 32 } },
    ], "queued-old-revision");
    rmSync(oldPath, { force: true });

    const completeEmptyInventory = [] as Array<never> & { enumerationStatus: "complete" };
    Object.defineProperty(completeEmptyInventory, "enumerationStatus", { value: "complete", enumerable: false });
    let releaseRemoval!: () => void;
    let markRemovalStarted!: () => void;
    const removalStarted = new Promise<void>((resolve) => { markRemovalStarted = resolve; });
    const released = new Promise<void>((resolve) => { releaseRemoval = resolve; });
    const originalRemove = store.removeFileSymbols.bind(store);
    store.removeFileSymbols = async (path, options) => {
      markRemovalStarted();
      await released;
      return originalRemove(path, options);
    };
    const runtime = createSymbolGraphRuntime({
      getStore: async () => store,
      documents: documents.authority,
      supervisor: {
        syncDocument: async () => ({ status: "synced", documentVersion: 1 }),
        documentSymbols: async () => ({ status: "failed", message: "catalog scan must not start a language server" }),
      } as never,
      structureSource: parsingSource(),
      searchFilesystemFiles: async () => completeEmptyInventory,
    });
    disposes.push(() => runtime.dispose());

    const controller = new AbortController();
    const scan = runtime.scanWorkspace(documents.identity.workspaceId, { signal: controller.signal });
    await removalStarted;
    controller.abort();
    // The wrapper queues the actual Store call until after cancellation.
    releaseRemoval();
    await scan;
    expect(await store.getFileRelations("queued-delete.ts")).not.toBeNull();
  });

  /**
   * The catalog is a function of the file and of the extractor that read it.
   * Skipping on revision alone meant a fixed query never reached files whose
   * content had not changed — the missing request end of "explore.search" in
   * explore-tool.ts would have stayed missing forever (D-143).
   */
  it("re-collects an unchanged file whose rows came from an older extractor, and skips a current one", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const store: KnowledgeStore = await openWorkspaceKnowledge({
      dataDir: documents.dataDir,
      hostId: "catalog-host",
      workspaceId: documents.identity.workspaceId,
      embedding: null,
    });
    disposes.push(async () => { await store.close(); });
    writeFileSync(join(documents.workspaceRoot, "stale.ts"), [
      "export async function ask(bridge: { request<T>(k: string, p: object): Promise<T> }) {",
      "  return await bridge.request<\"explore.search\">(\"explore.search\", {});",
      "}",
    ].join("\n"), "utf8");
    writeFileSync(join(documents.workspaceRoot, "fresh.ts"), "export const fresh = 1;\n", "utf8");
    const staleDisk = await documents.authority.read(documents.resource("stale.ts"));
    const freshDisk = await documents.authority.read(documents.resource("fresh.ts"));
    if (staleDisk.status !== "ready" || freshDisk.status !== "ready") throw new Error("expected disk text");

    // Rows as an older extractor left them: right revision, no request edge.
    await store.replaceFileSymbols("stale.ts", "typescript", [
      { name: "ask", kind: "function", range: { startLine: 0, startCharacter: 0, endLine: 2, endCharacter: 1 } },
    ], staleDisk.revision, [], { extractor: CATALOG_EXTRACTOR_VERSION - 1 });
    await store.replaceFileSymbols("fresh.ts", "typescript", [
      { name: "fresh", kind: "variable", range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 24 } },
    ], freshDisk.revision, [], { extractor: CATALOG_EXTRACTOR_VERSION });
    const freshBefore = await store.getFileRelations("fresh.ts");

    const search = createFsSearchRuntime({ compute: kernelCompute, path });
    const runtime = createSymbolGraphRuntime({
      getStore: async () => store,
      documents: documents.authority,
      supervisor: {
        syncDocument: async () => ({ status: "synced", documentVersion: 1 }),
        documentSymbols: async () => ({ status: "failed", message: "catalog scan must not start a language server" }),
      } as never,
      structureSource: parsingSource(),
      searchFilesystemFiles: search.searchFilesystemFiles,
    });
    disposes.push(() => runtime.dispose());
    await runtime.scanWorkspace(documents.identity.workspaceId);

    const stale = await store.getFileRelations("stale.ts");
    expect(stale?.extractor).toBe(CATALOG_EXTRACTOR_VERSION);
    expect(stale?.connections).toEqual([expect.objectContaining({ callee: "request", literal: "explore.search" })]);
    // Same revision and current extractor: not rewritten, so the generation holds.
    expect((await store.getFileRelations("fresh.ts"))?.generation).toBe(freshBefore?.generation);
  });
});
