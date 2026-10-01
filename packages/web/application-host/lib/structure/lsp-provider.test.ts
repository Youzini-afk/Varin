import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDocumentAuthorityHarness } from "../documents/contract-fixtures.js";
import { createLanguageSupervisor } from "../lsp/supervisor.js";
import { VARIN_LSP_FIXTURE_SERVER_ARGS } from "../lsp/servers.js";
import { createLspStructureProvider } from "./lsp-provider.js";

const fixtureProvider = (overrides: { env?: NodeJS.ProcessEnv; languageIds?: string[] } = {}) => ({
  providerId: "fixture",
  command: process.execPath,
  args: VARIN_LSP_FIXTURE_SERVER_ARGS,
  languageIds: overrides.languageIds ?? ["typescript"],
  source: "host" as const,
  ...(overrides.env ? { env: overrides.env } : {}),
});

describe("createLspStructureProvider", () => {
  it('cancels an outline waiting for shared provider activation without retiring that provider', async () => {
    const harness = await createDocumentAuthorityHarness();
    let release!: () => void;
    let entered!: () => void;
    const activation = new Promise<void>(resolve => { release = resolve; });
    const activationEntered = new Promise<void>(resolve => { entered = resolve; });
    const language = createLanguageSupervisor({
      documents: harness.authority, spawn, pathModule: path, isTrusted: async () => true,
      activateProviders: async () => { entered(); await activation; },
    });
    try {
      await fs.writeFile(path.join(harness.workspaceRoot, 'note.ts'), 'fixture\nchild\nend\n');
      const snapshot = await harness.authority.read(harness.resource('note.ts'));
      if (snapshot.status !== 'ready') throw new Error('expected disk snapshot');
      const provider = createLspStructureProvider({ documents: harness.authority, supervisor: language });
      const request = { path: 'note.ts', languageId: 'typescript', text: snapshot.content,
        revision: snapshot.revision, workspaceId: harness.identity.workspaceId };
      const controller = new AbortController();
      const outline = provider.outline({ ...request, signal: controller.signal });
      await activationEntered;
      const cancelled = expect(outline).rejects.toMatchObject({ name: 'AbortError' });
      controller.abort();
      await cancelled;
      language.registerProvider(fixtureProvider());
      release();
      expect(await provider.outline(request)).toMatchObject({ status: 'ready', revision: snapshot.revision });
    } finally {
      release();
      await language.dispose();
      await harness.cleanup();
    }
  });

  it("returns a ready outline with signature and full span from agent-view documentSymbols", async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      language.registerProvider(fixtureProvider());
      await fs.writeFile(path.join(harness.workspaceRoot, "note.ts"), "fixture\nchild\nend\n", "utf8");
      const snapshot = await harness.authority.read(harness.resource("note.ts"));
      expect(snapshot.status).toBe("ready");
      if (snapshot.status !== "ready") throw new Error("expected disk snapshot");
      const provider = createLspStructureProvider({ documents: harness.authority, supervisor: language });
      expect(provider.capabilities("typescript")).toEqual({
        outline: true,
        classifyHits: false,
        literalCalls: false,
        imports: false,
      });
      const result = await provider.outline({
        path: "note.ts",
        languageId: "typescript",
        text: snapshot.content,
        revision: snapshot.revision,
        workspaceId: harness.identity.workspaceId,
      });
      expect(result).toMatchObject({
        status: "ready",
        provider: "lsp",
        revision: snapshot.revision,
      });
      expect(result.symbols[0]).toMatchObject({
        name: "fixtureSymbol",
        kind: "variable",
        range: { startLine: 1, endLine: 2 },
        signature: { startLine: 1, endLine: 1 },
      });
      expect(result.symbols[0]?.children?.[0]).toMatchObject({
        name: "fixtureChild",
        kind: "function",
        range: { startLine: 2, endLine: 2 },
      });
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it("keeps unavailable, unsupported, and stale as distinct statuses", async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      const provider = createLspStructureProvider({ documents: harness.authority, supervisor: language });
      await fs.writeFile(path.join(harness.workspaceRoot, "note.ts"), "fixture\nchild\nend\n", "utf8");
      const snapshot = await harness.authority.read(harness.resource("note.ts"));
      expect(snapshot.status).toBe("ready");
      if (snapshot.status !== "ready") throw new Error("expected disk snapshot");

      const cold = await provider.outline({
        path: "note.ts",
        languageId: "typescript",
        text: snapshot.content,
        revision: snapshot.revision,
        workspaceId: harness.identity.workspaceId,
      });
      expect(cold.status).toBe("unavailable");
      expect(cold.symbols).toEqual([]);

      language.registerProvider(fixtureProvider({ env: { VARIN_LSP_FIXTURE_MINIMAL: "1" } }));
      const unsupported = await provider.outline({
        path: "note.ts",
        languageId: "typescript",
        text: snapshot.content,
        revision: snapshot.revision,
        workspaceId: harness.identity.workspaceId,
      });
      expect(unsupported.status).toBe("unsupported");
      expect(unsupported.symbols).toEqual([]);

      await language.dispose();
      const readyLanguage = createLanguageSupervisor({
        documents: harness.authority,
        spawn,
        pathModule: path,
        isTrusted: async () => true,
      });
      try {
        readyLanguage.registerProvider(fixtureProvider());
        const readyProvider = createLspStructureProvider({ documents: harness.authority, supervisor: readyLanguage });
        const stale = await readyProvider.outline({
          path: "note.ts",
          languageId: "typescript",
          text: snapshot.content,
          revision: "not-this-revision",
          workspaceId: harness.identity.workspaceId,
        });
        expect(stale.status).toBe("stale");
        expect(stale.symbols).toEqual([]);
        expect(stale.revision).toBe(snapshot.revision);
      } finally {
        await readyLanguage.dispose();
      }
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it("does not bind a cold language session when warmOnly is set", async () => {
    const getStatus = vi.fn((workspaceId: string, languageId: string, view = "agent") => ({
      status: "absent",
      workspaceId,
      languageId,
      view,
    }));
    const documentSymbols = vi.fn();
    const syncDocument = vi.fn();
    const read = vi.fn();
    const readAgentInputSnapshot = vi.fn();
    const provider = createLspStructureProvider({
      documents: { read, readAgentInputSnapshot },
      supervisor: { getStatus, documentSymbols, syncDocument },
    });
    const result = await provider.outline({
      path: "a.ts",
      languageId: "typescript",
      text: "export function x() {}",
      revision: "rev-1",
      workspaceId: "ws-1",
      warmOnly: true,
    });
    expect(result.status).toBe("unavailable");
    expect(result.message).toMatch(/not already running/i);
    expect(getStatus).toHaveBeenCalledWith("ws-1", "typescript", "agent");
    expect(documentSymbols).not.toHaveBeenCalled();
    expect(syncDocument).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("marks an unknown language unsupported instead of unavailable", async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      const provider = createLspStructureProvider({ documents: harness.authority, supervisor: language });
      const result = await provider.outline({
        path: "notes.bin",
        languageId: null,
        text: "data",
        revision: "rev",
        workspaceId: harness.identity.workspaceId,
      });
      expect(result.status).toBe("unsupported");
      expect(provider.capabilities(null).outline).toBe(false);
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });
});
