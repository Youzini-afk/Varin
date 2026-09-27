import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentInputContext, HarnessActorContext, HarnessServiceMap } from "@varin/protocol";
import { createNativeAuthorityTestRuntime } from "../kernel/native-authority.test-helper.js";
import { createDocumentAuthority } from "../documents/authority.js";
import { createSurfaceSnapshotStore } from "../documents/surface-snapshot-store.js";
import { createDocumentReadSourceService, createDocumentSurfaceWriteService } from "./harness-services.js";
import { attachLiveSurfaceCompleter, hashSurfaceText, type LiveSurfaceBuffer } from "../documents/contract-fixtures.js";
import { createHarnessPathAuthority } from "./path-authority.js";
import { createHarnessRouter } from "./router.js";
import { createHarnessServiceHost } from "./service-host.js";
import type { HarnessDocumentReadLookup } from "./service-host.js";

const disposes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposes.splice(0).reverse()) await dispose(); });

async function fixture(options: {
  lookup?: (sessionId: string, context: AgentInputContext, resourceId: string) => HarnessDocumentReadLookup | Promise<HarnessDocumentReadLookup>;
  readFsPromises?: Pick<typeof fs, "open" | "stat">;
} = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "varin-document-read-source-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const documents = createDocumentAuthority({
    hostId: "test-host",
    dataDir: path.join(root, "data"),
    isAllowedRoot: async () => true,
    isTrusted: async () => true,
  });
  const { workspaceId } = await documents.resolveWorkspace({ path: workspace });
  const native = await createNativeAuthorityTestRuntime({ documents, hostId: "test-host", dataDir: path.join(root, "data") });
  const actor: HarnessActorContext = {
    authorityInstanceId: "test-host",
    sessionId: "test-session",
    workerId: "worker",
    workerGeneration: 1,
    workspaceId,
    grantedCapabilities: ["read.document", "write.document"],
  };
  const paths = createHarnessPathAuthority({
    authorityId: "test-host",
    documents,
    ...(options.readFsPromises ? { readFsPromises: options.readFsPromises } : {}),
  });
  const host = createHarnessServiceHost({
    search: async () => ({ status: "empty", generation: undefined }),
    resolveWorkspaceRoot: async () => workspace,
    discoveredShells: {},
    documentReadSource: options.lookup ?? ((sessionId, context, resourceId) => (
      documents.readAgentInputSnapshot(sessionId, context, resourceId)
    )),
    readAuthorizedDiskFile: (ctx, authorized) => paths.readAuthorizedFile(ctx.actor, authorized, ctx.signal),
    documentSurfaceWrite: (sessionId, workspaceId, context, changes, signal) => (
      documents.applyAgentSurfaceWrite(sessionId, workspaceId, context, changes, signal)
    ),
  });
  let response: unknown;
  const router = createHarnessRouter({
    resolveActor: async () => actor,
    authorizeWorkspacePath: (current, input, options) => paths.resolve(current, input, options),
    respond: async (_sessionId, _requestId, result) => { response = result; },
  });
  router.register("document.readSource", createDocumentReadSourceService(host));
  router.register("document.surfaceWrite", createDocumentSurfaceWriteService(host));
  disposes.push(async () => {
    router.dispose();
    await host.dispose();
    await documents.dispose();
    await native.dispose();
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const request = async (resourcePath: string, inputContext?: AgentInputContext) => {
    await router.processEvent({
      kind: "host",
      actor,
      envelope: {
        kind: "event",
        event: "harness.request",
        data: {
          requestId: crypto.randomUUID(),
          method: "document.readSource",
          params: { path: resourcePath },
          ...(inputContext ? { inputContext } : {}),
        },
      },
    });
    return response as
      | { ok: true; result: HarnessServiceMap["document.readSource"]["result"] }
      | { ok: false; error: { code: string; message: string } };
  };
  const write = async (
    params: HarnessServiceMap["document.surfaceWrite"]["params"],
    inputContext?: AgentInputContext,
  ) => {
    await router.processEvent({
      kind: "host",
      actor,
      envelope: {
        kind: "event",
        event: "harness.request",
        data: {
          requestId: crypto.randomUUID(),
          method: "document.surfaceWrite",
          params,
          ...(inputContext ? { inputContext } : {}),
        },
      },
    });
    return response as
      | { ok: true; result: HarnessServiceMap["document.surfaceWrite"]["result"] }
      | { ok: false; error: { code: string; message: string } };
  };
  const capture = async (resourceId: string, content: string, localEditRevision: number, bom = false) => {
    const disk = await documents.read({ workspaceId, resourceId });
    const baseRevision = disk.status === "missing" ? null : disk.revision;
    const resource = { workspaceId, resourceId };
    await documents.publishDirtyBuffers({
      generation: 1,
      ownerId: "surface",
      resources: [{ baseRevision, localEditRevision, resource }],
      workspaceId,
    });
    return documents.captureAgentInputSnapshot({
      generation: 1,
      ownerId: "surface",
      resources: [{ baseRevision, bom, content, encoding: "utf-8", localEditRevision, resource }],
      sessionId: actor.sessionId,
      workspaceId,
    });
  };
  return { actor, capture, documents, paths, request, workspace, write };
}

describe("native read source through Host router and Documents", () => {
  it("matches equivalent resource casing when the workspace is case-insensitive", () => {
    const snapshots = createSurfaceSnapshotStore({ caseSensitive: false });
    const context = snapshots.capture({
      ownerId: "surface",
      sessionId: "session",
      workspaceId: "workspace",
      resources: [{
        baseRevision: null,
        bom: false,
        content: "fixed\n",
        encoding: "utf-8",
        localEditRevision: 1,
        resource: { workspaceId: "workspace", resourceId: "src/Draft.ts" },
      }],
    });

    expect(snapshots.read("session", context, "SRC/draft.ts")).toMatchObject({
      status: "ready",
      content: "fixed\n",
    });
    snapshots.dispose();
  });

  it("returns the fixed save-compatible draft bytes after the live surface changes", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspace, "draft.ts"), "disk value\n", "utf8");
    const context = await f.capture("draft.ts", "fixed draft\r\n", 3, true);
    await f.documents.publishDirtyBuffers({
      generation: 1,
      ownerId: "surface",
      resources: [{
        baseRevision: (await f.documents.read({ workspaceId: f.actor.workspaceId!, resourceId: "draft.ts" }) as { revision: string }).revision,
        localEditRevision: 4,
        resource: { workspaceId: f.actor.workspaceId!, resourceId: "draft.ts" },
      }],
      workspaceId: f.actor.workspaceId!,
    });

    const response = await f.request("draft.ts", context);

    expect(response.ok).toBe(true);
    if (!response.ok || response.result.source !== "surface-draft") throw new Error("Expected fixed surface bytes");
    expect(Buffer.from(response.result.base64, "base64").toString("utf8")).toBe("\uFEFFfixed draft\r\n");
    expect(response.result.revision).toMatch(/^surface-draft:/);
  });

  it("reads a dirty-only path and refuses disk fallback after the snapshot expires", async () => {
    const f = await fixture();
    const context = await f.capture("new.ts", "unsaved\n", 1);
    const ready = await f.request("new.ts", context);
    expect(ready).toMatchObject({ ok: true, result: { source: "surface-draft" } });

    await fs.writeFile(path.join(f.workspace, "new.ts"), "must not leak\n", "utf8");
    f.documents.dropAgentInputSnapshots(f.actor.sessionId);
    const expired = await f.request("new.ts", context);
    expect(expired).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify(expired)).not.toContain("must not leak");
  });

  it("reads back the agent's own write instead of the draft captured before it", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspace, "draft.ts"), "disk value\n", "utf8");
    const context = await f.capture("draft.ts", "unsaved editor value\n", 2);
    expect(await f.request("draft.ts", context)).toMatchObject({ ok: true, result: { source: "surface-draft" } });

    // The native write tool writes disk; the Host observes it through the Pi
    // mutation journal, exactly as index.ts wires observeToolWrite (D-088).
    await fs.writeFile(path.join(f.workspace, "draft.ts"), "agent write\n", "utf8");
    await f.documents.observeAgentWrite(f.actor.workspaceId!, path.join(f.workspace, "draft.ts"));

    // Disk bytes come from the Host after this same path was authorized.
    expect(await f.request("draft.ts", context)).toEqual({
      ok: true,
      result: { source: "disk", base64: Buffer.from("agent write\n").toString("base64") },
    });
    expect(f.documents.agentInputDraftPaths(f.actor.sessionId, context)).toEqual([]);
  });

  it("writes the fixed draft through the router and keeps disk unchanged", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspace, "draft.ts"), "A\n", "utf8");
    const disk = await f.documents.read({ workspaceId: f.actor.workspaceId!, resourceId: "draft.ts" });
    if (disk.status !== "ready") throw new Error("Expected draft fixture");
    const live = new Map<string, LiveSurfaceBuffer>();
    const binding = {
      baseRevision: disk.revision,
      localEditRevision: 2,
      documentInstanceId: "document-instance",
      bufferHash: hashSurfaceText("B\n"),
      encoding: "utf-8" as const,
      bom: false,
      lineEnding: "lf" as const,
      resource: { workspaceId: f.actor.workspaceId!, resourceId: "draft.ts" },
    };
    live.set("draft.ts", { ...binding, content: "B\n" });
    const surface = attachLiveSurfaceCompleter(f.documents, {
      generation: 1,
      live,
      ownerId: "surface",
      workspaceId: f.actor.workspaceId!,
    });
    await f.documents.publishDirtyBuffers({
      generation: 1,
      ownerId: "surface",
      resources: [binding],
      workspaceId: f.actor.workspaceId!,
    });
    const context = await f.documents.captureAgentInputSnapshot({
      generation: 1,
      ownerId: "surface",
      resources: [{ ...binding, content: "B\n" }],
      sessionId: f.actor.sessionId,
      workspaceId: f.actor.workspaceId!,
    });
    f.documents.commitAgentInputSnapshot(f.actor.sessionId, context);
    try {
      const written = await f.write({
        path: "draft.ts",
        action: "edit",
        edits: [{ oldText: "B\n", newText: "C\n" }],
      }, context);
      expect(written).toMatchObject({ ok: true, result: { status: "applied" } });
      if (!written.ok || written.result.status === "disk") throw new Error("Expected a surface write");
      expect(written.result.results[0]).toMatchObject({ target: "surface", status: "applied" });
      expect(live.get("draft.ts")?.content).toBe("C\n");
      expect(await fs.readFile(path.join(f.workspace, "draft.ts"), "utf8")).toBe("A\n");
      const reread = await f.request("draft.ts", context);
      expect(reread.ok).toBe(true);
      if (!reread.ok || reread.result.source !== "surface-draft") throw new Error("Expected updated draft");
      expect(Buffer.from(reread.result.base64, "base64").toString("utf8")).toBe("C\n");

      const diskPath = await f.write({
        path: "other.ts",
        action: "write",
        content: "plain\n",
      }, context);
      expect(diskPath, JSON.stringify(diskPath)).toMatchObject({ ok: true, result: { status: "applied", results: [{ target: "disk", status: "applied" }] } });
      expect(await fs.readFile(path.join(f.workspace, "other.ts"), "utf8")).toBe("plain\n");
    } finally {
      surface.close();
    }
  });

  it("returns bytes read from the authorized canonical disk target", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspace, "disk.txt"), "disk\n", "utf8");
    expect(await f.request("disk.txt", { source: "disk" })).toEqual({
      ok: true,
      result: { source: "disk", base64: Buffer.from("disk\n").toString("base64") },
    });
  });

  it("does not follow an original junction changed after path authorization", async () => {
    let releaseLookup!: () => void;
    let notifyLookup!: () => void;
    const lookupEntered = new Promise<void>((resolve) => { notifyLookup = resolve; });
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const f = await fixture({ lookup: async () => {
      notifyLookup();
      await lookupGate;
      return { status: "disk" };
    } });
    const inside = path.join(f.workspace, "inside");
    const outside = path.join(path.dirname(f.workspace), "outside");
    const workspaceLink = path.join(f.workspace, "alias");
    await fs.mkdir(inside);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(inside, "note.txt"), "authorized bytes\n");
    await fs.writeFile(path.join(outside, "note.txt"), "outside secret bytes\n");
    await fs.symlink(inside, workspaceLink, process.platform === "win32" ? "junction" : "dir");
    try {
      const pending = f.request("alias/note.txt", { source: "disk" });
      await lookupEntered;
      await fs.rm(workspaceLink, { recursive: true, force: true });
      await fs.symlink(outside, workspaceLink, process.platform === "win32" ? "junction" : "dir");
      releaseLookup();
      const response = await pending;
      expect(response).toMatchObject({ ok: false });
      expect(JSON.stringify(response)).not.toContain("outside secret bytes");
      expect(JSON.stringify(response)).not.toContain(Buffer.from("outside secret bytes\n").toString("base64"));
    } finally {
      releaseLookup();
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects bytes opened through a swapped parent after the junction is restored", async () => {
    let canonicalFile = "";
    let directory = "";
    let backup = "";
    let outside = "";
    let armed = true;
    let restored = false;
    let outsideBytesRead = false;
    const restore = async (): Promise<void> => {
      if (restored || armed) return;
      await fs.rm(directory, { recursive: true, force: true });
      await fs.rename(backup, directory);
      restored = true;
    };
    const readFsPromises = {
      open: async (target: string, flags: string | number) => {
        const samePath = process.platform === "win32"
          ? target.toLowerCase() === canonicalFile.toLowerCase()
          : target === canonicalFile;
        if (!armed || !samePath) return fs.open(target, flags);
        await fs.rename(directory, backup);
        armed = false;
        await fs.symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");
        const handle = await fs.open(target, flags);
        return {
          stat: (...args: Parameters<typeof handle.stat>) => handle.stat(...args),
          readFile: async (...args: Parameters<typeof handle.readFile>) => {
            try {
              const bytes = await handle.readFile(...args);
              outsideBytesRead = bytes.toString("utf8").includes("outside secret bytes\n");
              return bytes;
            } finally {
              // The fd still points at the outside file, while path resolution
              // sees the restored authorized tree. Identity comparison must
              // reject the bytes even though the path name looks safe again.
              await restore();
            }
          },
          close: () => handle.close(),
        } as typeof handle;
      },
      stat: (...args: Parameters<typeof fs.stat>) => fs.stat(...args),
    } as Pick<typeof fs, "open" | "stat">;
    const f = await fixture({ readFsPromises });
    directory = path.join(f.workspace, "tree");
    backup = `${directory}-authorized`;
    outside = path.join(path.dirname(f.workspace), "outside-tree");
    await fs.mkdir(directory);
    await fs.mkdir(outside);
    canonicalFile = path.join(directory, "note.txt");
    await fs.writeFile(canonicalFile, "authorized bytes\n");
    // Windows temp paths can use an 8.3 alias while path authority opens the
    // canonical long path. Match the actual authorized open target.
    canonicalFile = await fs.realpath(canonicalFile);
    await fs.writeFile(path.join(outside, "note.txt"), "outside secret bytes\n");
    try {
      const response = await f.request("tree/note.txt", { source: "disk" });
      expect(response).toMatchObject({ ok: false, error: { message: "Document path changed while reading" } });
      expect(JSON.stringify(response)).not.toContain("outside secret bytes");
      expect(JSON.stringify(response)).not.toContain(Buffer.from("outside secret bytes\n").toString("base64"));
      expect(restored).toBe(true);
      expect(outsideBytesRead).toBe(true);
      expect(await fs.readFile(canonicalFile, "utf8")).toBe("authorized bytes\n");
    } finally {
      await restore();
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("routes one multi-change write across two resource roots without misrouting resource ids", async () => {
    const f = await fixture();
    const outsideDir = path.join(path.dirname(f.workspace), "external-b");
    await fs.mkdir(outsideDir);
    const outsideMapping = await f.documents.resolveWorkspace({ path: outsideDir });
    const outsideFile = path.join(outsideDir, "out.txt");
    const written = await f.write({
      changes: [
        { path: "in-workspace.txt", action: "write", content: "A root payload\n" },
        { path: outsideFile, action: "write", content: "B root payload\n" },
      ],
    }, { source: "disk" });
    expect(written, JSON.stringify(written)).toMatchObject({ ok: true, result: { status: "applied" } });
    if (!written.ok || written.result.status === "disk") throw new Error("Expected an applied surface write");
    expect(written.result.results).toHaveLength(2);
    expect(written.result.results[0]).toMatchObject({ path: "in-workspace.txt", status: "applied" });
    expect(written.result.results[1]).toMatchObject({ path: "out.txt", status: "applied" });
    expect(await fs.readFile(path.join(f.workspace, "in-workspace.txt"), "utf8")).toBe("A root payload\n");
    expect(await fs.readFile(outsideFile, "utf8")).toBe("B root payload\n");
    // The external file stays reachable through its own resource root for rereads.
    const reread = await f.request(outsideFile, { source: "disk" });
    expect(reread.ok).toBe(true);
    if (!reread.ok || reread.result.source !== "disk") throw new Error("Expected disk bytes");
    expect(Buffer.from(reread.result.base64, "base64").toString("utf8")).toBe("B root payload\n");
    expect(outsideMapping.workspaceId).not.toBe(f.actor.workspaceId);
  });
});
