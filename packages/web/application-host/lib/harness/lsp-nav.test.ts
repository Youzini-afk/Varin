import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { HarnessServiceContext } from "./router.js";
import { createLspNavigationServices } from "./lsp-nav.js";
import { createDocumentAuthorityHarness } from "../documents/contract-fixtures.js";
import { AGENT_LANGUAGE_VIEW, SURFACE_LANGUAGE_VIEW, createLanguageSupervisor } from "../lsp/supervisor.js";
import { VARIN_LSP_FIXTURE_SERVER_ARGS } from "../lsp/servers.js";

const context: HarnessServiceContext = {
  actor: {
    authorityInstanceId: "host-1",
    sessionId: "session-1",
    workerId: "worker-1",
    workerGeneration: 1,
    workspaceId: "workspace-1",
    grantedCapabilities: ["read.lsp"],
  },
  authorizedPaths: [],
  sessionId: "session-1",
  workspaceId: "workspace-1",
  signal: new AbortController().signal,
};

const createDeps = () => {
  const documents = {
    read: vi.fn(async () => ({ status: "ready", content: "export const value = 1;", resource: { workspaceId: "workspace-1", resourceId: "src/a.ts" }, revision: "r1", encoding: "utf-8", bom: false, byteLength: 23, epoch: 1 })),
    readAgentInputSnapshot: vi.fn(() => ({ status: "disk" as const })),
  };
  const supervisor = {
    syncDocument: vi.fn(async () => ({ status: "synced", documentVersion: 1 })),
    workspaceSymbols: vi.fn(async () => ({
      status: "ready",
      value: [{ name: "value", kind: 13, resource: { workspaceId: "workspace-1", resourceId: "src/a.ts" }, range: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } } }],
    })),
    definition: vi.fn(async () => ({
      status: "ready",
      value: [{ resource: { workspaceId: "workspace-1", resourceId: "src/b.ts" }, targetSelectionRange: { start: { line: 4, character: 2 }, end: { line: 4, character: 7 } } }],
    })),
    references: vi.fn(async () => ({
      status: "ready",
      value: [{ resource: { workspaceId: "workspace-1", resourceId: "src/c.ts" }, range: { start: { line: 8, character: 1 }, end: { line: 8, character: 6 } } }],
    })),
    hover: vi.fn(async () => ({
      status: "ready",
      value: { contents: [{ kind: "markdown", value: "`value: number`" }, { kind: "plaintext", value: "Current value" }] },
    })),
  };
  return { documents, supervisor };
};

describe("LSP navigation services", () => {
  it('distinguishes file contention from a missing language server', async () => {
    const deps = createDeps();
    deps.documents.read.mockRejectedValueOnce(new Error('operation error: file resource is busy under lease file-lease:other'));
    const services = createLspNavigationServices(deps as never);
    const result = await services.definition.handle({ path: 'src/a.ts', line: 1 }, context);
    expect(result.status).toBe('busy');
    expect(result.text).not.toContain('unavailable');
    expect((await services.definition.handle({ path: 'src/a.ts', line: 1 }, context)).status).toBe('ready');
  });
  it("binds the queried document in the Host view and reports its revision", async () => {
    const deps = createDeps();
    const services = createLspNavigationServices(deps as never);
    const result = await services.symbols.handle({ path: "src/a.ts", query: "value" }, context);
    expect(result).toMatchObject({ status: "ready", revision: "r1", source: "disk" });
    expect(result.text).toContain("src/a.ts:1:14 — value");
    expect(result.text).toContain("queried src/a.ts @ r1 (disk)");
    expect(deps.documents.read).toHaveBeenCalledOnce();
    expect(deps.supervisor.syncDocument).toHaveBeenCalledWith(expect.objectContaining({
      view: AGENT_LANGUAGE_VIEW,
      languageId: "typescript",
      contentRevision: "r1",
      reason: "open",
    }), { signal: context.signal });
    expect(deps.supervisor.workspaceSymbols).toHaveBeenCalledWith(expect.objectContaining({
      view: AGENT_LANGUAGE_VIEW,
      expectedRevision: "r1",
    }));
  });

  it("binds an authorized external file by its resource root in a projectless session", async () => {
    const deps = createDeps();
    const services = createLspNavigationServices(deps as never);
    const outside = {
      ...context,
      workspaceId: null,
      actor: { ...context.actor, workspaceId: null },
      authorizedPaths: [{
        authorityId: "host-1",
        workspaceId: "external-root",
        resourceId: "src/a.ts",
        canonicalResourceId: "/external/src/a.ts",
        inputPath: "/external/src/a.ts",
      }],
    } satisfies HarnessServiceContext;

    const result = await services.symbols.handle({ path: "/external/src/a.ts", query: "value" }, outside);
    expect(result.status).toBe("ready");
    expect(deps.documents.read).toHaveBeenCalledWith({ workspaceId: "external-root", resourceId: "src/a.ts" });
    expect(deps.supervisor.syncDocument).toHaveBeenCalledWith(expect.objectContaining({
      resource: { workspaceId: "external-root", resourceId: "src/a.ts" },
    }), { signal: context.signal });
  });

  it("passes the authorized root when consulting a fixed editor draft", async () => {
    const deps = createDeps();
    const services = createLspNavigationServices(deps as never);
    const outside = {
      ...context,
      authorizedPaths: [{
        authorityId: "host-1",
        workspaceId: "external-root",
        resourceId: "src/a.ts",
        canonicalResourceId: "/external/src/a.ts",
        inputPath: "/external/src/a.ts",
      }],
      inputContext: { source: "surface" as const, roots: [{ workspaceId: "workspace-1", dirtyPaths: ["src/a.ts"] }], snapshot: { status: "ready" as const, ref: "ref-1" } },
    } satisfies HarnessServiceContext;

    await services.hover.handle({ path: "/external/src/a.ts", line: 1 }, outside);
    expect(deps.documents.readAgentInputSnapshot).toHaveBeenCalledWith(
      "session-1", outside.inputContext, "src/a.ts", "external-root",
    );
  });

  it("reads the turn's fixed editor draft instead of disk for a dirty path", async () => {
    const deps = createDeps();
    deps.documents.readAgentInputSnapshot = vi.fn(() => ({
      status: "ready" as const,
      content: "export const value = 2;",
      revision: "surface-draft:ref-1:4",
      encoding: "utf-8",
      bom: false,
      source: "surface-draft" as const,
    })) as never;
    const services = createLspNavigationServices(deps as never);
    const draftContext = {
      ...context,
      inputContext: { source: "surface" as const, roots: [{ workspaceId: "workspace-1", dirtyPaths: ["src/a.ts"] }], snapshot: { status: "ready" as const, ref: "ref-1" } },
    };
    const result = await services.hover.handle({ path: "src/a.ts", line: 1 }, draftContext);
    expect(result).toMatchObject({ status: "ready", revision: "surface-draft:ref-1:4", source: "surface-draft" });
    expect(deps.documents.read).not.toHaveBeenCalled();
    expect(deps.supervisor.syncDocument).toHaveBeenCalledWith(expect.objectContaining({
      content: "export const value = 2;",
      contentRevision: "surface-draft:ref-1:4",
    }), { signal: context.signal });
  });

  it("binds an aliased child working-branch source through the shared read callback", async () => {
    const deps = createDeps();
    const readSource = vi.fn(async () => ({
      status: "working-branch" as const,
      base64: Buffer.from("export const value = 3;").toString("base64"),
      revision: "working-branch:child@4",
      provenance: { branchId: "child", revision: 4, origin: "delta" as const },
    }));
    const services = createLspNavigationServices({ ...deps, readSource } as never);
    const fixedContext = {
      ...context,
      inputContext: { source: "surface" as const, roots: [{ workspaceId: "workspace-1", dirtyPaths: ["src/a.ts"] }], snapshot: { status: "ready" as const, ref: "source-view:fixed" } },
    };
    const result = await services.hover.handle({ path: "src/a.ts", line: 1 }, fixedContext);
    expect(result).toMatchObject({ status: "ready", revision: "working-branch:child@4", source: "working-branch" });
    expect(readSource).toHaveBeenCalledWith(context.sessionId, fixedContext.inputContext, "src/a.ts", "workspace-1");
    expect(deps.documents.read).not.toHaveBeenCalled();
    expect(deps.supervisor.syncDocument).toHaveBeenCalledWith(expect.objectContaining({
      content: "export const value = 3;", contentRevision: "working-branch:child@4",
    }), { signal: context.signal });
  });

  it("never falls back to disk when a known dirty path has no fixed draft", async () => {
    const deps = createDeps();
    deps.documents.readAgentInputSnapshot = vi.fn(() => ({
      status: "unavailable" as const,
      message: "The editor source snapshot expired on the application host.",
    })) as never;
    const services = createLspNavigationServices(deps as never);
    const expiredContext = {
      ...context,
      inputContext: { source: "surface" as const, roots: [{ workspaceId: "workspace-1", dirtyPaths: ["src/a.ts"] }], snapshot: { status: "ready" as const, ref: "ref-1" } },
    };
    await expect(services.hover.handle({ path: "src/a.ts", line: 1 }, expiredContext)).resolves.toMatchObject({
      status: "unavailable",
    });
    expect(deps.documents.read).not.toHaveBeenCalled();
    expect(deps.supervisor.syncDocument).not.toHaveBeenCalled();
  });

  it("uses the path authority resource identity for an absolute input", async () => {
    const deps = createDeps();
    const services = createLspNavigationServices(deps as never);
    const absoluteContext = {
      ...context,
      authorizedPaths: [{
        authorityId: "host-1",
        workspaceId: "workspace-1",
        canonicalResourceId: "/workspace/src/a.ts",
        inputPath: "/workspace/src/a.ts",
        resourceId: "src/a.ts",
      }],
    };
    await services.hover.handle({ path: "/workspace/src/a.ts", line: 1 }, absoluteContext);
    expect(deps.documents.read).toHaveBeenCalledWith({ workspaceId: "workspace-1", resourceId: "src/a.ts" });
  });

  it("converts agent-facing one-based positions and marks positions in other files unpinned", async () => {
    const deps = createDeps();
    const services = createLspNavigationServices(deps as never);
    const definition = await services.definition.handle({ path: "src/a.ts", line: 7, character: 3 }, context);
    expect(definition.text).toContain("src/b.ts:5:3 [unpinned]");
    expect(definition).toMatchObject({ unpinnedPaths: ["src/b.ts"] });
    expect(deps.supervisor.definition).toHaveBeenCalledWith(expect.objectContaining({
      position: { line: 6, character: 2 },
    }));
    const references = await services.references.handle({ path: "src/a.ts", line: 7 }, context);
    expect(references.text).toContain("1 references · queried src/a.ts @ r1 (disk)");
    expect(references.text).toContain("src/c.ts:9:2 [unpinned]");
    const hover = await services.hover.handle({ path: "src/a.ts", line: 7 }, context);
    expect(hover.text).toContain("`value: number`\n\nCurrent value");
    expect(hover.unpinnedPaths).toBeUndefined();
  });

  it("re-binds once when the view moved to another revision, then reports it", async () => {
    const deps = createDeps();
    deps.supervisor.hover = vi.fn()
      .mockResolvedValueOnce({ status: "stale", reason: "revision", contentRevision: "r2" })
      .mockResolvedValueOnce({ status: "ready", value: { contents: [{ kind: "plaintext", value: "second try" }] } }) as never;
    const services = createLspNavigationServices(deps as never);
    await expect(services.hover.handle({ path: "src/a.ts", line: 1 }, context)).resolves.toMatchObject({
      status: "ready",
    });
    expect(deps.supervisor.hover).toHaveBeenCalledTimes(2);

    const looping = createDeps();
    looping.supervisor.hover = vi.fn(async () => ({ status: "stale", reason: "revision" })) as never;
    const loopingServices = createLspNavigationServices(looping as never);
    await expect(loopingServices.hover.handle({ path: "src/a.ts", line: 1 }, context)).resolves.toMatchObject({
      status: "unavailable",
    });
    expect(looping.supervisor.hover).toHaveBeenCalledTimes(2);
  });

  it("keeps unsupported files, empty results, and provider failures distinct", async () => {
    const deps = createDeps();
    const services = createLspNavigationServices(deps as never);
    await expect(services.hover.handle({ path: "README.unknown", line: 1 }, context)).resolves.toMatchObject({ status: "unavailable" });
    deps.supervisor.references.mockResolvedValueOnce({ status: "ready", value: [] });
    await expect(services.references.handle({ path: "src/a.ts", line: 1 }, context)).resolves.toMatchObject({ status: "empty" });
    deps.supervisor.definition.mockResolvedValueOnce({ status: "failed", message: "server exited" } as never);
    await expect(services.definition.handle({ path: "src/a.ts", line: 1 }, context)).resolves.toMatchObject({ status: "unavailable", text: "LSP unavailable: server exited" });
  });

  it("serves navigation through a real LanguageSupervisor process without touching the editor view", async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      await fs.promises.writeFile(path.join(harness.workspaceRoot, "fixture.ts"), "export const fixture = true;\n");
      language.registerProvider({
        providerId: "fixture",
        command: process.execPath,
        args: VARIN_LSP_FIXTURE_SERVER_ARGS,
        languageIds: ["typescript"],
        source: "host",
      });
      const services = createLspNavigationServices({ documents: harness.authority, supervisor: language });
      const realContext = { ...context, workspaceId: harness.identity.workspaceId, actor: { ...context.actor, workspaceId: harness.identity.workspaceId } };
      const hover = await services.hover.handle({ path: "fixture.ts", line: 1, character: 1 }, realContext);
      expect(hover).toMatchObject({ status: "ready", source: "disk" });
      expect(hover.text).toContain("fixture-hover");
      expect(hover.revision).toBeTruthy();
      await expect(services.symbols.handle({ path: "fixture.ts", query: "fixture" }, realContext)).resolves.toMatchObject({
        status: "ready",
      });
      expect(language.getStatus(harness.identity.workspaceId, "typescript", AGENT_LANGUAGE_VIEW).status).toBe("ready");
      expect(language.getStatus(harness.identity.workspaceId, "typescript", SURFACE_LANGUAGE_VIEW).status).toBe("absent");
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it("writes a disk-bound references result back through recordRelations", async () => {
    const deps = createDeps();
    const recordRelations = vi.fn(async () => ({ recorded: 1 }));
    const services = createLspNavigationServices({ ...deps, recordRelations } as never);
    const result = await services.references.handle({ path: "src/a.ts", line: 1, character: 14 }, context);
    expect(result.status).toBe("ready");
    await vi.waitFor(() => expect(recordRelations).toHaveBeenCalledOnce());
    expect(recordRelations).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      anchor: { path: "src/a.ts", line: 1, character: 14 },
      anchorRevision: "r1",
      name: "value",
      resolvedBy: "lsp.references",
      sites: [{ path: "src/c.ts", line: 9, character: 2 }],
    }));
  });

  it("filters LSP locations and write-behind rows to the actor workspace scope", async () => {
    const deps = createDeps();
    deps.supervisor.references.mockResolvedValueOnce({
      status: "ready",
      value: [
        { resource: { workspaceId: "workspace-1", resourceId: "src/c.ts" }, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } },
        { resource: { workspaceId: "workspace-1", resourceId: "secret/c.ts" }, range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } } },
      ],
    });
    const recordRelations = vi.fn(async () => ({ recorded: 1 }));
    const services = createLspNavigationServices({ ...deps, recordRelations } as never);
    const scopedContext = { ...context, actor: { ...context.actor, workspaceScope: ["src"] } };
    const result = await services.references.handle({ path: "src/a.ts", line: 1, character: 14 }, scopedContext);
    expect(result.text).toContain("src/c.ts");
    expect(result.text).not.toContain("secret/c.ts");
    expect(JSON.stringify(result.value)).not.toContain("secret/c.ts");
    await vi.waitFor(() => expect(recordRelations).toHaveBeenCalledOnce());
    expect(recordRelations).toHaveBeenCalledWith(expect.objectContaining({
      sites: [{ path: "src/c.ts", line: 2, character: 1 }],
    }));
  });

  it("does not persist a surface-draft-bound answer as a graph fact", async () => {
    const deps = createDeps();
    deps.documents.readAgentInputSnapshot = vi.fn(() => ({
      status: "ready" as const,
      content: "export const value = 2;",
      revision: "surface-draft:ref-1:4",
      encoding: "utf-8",
      bom: false,
      source: "surface-draft" as const,
    })) as never;
    const recordRelations = vi.fn(async () => ({ recorded: 0 }));
    const services = createLspNavigationServices({ ...deps, recordRelations } as never);
    const draftContext = {
      ...context,
      inputContext: { source: "surface" as const, roots: [{ workspaceId: "workspace-1", dirtyPaths: ["src/a.ts"] }], snapshot: { status: "ready" as const, ref: "ref-1" } },
    };
    const result = await services.references.handle({ path: "src/a.ts", line: 1, character: 14 }, draftContext);
    expect(result).toMatchObject({ status: "ready", source: "surface-draft" });
    // Give the (unconditional) write-behind a tick to run — it must not have.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(recordRelations).not.toHaveBeenCalled();
  });
});
