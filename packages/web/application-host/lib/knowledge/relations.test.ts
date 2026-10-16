import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, afterEach } from "vitest";
import { createDocumentAuthorityHarness } from "../documents/contract-fixtures.js";
import { createLanguageSupervisor } from "../lsp/supervisor.js";
import { VARIN_LSP_FIXTURE_SERVER_ARGS } from "../lsp/servers.js";
import { createRelationCollector, identifierAt } from "./relations.js";
import { openWorkspaceKnowledge, type KnowledgeStore } from "./store.js";

// Scratch stores live in the OS temp dir; see store.test.ts.
const TEST_DIR = mkdtempSync(join(tmpdir(), "varin-test-relations-"));
let storeCounter = 0;
let store: KnowledgeStore | null = null;

const cleanupDir = () => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
};

afterEach(async () => {
  await store?.close();
  store = null;
  cleanupDir();
});

async function openStore() {
  storeCounter += 1;
  const dir = join(TEST_DIR, `relations-${storeCounter}`);
  mkdirSync(dir, { recursive: true });
  store = await openWorkspaceKnowledge({
    dataDir: dir,
    hostId: "test-host",
    workspaceId: "ws-test",
    embedding: null,
  });
  return store;
}

describe("identifierAt", () => {
  it("finds the identifier containing a 1-based position", () => {
    const text = "export function uniqueTarget() {}\nuniqueTarget();\n";
    expect(identifierAt(text, 1, 17)?.name).toBe("uniqueTarget");
    expect(identifierAt(text, 2, 1)?.name).toBe("uniqueTarget");
    expect(identifierAt(text, 1, 7)).toBeNull();
    expect(identifierAt(text, 40, 1)).toBeNull();
  });
});

describe("relation collector", () => {
  it("collects references and call hierarchy through a real supervisor and persists the rows", async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      const workspaceId = harness.identity.workspaceId;
      const defText = "export function uniqueTarget() { return 1; }\nexport const localCaller = () => uniqueTarget();\n";
      const otherText = "import { uniqueTarget } from \"./a.js\";\nexport const otherCaller = uniqueTarget();\n";
      await fs.promises.writeFile(path.join(harness.workspaceRoot, "a.ts"), defText);
      await fs.promises.writeFile(path.join(harness.workspaceRoot, "b.ts"), otherText);
      language.registerProvider({
        providerId: "fixture",
        command: process.execPath,
        args: VARIN_LSP_FIXTURE_SERVER_ARGS,
        languageIds: ["typescript"],
        source: "host",
      });
      const openedStore = await openStore();
      await openedStore.replaceFileSymbols("a.ts", "typescript", [
        { name: "uniqueTarget", kind: "function", range: { startLine: 0, startCharacter: 16, endLine: 0, endCharacter: 28 } },
        { name: "localCaller", kind: "variable", range: { startLine: 1, startCharacter: 13, endLine: 1, endCharacter: 45 } },
      ], "disk-a1");
      await openedStore.replaceFileSymbols("b.ts", "typescript", [
        { name: "otherCaller", kind: "variable", range: { startLine: 1, startCharacter: 13, endLine: 1, endCharacter: 40 } },
      ], "disk-b1");

      const collector = createRelationCollector({
        documents: harness.authority,
        supervisor: language,
        getStore: () => store,
      });
      // The second file must be bound in the agent view for the fixture server
      // to see it — production sessions bind whatever they have touched.
      const binder = (await import("../lsp/language-view.js")).createLanguageViewBinder({
        documents: harness.authority,
        supervisor: language,
      });
      await binder.bind({ workspaceId, resourceId: "b.ts", languageId: "typescript", text: "disk" });

      const outcome = await collector.collect(workspaceId, { path: "a.ts", line: 1, character: 17 });
      expect(outcome.name).toBe("uniqueTarget");
      expect(outcome.references.status).toBe("ready");
      expect(outcome.references.sites.length).toBeGreaterThanOrEqual(2);
      expect(outcome.references.sites.some((site) => site.path === "b.ts")).toBe(true);
      expect(outcome.calls.callers.some((call) => call.path === "a.ts")).toBe(true);
      expect(outcome.calls.callers.some((call) => call.path === "b.ts")).toBe(true);

      // Persisted rows: a.ts's own site is pinned to its bound revision; b.ts's
      // is the server's own read and stays unpinned.
      const references = await openedStore.findReferences("uniqueTarget");
      expect(references.some((row) => row.path === "a.ts" && row.pinned)).toBe(true);
      expect(references.some((row) => row.path === "b.ts" && !row.pinned)).toBe(true);
      const callers = await openedStore.findCallers("uniqueTarget");
      expect(callers.some((row) => row.path === "b.ts")).toBe(true);
      expect(callers.every((row) => row.targetPath === "a.ts" || row.targetPath === undefined)).toBe(true);
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it("persists piggybacked navigation results with the anchor revision pinning only its file", async () => {
    const harness = await createDocumentAuthorityHarness();
    try {
      const workspaceId = harness.identity.workspaceId;
      const openedStore = await openStore();
      const collector = createRelationCollector({
        documents: harness.authority,
        // The supervisor is not consulted by record().
        supervisor: {} as never,
        getStore: () => store,
      });
      const recorded = await collector.record(workspaceId, {
        anchor: { path: "use.ts", line: 4, character: 12 },
        anchorRevision: "disk-u1",
        name: "uniqueTarget",
        resolvedBy: "lsp.references",
        sites: [
          { path: "use.ts", line: 4, character: 12 },
          { path: "other.ts", line: 9, character: 2 },
        ],
        target: { path: "def.ts", line: 1, name: "uniqueTarget" },
      });
      expect(recorded.recorded).toBe(2);
      const references = await openedStore.findReferences("uniqueTarget");
      expect(references).toHaveLength(2);
      expect(references.find((row) => row.path === "use.ts")).toMatchObject({
        pinned: true,
        documentRevision: "disk-u1",
        resolvedBy: "lsp.references",
        targetPath: "def.ts",
      });
      expect(references.find((row) => row.path === "other.ts")).toMatchObject({
        pinned: false,
        documentRevision: null,
      });
      expect(await openedStore.findCallers("uniqueTarget")).toEqual([]);

      await collector.record(workspaceId, {
        anchor: { path: "use.ts", line: 4, character: 12 },
        anchorRevision: "disk-u2",
        name: "uniqueTarget",
        resolvedBy: "lsp.references",
        sites: [],
      });
      expect(await openedStore.findReferences("uniqueTarget")).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  it("degrades without a store and reports unsupported file types honestly", async () => {
    const harness = await createDocumentAuthorityHarness();
    try {
      const collector = createRelationCollector({
        documents: harness.authority,
        supervisor: {} as never,
        getStore: () => null,
      });
      // No store open: record is a no-op, not an error (D-112).
      const recorded = await collector.record(harness.identity.workspaceId, {
        anchor: { path: "a.ts", line: 1 },
        anchorRevision: "disk-a1",
        name: "anything",
        resolvedBy: "lsp.references",
        sites: [{ path: "a.ts", line: 1 }],
      });
      expect(recorded.recorded).toBe(0);
      const outcome = await collector.collect(harness.identity.workspaceId, { path: "notes.txt", line: 1 });
      expect(outcome.status).toBe("unsupported");
      // And a missing file is unavailable rather than resolved-empty.
      const missing = await collector.collect(harness.identity.workspaceId, { path: "missing.ts", line: 1 });
      expect(["unavailable", "empty", "failed"]).toContain(missing.status);
    } finally {
      await harness.cleanup();
    }
  });
});
