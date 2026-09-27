import { describe, expect, it, vi } from "vitest";
import type { FetchResult } from "@varin/protocol";
import { createMaterialReadService } from "./material-read-service.js";
import { createUserMaterialReadAdapter } from "./material-read-ui-adapter.js";
import type { HarnessServiceContext } from "./router.js";
import type { HarnessServiceHost } from "./service-host.js";

const result: FetchResult = { status: "ok", url: "file:///repo/paper.pdf", finalUrl: "file:///repo/paper.pdf", contentType: "application/pdf", markdown: "", bytes: 0, fromCache: false, rendered: false };
const actor = { authorityInstanceId: "host", sessionId: "session", workerId: "worker", workerGeneration: 1, workspaceId: "execution", grantedCapabilities: [] };
const authorized = { authorityId: "host", workspaceId: "execution", canonicalResourceId: "/repo/paper.pdf", inputPath: "paper.pdf", resourceId: "paper.pdf" };
const context: HarnessServiceContext = { actor, sessionId: "session", workspaceId: "execution", authorizedPaths: [authorized], signal: new AbortController().signal };
function fixture() {
  const ingest = vi.fn(async () => result);
  const read = vi.fn(async () => result);
  const readMaterialFile = vi.fn(async () => Buffer.from("%PDF-1.7\nfixed bytes"));
  const host = {
    documentReader: { ingest, read }, readMaterialFile,
    getWebBinding: () => ({ generation: "1", settings: { domains: { block: ["blocked.example"] } } }),
    documentReadingSettings: async () => ({ doclingCommand: "docling", tesseractCommand: "tesseract", ocrLanguage: "eng" }),
    threadRegistry: { getSessionBinding: async () => ({ owningScopeId: "owner", threadId: "thread", runId: "run" }) },
  } as unknown as HarnessServiceHost;
  return { host, ingest, read, readMaterialFile };
}

describe("material reading authority", () => {
  it("ingests only authorized local bytes and preserves the requested independent view", async () => {
    const f = fixture();
    await createMaterialReadService(f.host).handle({ path: "paper.pdf", view: "page-image", page: 3 }, context);
    expect(f.readMaterialFile).toHaveBeenCalledWith(context, authorized);
    expect(f.ingest).toHaveBeenCalledWith(expect.objectContaining({ source: Buffer.from("%PDF-1.7\nfixed bytes") }), expect.objectContaining({
      workspaceId: "owner", authority: { owningWorkspaceId: "owner", sessionId: "session", threadId: "thread", runId: "run" },
    }), { view: "page-image", page: 3 });
    expect(f.read).not.toHaveBeenCalled();
  });

  it("refuses a missing or mismatched authorized path before reading any bytes", async () => {
    const f = fixture();
    const service = createMaterialReadService(f.host);
    expect((await service.handle({ path: "secret.pdf" }, context)).status).toBe("failed");
    expect((await service.handle({ path: "paper.pdf" }, { ...context, authorizedPaths: [] })).status).toBe("failed");
    expect((await service.handle({ path: "paper.pdf", snapshotId: "snapshot" }, context)).status).toBe("failed");
    expect(f.readMaterialFile).not.toHaveBeenCalled();
    expect(f.ingest).not.toHaveBeenCalled();
  });

  it("reads an existing snapshot with current caller authority and domain policy", async () => {
    const f = fixture();
    await createMaterialReadService(f.host).handle({ snapshotId: "fixed", page: 2, ocr: true }, { ...context, authorizedPaths: [] });
    expect(f.read).toHaveBeenCalledWith({ snapshotId: "fixed", page: 2, ocr: true }, expect.objectContaining({
      domainPolicy: { block: ["blocked.example"] }, authority: expect.objectContaining({ sessionId: "session", threadId: "thread" }),
    }));
    expect(f.readMaterialFile).not.toHaveBeenCalled();
  });

  it("reads an existing snapshot from a session without a project", async () => {
    const f = fixture();
    f.host.threadRegistry = { getSessionBinding: async () => null } as never;
    await createMaterialReadService(f.host).handle({ snapshotId: "fixed" }, {
      ...context,
      actor: { ...actor, workspaceId: null },
      workspaceId: null,
      authorizedPaths: [],
    });
    expect(f.read).toHaveBeenCalledWith({ snapshotId: "fixed" }, expect.objectContaining({
      workspaceId: "session:session",
      authority: expect.objectContaining({ owningWorkspaceId: "session:session", sessionId: "session" }),
    }));
  });

  it("reads an authorized PDF outside the session's project", async () => {
    const f = fixture();
    const external = { ...authorized, workspaceId: "external-root", canonicalResourceId: "/outside/paper.pdf" };
    await createMaterialReadService(f.host).handle({ path: "paper.pdf" }, {
      ...context,
      authorizedPaths: [external],
    });
    expect(f.readMaterialFile).toHaveBeenCalledWith(expect.anything(), external);
    expect(f.ingest).toHaveBeenCalledOnce();
  });

  it("authorizes UI local reads against the session execution workspace, not its parent material store", async () => {
    const f = fixture();
    const resolve = vi.fn(async () => authorized);
    const adapter = createUserMaterialReadAdapter(() => f.host, {
      scopeForSession: async () => ({ scopeId: "owner", parent: { kind: "thread", id: "thread" }, snapshot: { workspace: { kind: "workspace", id: "execution" } } as never }),
    }, { resolve });
    await adapter({ sessionId: "session", request: { path: "paper.pdf", view: "overview" }, signal: new AbortController().signal });
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "execution" }), "paper.pdf", { allowMissing: true });
    expect(f.ingest).toHaveBeenCalledOnce();
  });

  it("lets an unbound UI session read an external PDF through its resource root", async () => {
    const f = fixture();
    f.host.threadRegistry = { getSessionBinding: async () => null } as never;
    const external = { ...authorized, workspaceId: "external-root", canonicalResourceId: "/outside/paper.pdf" };
    const resolve = vi.fn(async () => external);
    const adapter = createUserMaterialReadAdapter(() => f.host, {
      scopeForSession: async () => ({
        scopeId: "session:session",
        parent: { kind: "session", id: "session" },
        snapshot: { cwd: "/home/user" } as never,
      }),
    }, { resolve });

    await adapter({ sessionId: "session", request: { path: "paper.pdf" }, signal: new AbortController().signal });
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: null, authorityRoot: "/home/user" }), "paper.pdf", { allowMissing: true });
    expect(f.readMaterialFile).toHaveBeenCalledWith(expect.anything(), external);
    expect(f.ingest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workspaceId: "session:session" }), expect.anything());
  });

  it("uses experiment access before importing an artifact and refuses a tool without that capability", async () => {
    const f = fixture();
    const readArtifact = vi.fn(async () => ({ name: "plot.pdf", chunks: (async function* () { yield Buffer.from("%PDF-1.7\nplot"); })() }));
    f.host.experimentService = { readArtifact } as never;
    f.host.threadRegistry = { getSessionBinding: async () => null, listThreads: async () => [] } as never;
    const service = createMaterialReadService(f.host);
    const request = { artifact: { attemptId: "attempt", artifactId: "artifact" }, view: "overview" as const };
    expect((await service.handle(request, context)).status).toBe("failed");
    expect(readArtifact).not.toHaveBeenCalled();
    await service.handle(request, { ...context, requestSource: "user", authorizedPaths: [] });
    expect(readArtifact).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session", rootSessionId: "session", allowedThreadIds: [] }), "attempt", "artifact", context.signal);
    expect(f.ingest).toHaveBeenCalledWith(expect.objectContaining({ sourceUrl: "experiment://attempt/artifact", title: "plot.pdf" }), expect.anything(), { view: "overview" });
  });
});
