import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openWorkspaceKnowledge, type KnowledgeStore } from "./store.js";
import { createSymbolGraphRuntime } from "./symbol-runtime.js";
import { createDocumentAuthorityHarness } from "../documents/contract-fixtures.js";
import type { DocumentMutationObservation } from "../documents/authority.js";
import { createProjectIndexScope } from './index-scope.js';

const TEST_DIR = join(tmpdir(), "varin-symbol-runtime");

describe("symbol graph runtime", () => {
  it('purges only the selected source catalog and preserves other source folders and memory', async () => {
    const root = join(TEST_DIR, 'source');
    for (const folder of ['removed', 'retained']) await store.replaceFileSymbols(`${folder}/file.ts`, 'typescript', [{
      name: folder, kind: 'function', range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 3 },
    }], 'revision');
    const memoryId = await store.putKnowledge({ scope: 'workspace', status: 'accepted', content: 'Keep this memory', trigger: 'fixture' });
    const runtime = createSymbolGraphRuntime({ getStore: async () => store, documents: {} as never, supervisor: {} as never });
    try {
      await runtime.purgeDirectory('workspace', join(root, 'removed'), root);
      expect((await store.catalogStats()).paths).toEqual(['retained/file.ts']);
      expect((await store.getKnowledge(memoryId))?.content).toBe('Keep this memory');
    } finally { await runtime.dispose(); }
  });
  it('limits structure inventories and mutation collection to explicit project folders', async () => {
    const root = join(TEST_DIR, 'user-home');
    const selected = join(root, 'project');
    const selection = createProjectIndexScope([selected]);
    const inventory = vi.fn(async (_directory: string) => []);
    const getStore = vi.fn(async () => null);
    const runtime = createSymbolGraphRuntime({ getStore, getIndexScope: selection.get,
      documents: { inspectWorkspace: async () => ({ root }) } as never,
      supervisor: {} as never, searchFilesystemFiles: inventory });
    try {
      runtime.observeDocumentMutation({ workspaceId: 'home', resourceId: 'bots/private.ts', kind: 'modified', owner: { kind: 'web-route', id: 'bot' } });
      await runtime.drain();
      expect(getStore).not.toHaveBeenCalled();
      await runtime.scanWorkspace('home');
      expect(inventory.mock.calls.map(([directory]) => directory)).toEqual([selected]);
      selection.update([]);
      runtime.refreshIndexScope();
      await runtime.drain();
      expect(inventory).toHaveBeenCalledTimes(1);
    } finally { selection.dispose(); await runtime.dispose(); }
  });
  let store: KnowledgeStore;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = await openWorkspaceKnowledge({ dataDir: TEST_DIR, hostId: "host", workspaceId: "workspace", embedding: null });
  });

  afterEach(async () => {
    await store.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("projects committed document changes through the live LSP and preserves the last graph while unavailable", async () => {
    let available = true;
    let symbols: unknown[] = [{
      name: "Outer",
      kind: 5,
      range: { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } },
      children: [{ name: "inner", kind: 12, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } } }],
    }];
    const read = vi.fn(async () => ({
      status: "ready" as const,
      resource: { workspaceId: "workspace", resourceId: "src/a.ts" },
      content: "class Outer {}",
      revision: "r1",
      encoding: "utf-8",
      bom: false,
      byteLength: 14,
      epoch: 1,
    }));
    const supervisor = {
      syncDocument: vi.fn(async () => ({ status: "synced", documentVersion: 1 })),
      documentSymbols: vi.fn(async () => (available
        ? { status: "ready", value: symbols }
        : { status: "failed", message: "language server exited" })),
    };
    const runtime = createSymbolGraphRuntime({
      getStore: async () => store,
      documents: { read, readAgentInputSnapshot: () => ({ status: "disk" as const }) } as never,
      supervisor: supervisor as never,
    });
    const mutation = { workspaceId: "workspace", resourceId: "src/a.ts", kind: "modified" as const, owner: { kind: "web-route", id: "editor" } };
    try {
      runtime.observeDocumentMutation(mutation);
      await runtime.drain();
      expect((await store.searchSymbols("Outer", 10)).map((entry) => entry.name)).toEqual(["Outer"]);
      expect((await store.searchSymbols("inner", 10)).map((entry) => entry.name)).toEqual(["inner"]);
      // The graph records committed facts, so each collection binds the file's
      // disk text and stores the revision it saw.
      expect((await store.searchSymbols("Outer", 10))[0]?.documentRevision).toBe("r1");
      expect(supervisor.syncDocument).toHaveBeenCalledWith(expect.objectContaining({
        view: "agent",
        contentRevision: "r1",
      }));
      expect(supervisor.documentSymbols).toHaveBeenCalledWith(expect.objectContaining({
        view: "agent",
        expectedRevision: "r1",
      }));

      symbols = [{ name: "Replacement", kind: 13, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 11 } } }];
      runtime.observeDocumentMutation(mutation);
      await runtime.drain();
      expect(await store.searchSymbols("Outer", 10)).toEqual([]);
      expect(await store.searchSymbols("Replacement", 10)).toHaveLength(1);

      available = false;
      symbols = [];
      runtime.observeDocumentMutation(mutation);
      await runtime.drain();
      expect(await store.searchSymbols("Replacement", 10)).toHaveLength(1);

      runtime.observeDocumentMutation({ ...mutation, kind: "deleted" });
      await runtime.drain();
      expect(await store.searchSymbols("Replacement", 10)).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it("runs from the Documents post-commit observation boundary", async () => {
    let observe = (_event: DocumentMutationObservation): void => undefined;
    const documents = await createDocumentAuthorityHarness({
      authority: { onMutation: (event) => observe(event) },
    });
    const supervisor = {
      syncDocument: async () => ({ status: "synced", documentVersion: 1 }),
      documentSymbols: async () => ({
        status: "ready",
        value: [{ name: "ObservedSymbol", kind: 13, range: { start: { line: 0, character: 13 }, end: { line: 0, character: 27 } } }],
      }),
    };
    const runtime = createSymbolGraphRuntime({
      getStore: async () => store,
      documents: documents.authority,
      supervisor: supervisor as never,
    });
    observe = runtime.observeDocumentMutation;
    try {
      const written = await documents.authority.write({
        resource: documents.resource("observed.ts"),
        token: documents.token(undefined, { kind: "web-route", id: "editor" }),
        content: "export const ObservedSymbol = true;\n",
        encoding: "utf-8",
        bom: false,
        expectedRevision: null,
        operationId: randomUUID(),
      });
      expect(written.status).toBe("written");
      const writtenRevision = written.status === "written" ? written.revision : null;
      await Promise.resolve();
      await runtime.drain();
      expect(await store.searchSymbols("ObservedSymbol", 5)).toEqual([
        expect.objectContaining({ name: "ObservedSymbol", path: "observed.ts", documentRevision: writtenRevision }),
      ]);
    } finally {
      observe = () => undefined;
      await runtime.dispose();
      await documents.cleanup();
    }
  });

  it("writes structure imports and classified calls, and preserves the graph when extraction is unavailable", async () => {
    let imports: Array<{ source: string; line: number }> = [{ source: "./old", line: 1 }];
    let calls: Array<{ name: string; literal: string; line: number }> = [
      { name: "register", literal: "explore.search", line: 3 },
      { name: "log", literal: "explore.search", line: 4 },
    ];
    let importStatus: "ready" | "unavailable" = "ready";
    const read = vi.fn(async () => ({
      status: "ready" as const,
      resource: { workspaceId: "workspace", resourceId: "src/router.ts" },
      content: "import { boot } from \"./old\";\nexport function boot() {}\n",
      revision: "disk-r1",
      encoding: "utf-8",
      bom: false,
      byteLength: 20,
      epoch: 1,
    }));
    let symbolName = "boot";
    const structureSource = {
      outline: async (request: { revision: string }) => ({
        status: "ready" as const,
        provider: "tree-sitter" as const,
        revision: request.revision,
        symbols: [{
          name: symbolName,
          kind: "function",
          range: { startLine: 2, endLine: 2 },
          signature: { startLine: 2, endLine: 2 },
        }],
      }),
      classifyHits: async (request: { revision: string }) => ({
        status: "unsupported" as const,
        provider: "tree-sitter" as const,
        revision: request.revision,
        hits: [],
      }),
      literalCalls: async (request: { revision: string }) => ({
        status: "ready" as const,
        provider: "tree-sitter" as const,
        revision: request.revision,
        calls,
      }),
      imports: async (request: { revision: string }) => (
        importStatus === "ready"
          ? { status: "ready" as const, provider: "tree-sitter" as const, revision: request.revision, imports }
          : { status: "unavailable" as const, provider: "tree-sitter" as const, revision: request.revision, imports: [] }
      ),
    };
    const runtime = createSymbolGraphRuntime({
      getStore: async () => store,
      documents: { read, readAgentInputSnapshot: () => ({ status: "disk" as const }) } as never,
      supervisor: {
        syncDocument: async () => ({ status: "synced", documentVersion: 1 }),
        documentSymbols: async () => ({ status: "failed", message: "should not be used when structureSource is present" }),
      } as never,
      structureSource,
    });
    const mutation = { workspaceId: "workspace", resourceId: "src/router.ts", kind: "modified" as const, owner: { kind: "web-route", id: "editor" } };
    try {
      runtime.observeDocumentMutation(mutation);
      await runtime.drain();
      expect((await store.getDefinedSymbols("src/router.ts")).map((symbol) => symbol.name)).toEqual(["boot"]);
      expect(await store.getFileRelations("src/router.ts")).toMatchObject({
        documentRevision: "disk-r1",
        danglingEdges: 0,
        imports: [{ specifier: "./old", line: 1 }],
        connections: [{ callee: "register", literal: "explore.search" }],
        associations: [{ callee: "log", literal: "explore.search" }],
      });
      expect(read).toHaveBeenCalled();

      imports = [{ source: "./new", line: 1 }];
      calls = [{ name: "on", literal: "ready", line: 6 }];
      read.mockResolvedValue({
        status: "ready" as const,
        resource: { workspaceId: "workspace", resourceId: "src/router.ts" },
        content: "import { boot } from \"./new\";\nexport function boot() {}\n",
        revision: "disk-r2",
        encoding: "utf-8",
        bom: false,
        byteLength: 20,
        epoch: 1,
      });
      runtime.observeDocumentMutation(mutation);
      await runtime.drain();
      expect(await store.getFileRelations("src/router.ts")).toMatchObject({
        documentRevision: "disk-r2",
        danglingEdges: 0,
        imports: [{ specifier: "./new", line: 1 }],
        connections: [{ callee: "on", literal: "ready" }],
        associations: [],
      });
      expect(await store.findLinks("./old")).toEqual([]);

      // A blocked link query must not suppress a working outline: the file was
      // renamed, so freezing the symbols would leave the graph silently wrong
      // while still reporting a revision (D-111).
      importStatus = "unavailable";
      calls = [{ name: "on", literal: "ready", line: 6 }];
      symbolName = "bootRenamed";
      read.mockResolvedValue({
        status: "ready" as const,
        resource: { workspaceId: "workspace", resourceId: "src/router.ts" },
        content: "import { boot } from \"./new\";\nexport function bootRenamed() {}\n",
        revision: "disk-r3",
        encoding: "utf-8",
        bom: false,
        byteLength: 20,
        epoch: 1,
      });
      runtime.observeDocumentMutation(mutation);
      await runtime.drain();
      expect((await store.getDefinedSymbols("src/router.ts")).map((symbol) => symbol.name)).toEqual(["bootRenamed"]);
      expect(await store.getFileRelations("src/router.ts")).toMatchObject({
        documentRevision: "disk-r3",
        linksIncomplete: true,
        imports: [],
        connections: [{ callee: "on", literal: "ready" }],
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps a same-string candidate only when the literal is a confirmed connection somewhere", async () => {
    const read = vi.fn(async () => ({
      status: "ready" as const,
      resource: { workspaceId: "workspace", resourceId: "src/noise.ts" },
      content: "export function boot() {}\n",
      revision: "disk-n1",
      encoding: "utf-8",
      bom: false,
      byteLength: 26,
      epoch: 1,
    }));
    let calls: Array<{ name: string; literal: string; line: number }> = [
      { name: "it", literal: "does a thing", line: 1 },
      { name: "join", literal: "a", line: 2 },
    ];
    const structureSource = {
      outline: async (request: { revision: string }) => ({
        status: "ready" as const,
        provider: "tree-sitter" as const,
        revision: request.revision,
        symbols: [{ name: "boot", kind: "function", range: { startLine: 1, endLine: 1 }, signature: { startLine: 1, endLine: 1 } }],
      }),
      classifyHits: async (request: { revision: string }) => ({
        status: "unsupported" as const, provider: null, revision: request.revision, hits: [],
      }),
      literalCalls: async (request: { revision: string }) => ({
        status: "ready" as const, provider: "tree-sitter" as const, revision: request.revision, calls,
      }),
      imports: async (request: { revision: string }) => ({
        status: "ready" as const, provider: "tree-sitter" as const, revision: request.revision, imports: [],
      }),
    };
    const runtime = createSymbolGraphRuntime({
      getStore: async () => store,
      documents: { read, readAgentInputSnapshot: () => ({ status: "disk" as const }) } as never,
      supervisor: {
        syncDocument: async () => ({ status: "synced", documentVersion: 1 }),
        documentSymbols: async () => ({ status: "failed", message: "unused" }),
      } as never,
      structureSource,
    });
    const mutation = { workspaceId: "workspace", resourceId: "src/noise.ts", kind: "modified" as const, owner: { kind: "web-route", id: "editor" } };
    try {
      runtime.observeDocumentMutation(mutation);
      await runtime.drain();
      expect(await store.getFileRelations("src/noise.ts")).toMatchObject({ associations: [], connections: [] });

      // Same file registers and mentions the same literal.
      calls = [
        { name: "register", literal: "shared.channel", line: 3 },
        { name: "log", literal: "shared.channel", line: 4 },
        { name: "it", literal: "does a thing", line: 5 },
      ];
      read.mockResolvedValue({
        status: "ready" as const,
        resource: { workspaceId: "workspace", resourceId: "src/noise.ts" },
        content: "export function boot() {}\n\n\n\n\n",
        revision: "disk-n2",
        encoding: "utf-8",
        bom: false,
        byteLength: 30,
        epoch: 1,
      });
      runtime.observeDocumentMutation(mutation);
      await runtime.drain();
      expect(await store.getFileRelations("src/noise.ts")).toMatchObject({
        connections: [{ callee: "register", literal: "shared.channel" }],
        associations: [{ callee: "log", literal: "shared.channel" }],
      });
    } finally {
      await runtime.dispose();
    }
  });
});
