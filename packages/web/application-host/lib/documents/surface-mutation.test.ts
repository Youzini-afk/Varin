import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentInputContext, DocumentSurfaceWritePathResult } from "@varin/protocol";
import type { DirtyBufferPublication, DocumentSurfaceOperationRequest, DocumentSurfaceOperationResult } from "./authority.js";
import { applyAgentSurfaceMutation, applyTextEdits } from "./surface-mutation.js";
import { beginAgentMutationOperationAsync, compensateAgentMutationDiskPath, finalizeAgentMutationOperation, reconcileInterruptedAgentMutations, type PersistedAgentMutationData } from "./agent-mutation-operation.js";
import type { SurfaceSnapshotInspectResult } from "./surface-snapshot-store.js";
import type { DurableFileOperationContext } from "../recovery/durable-file-operation.js";
import type { RecoveryState } from "../recovery/journal-files.js";

const hash = (text: string) => `sha256-${createHash("sha256").update(text, "utf8").digest("hex")}`;

const context = (workspaceId: string, dirtyPaths: string[]): AgentInputContext => ({
  source: "surface",
  roots: [{ workspaceId, dirtyPaths: dirtyPaths.length ? dirtyPaths : ["unrelated.ts"] }],
  snapshot: { status: "ready", ref: "fixed" },
});

describe("applyTextEdits", () => {
  it("replaces a unique oldText once", () => {
    expect(applyTextEdits("alpha B omega", [{ oldText: "B", newText: "C" }])).toBe("alpha C omega");
  });

  it("refuses an empty or ambiguous replacement", () => {
    expect(() => applyTextEdits("B", [{ oldText: "", newText: "C" }])).toThrow(/empty/i);
    expect(() => applyTextEdits("B and B", [{ oldText: "B", newText: "C" }])).toThrow(/more than once/i);
    expect(() => applyTextEdits("A", [{ oldText: "B", newText: "C" }])).toThrow(/exact text/i);
    expect(() => applyTextEdits("aaa", [{ oldText: "aa", newText: "b" }])).toThrow(/more than once/i);
  });

  it("matches every replacement against the original text and rejects overlapping regions", () => {
    expect(applyTextEdits("X\nY", [{ oldText: "X", newText: "Y" }, { oldText: "Y", newText: "Z" }])).toBe("Y\nZ");
    expect(() => applyTextEdits("alpha / beta", [
      { oldText: "alpha", newText: "ALPHA" }, { oldText: "ALPHA", newText: "OMEGA" },
    ])).toThrow(/exact text/i);
    expect(() => applyTextEdits("alpha beta", [
      { oldText: "alpha beta", newText: "whole" }, { oldText: "beta", newText: "part" },
    ])).toThrow(/overlap/i);
  });
});

describe("applyAgentSurfaceMutation", () => {
  it("returns the disk sentinel when no path is owned by the fixed snapshot", async () => {
    const { result, record } = await applyAgentSurfaceMutation({
      inspectSnapshot: () => ({ status: "disk" }),
      surfaceOwner: () => null,
      inspectDirtyBuffers: async () => [],
      requestSurfaceOperation: async () => {
        throw new Error("disk-only mutations must not dispatch a surface operation");
      },
      inspectWorkspace: async () => ({ epoch: 1 }),
      readDisk: async () => ({ status: "missing" }),
      writeDisk: async () => {
        throw new Error("disk-only mutations must stay on the journaled disk path");
      },
      deleteDisk: async () => {
        throw new Error("disk-only mutations must stay on the journaled disk path");
      },
    }, {
      sessionId: "s1",
      workspaceId: "ws",
      context: context("ws", []),
      changes: [{ resourceId: "plain.ts", action: "write", content: "n" }],
    });
    expect(result).toEqual({ status: "disk" });
    expect(record).toBeNull();
  });

  it("marks delete and NUL bytes unavailable on a surface path", async () => {
    const inspect: SurfaceSnapshotInspectResult = {
      status: "ready",
      bom: false,
      content: "B",
      encoding: "utf-8",
      localEditRevision: 2,
      baseRevision: "disk-a",
      revision: "surface-draft:fixed:2",
      resource: { workspaceId: "ws", resourceId: "draft.ts" },
      source: "surface-draft",
    };
    const deleted = await applyAgentSurfaceMutation({
      inspectSnapshot: () => inspect,
      surfaceOwner: () => ({ ownerId: "surface", generation: 1, workspaceId: "ws" }),
      inspectDirtyBuffers: async () => [],
      requestSurfaceOperation: async () => {
        throw new Error("unavailable surface ops must not dispatch");
      },
      inspectWorkspace: async () => ({ epoch: 1 }),
      readDisk: async () => ({ status: "ready", content: "A", revision: "disk-a" }),
      writeDisk: async () => ({ status: "written", revision: "disk-b" }),
      deleteDisk: async () => ({ status: "deleted" }),
    }, {
      sessionId: "s1",
      workspaceId: "ws",
      context: context("ws", ["draft.ts"]),
      changes: [{ resourceId: "draft.ts", action: "delete" }],
    });
    expect(deleted.result.status).toBe("unavailable");
    expect(deleted.result.status === "disk" ? "" : deleted.result.results[0]?.target).toBe("surface");

    const binary = await applyAgentSurfaceMutation({
      inspectSnapshot: () => inspect,
      surfaceOwner: () => ({ ownerId: "surface", generation: 1, workspaceId: "ws" }),
      inspectDirtyBuffers: async () => [],
      requestSurfaceOperation: async () => {
        throw new Error("binary surface writes must not dispatch");
      },
      inspectWorkspace: async () => ({ epoch: 1 }),
      readDisk: async () => ({ status: "ready", content: "A", revision: "disk-a" }),
      writeDisk: async () => ({ status: "written", revision: "disk-b" }),
      deleteDisk: async () => ({ status: "deleted" }),
    }, {
      sessionId: "s1",
      workspaceId: "ws",
      context: context("ws", ["draft.ts"]),
      changes: [{ resourceId: "draft.ts", action: "write", content: "bin\0ary" }],
    });
    expect(binary.result.status).toBe("unavailable");
  });

  it("compensates an applied surface path when a later disk path fails", async () => {
    const draftInspect: SurfaceSnapshotInspectResult = {
      status: "ready",
      bom: false,
      content: "B",
      encoding: "utf-8",
      localEditRevision: 2,
      baseRevision: "disk-a",
      revision: "surface-draft:fixed:2",
      resource: { workspaceId: "ws", resourceId: "draft.ts" },
      source: "surface-draft",
    };
    const publication: DirtyBufferPublication = {
      generation: 1,
      ownerId: "surface",
      registrationId: "reg-1",
      resources: [{
        baseRevision: "disk-a",
        localEditRevision: 2,
        documentInstanceId: "doc-1",
        bufferHash: hash("B"),
        encoding: "utf-8",
        bom: false,
        lineEnding: "lf",
        resource: { workspaceId: "ws", resourceId: "draft.ts" },
      }],
      updatedAt: new Date().toISOString(),
      workspaceId: "ws",
    };
    const ops: Array<{ action: string; operationId: string; targets: number }> = [];
    let applyId = "";
    const { result } = await applyAgentSurfaceMutation({
      inspectSnapshot: (_session, _context, resourceId) => (
        resourceId === "draft.ts" ? draftInspect : { status: "disk" }
      ),
      surfaceOwner: () => ({ ownerId: "surface", generation: 1, workspaceId: "ws" }),
      inspectDirtyBuffers: async () => [publication],
      requestSurfaceOperation: async (request: DocumentSurfaceOperationRequest) => {
        ops.push({ action: request.action, operationId: request.operationId, targets: request.targets.length });
        if (request.action === "apply") {
          applyId = request.operationId;
          return [{
            resource: { workspaceId: "ws", resourceId: "draft.ts" },
            status: "applied",
            documentInstanceId: "doc-1",
            beforeLocalEditRevision: 2,
            beforeHash: hash("B"),
            afterLocalEditRevision: 3,
            afterHash: hash("C"),
          } satisfies DocumentSurfaceOperationResult];
        }
        if (request.operationId !== applyId || request.operationId.endsWith(":undo")) {
          return [{
            resource: { workspaceId: "ws", resourceId: "draft.ts" },
            status: "failed",
            message: "The surface undo baseline is unavailable",
          }];
        }
        return [{
          resource: { workspaceId: "ws", resourceId: "draft.ts" },
          status: "undone",
          documentInstanceId: "doc-1",
          content: "B",
          afterLocalEditRevision: 4,
          afterHash: hash("B"),
        }];
      },
      inspectWorkspace: async () => ({ epoch: 1 }),
      readDisk: async (_workspaceId, resourceId) => (
        resourceId === "other.ts"
          ? { status: "binary" as const, revision: "disk-x" }
          : { status: "ready" as const, content: "A", revision: "disk-a" }
      ),
      writeDisk: async () => {
        throw new Error("failed disk path must not write");
      },
      deleteDisk: async () => ({ status: "deleted" }),
    }, {
      sessionId: "s1",
      workspaceId: "ws",
      context: context("ws", ["draft.ts"]),
      changes: [
        { resourceId: "draft.ts", action: "edit", edits: [{ oldText: "B", newText: "C" }] },
        { resourceId: "other.ts", action: "write", content: "disk-new" },
      ],
    });
    expect(ops.map((entry) => entry.action)).toEqual(["apply", "undo"]);
    expect(ops[0]?.operationId).toBe(ops[1]?.operationId);
    expect(ops[1]?.targets).toBe(1);
    expect(result.status).toBe("conflict");
    if (result.status === "disk") throw new Error("expected mixed results");
    const byPath = Object.fromEntries(result.results.map((row: DocumentSurfaceWritePathResult) => [row.path, row]));
    expect(byPath["draft.ts"]).toMatchObject({ target: "surface", status: "compensated" });
    expect(byPath["other.ts"]).toMatchObject({ target: "disk", status: "unavailable" });
    expect(result.message).toMatch(/compensated/);
  });

  it("compensates with a fresh signal after the forward mutation is aborted", async () => {
    const draftInspect: SurfaceSnapshotInspectResult = {
      status: "ready",
      bom: false,
      content: "B",
      encoding: "utf-8",
      localEditRevision: 2,
      baseRevision: "disk-a",
      revision: "surface-draft:fixed:2",
      resource: { workspaceId: "ws", resourceId: "draft.ts" },
      source: "surface-draft",
    };
    const publication: DirtyBufferPublication = {
      generation: 1,
      ownerId: "surface",
      registrationId: "reg-1",
      resources: [{
        baseRevision: "disk-a",
        localEditRevision: 2,
        documentInstanceId: "doc-1",
        bufferHash: hash("B"),
        encoding: "utf-8",
        bom: false,
        lineEnding: "lf",
        resource: { workspaceId: "ws", resourceId: "draft.ts" },
      }],
      updatedAt: new Date().toISOString(),
      workspaceId: "ws",
    };
    const forward = new AbortController();
    const { result } = await applyAgentSurfaceMutation({
      inspectSnapshot: (_session, _context, resourceId) => (
        resourceId === "draft.ts" ? draftInspect : { status: "disk" }
      ),
      surfaceOwner: () => ({ ownerId: "surface", generation: 1, workspaceId: "ws" }),
      inspectDirtyBuffers: async () => [publication],
      requestSurfaceOperation: async (request, options) => {
        if (request.action === "apply") {
          forward.abort();
          return [{
            resource: { workspaceId: "ws", resourceId: "draft.ts" },
            status: "applied",
            documentInstanceId: "doc-1",
            beforeLocalEditRevision: 2,
            beforeHash: hash("B"),
            afterLocalEditRevision: 3,
            afterHash: hash("C"),
          }];
        }
        expect(options?.signal?.aborted).toBeFalsy();
        expect(request.operationId.endsWith(":undo")).toBe(false);
        return [{
          resource: { workspaceId: "ws", resourceId: "draft.ts" },
          status: "undone",
          documentInstanceId: "doc-1",
          content: "B",
          afterLocalEditRevision: 4,
          afterHash: hash("B"),
        }];
      },
      inspectWorkspace: async () => ({ epoch: 1 }),
      readDisk: async () => ({ status: "ready", content: "A", revision: "disk-a" }),
      writeDisk: async () => {
        throw new Error("aborted mutations must not write disk");
      },
      deleteDisk: async () => ({ status: "deleted" }),
    }, {
      sessionId: "s1",
      workspaceId: "ws",
      context: context("ws", ["draft.ts"]),
      changes: [
        { resourceId: "draft.ts", action: "edit", edits: [{ oldText: "B", newText: "C" }] },
        { resourceId: "other.ts", action: "write", content: "disk-new" },
      ],
      signal: forward.signal,
    });
    expect(result.status).toBe("conflict");
    if (result.status === "disk") throw new Error("expected mixed results");
    expect(result.results.find((row) => row.path === "draft.ts")).toMatchObject({
      target: "surface",
      status: "compensated",
    });
  });

  it("leaves a later user edit untouched when compensation can no longer match the applied buffer", async () => {
    const draftInspect: SurfaceSnapshotInspectResult = {
      status: "ready",
      bom: false,
      content: "B",
      encoding: "utf-8",
      localEditRevision: 2,
      baseRevision: "disk-a",
      revision: "surface-draft:fixed:2",
      resource: { workspaceId: "ws", resourceId: "draft.ts" },
      source: "surface-draft",
    };
    const publication: DirtyBufferPublication = {
      generation: 1,
      ownerId: "surface",
      registrationId: "reg-1",
      resources: [{
        baseRevision: "disk-a",
        localEditRevision: 2,
        documentInstanceId: "doc-1",
        bufferHash: hash("B"),
        encoding: "utf-8",
        bom: false,
        lineEnding: "lf",
        resource: { workspaceId: "ws", resourceId: "draft.ts" },
      }],
      updatedAt: new Date().toISOString(),
      workspaceId: "ws",
    };
    const { result } = await applyAgentSurfaceMutation({
      inspectSnapshot: (_session, _context, resourceId) => (
        resourceId === "draft.ts" ? draftInspect : { status: "disk" }
      ),
      surfaceOwner: () => ({ ownerId: "surface", generation: 1, workspaceId: "ws" }),
      inspectDirtyBuffers: async () => [publication],
      requestSurfaceOperation: async (request) => {
        if (request.action === "undo" && request.operationId.endsWith(":undo")) {
          throw new Error("compensation must reuse the apply operationId");
        }
        if (request.action === "apply") {
          return [{
            resource: { workspaceId: "ws", resourceId: "draft.ts" },
            status: "applied",
            documentInstanceId: "doc-1",
            beforeLocalEditRevision: 2,
            beforeHash: hash("B"),
            afterLocalEditRevision: 3,
            afterHash: hash("C"),
          }];
        }
        return [{
          resource: { workspaceId: "ws", resourceId: "draft.ts" },
          status: "failed",
          message: "user continued editing",
          documentInstanceId: "doc-1",
          afterLocalEditRevision: 4,
          afterHash: hash("D"),
        }];
      },
      inspectWorkspace: async () => ({ epoch: 1 }),
      readDisk: async () => ({ status: "binary", revision: "disk-x" }),
      writeDisk: async () => ({ status: "conflict" }),
      deleteDisk: async () => ({ status: "conflict" }),
    }, {
      sessionId: "s1",
      workspaceId: "ws",
      context: context("ws", ["draft.ts"]),
      changes: [
        { resourceId: "draft.ts", action: "edit", edits: [{ oldText: "B", newText: "C" }] },
        { resourceId: "other.ts", action: "write", content: "disk-new" },
      ],
    });
    expect(result.status).toBe("conflict");
    if (result.status === "disk") throw new Error("expected mixed results");
    expect(result.results.find((row) => row.path === "draft.ts")).toMatchObject({
      target: "surface",
      status: "needs-attention",
    });
    expect(result.message).toMatch(/needs-attention/);
  });

  it("compares CRLF snapshot text to the editor-normalized bufferHash", async () => {
    const draftInspect: SurfaceSnapshotInspectResult = {
      status: "ready",
      bom: false,
      content: "B\r\n",
      encoding: "utf-8",
      localEditRevision: 2,
      baseRevision: "disk-a",
      revision: "surface-draft:fixed:2",
      resource: { workspaceId: "ws", resourceId: "draft.ts" },
      source: "surface-draft",
      bufferHash: hash("B\n"),
      lineEnding: "crlf",
    };
    const publication: DirtyBufferPublication = {
      generation: 1,
      ownerId: "surface",
      registrationId: "reg-1",
      resources: [{
        baseRevision: "disk-a",
        localEditRevision: 2,
        documentInstanceId: "doc-1",
        bufferHash: hash("B\n"),
        encoding: "utf-8",
        bom: false,
        lineEnding: "crlf",
        resource: { workspaceId: "ws", resourceId: "draft.ts" },
      }],
      updatedAt: new Date().toISOString(),
      workspaceId: "ws",
    };
    const { result } = await applyAgentSurfaceMutation({
      inspectSnapshot: () => draftInspect,
      surfaceOwner: () => ({ ownerId: "surface", generation: 1, workspaceId: "ws" }),
      inspectDirtyBuffers: async () => [publication],
      requestSurfaceOperation: async (request) => {
        expect(request.targets[0]?.newText).toBe("C\n");
        return [{
          resource: { workspaceId: "ws", resourceId: "draft.ts" },
          status: "applied",
          documentInstanceId: "doc-1",
          beforeLocalEditRevision: 2,
          beforeHash: hash("B\n"),
          afterLocalEditRevision: 3,
          afterHash: hash("C\n"),
        }];
      },
      inspectWorkspace: async () => ({ epoch: 1 }),
      readDisk: async () => ({ status: "ready", content: "A\r\n", revision: "disk-a" }),
      writeDisk: async () => {
        throw new Error("CRLF surface edits must not write disk");
      },
      deleteDisk: async () => ({ status: "deleted" }),
    }, {
      sessionId: "s1",
      workspaceId: "ws",
      context: context("ws", ["draft.ts"]),
      changes: [{ resourceId: "draft.ts", action: "edit", edits: [{ oldText: "B\n", newText: "C\n" }] }],
    });
    expect(result.status).toBe("applied");
  });

  it("undoes a two-path surface batch once with the apply operationId", async () => {
    const inspectFor = (resourceId: string, content: string): SurfaceSnapshotInspectResult => ({
      status: "ready",
      bom: false,
      content,
      encoding: "utf-8",
      localEditRevision: 2,
      baseRevision: "disk-a",
      revision: `surface-draft:fixed:2`,
      resource: { workspaceId: "ws", resourceId },
      source: "surface-draft",
    });
    const publication: DirtyBufferPublication = {
      generation: 1,
      ownerId: "surface",
      registrationId: "reg-1",
      resources: [
        {
          baseRevision: "disk-a",
          localEditRevision: 2,
          documentInstanceId: "doc-a",
          bufferHash: hash("A"),
          encoding: "utf-8",
          bom: false,
          lineEnding: "lf",
          resource: { workspaceId: "ws", resourceId: "a.ts" },
        },
        {
          baseRevision: "disk-a",
          localEditRevision: 2,
          documentInstanceId: "doc-b",
          bufferHash: hash("B"),
          encoding: "utf-8",
          bom: false,
          lineEnding: "lf",
          resource: { workspaceId: "ws", resourceId: "b.ts" },
        },
      ],
      updatedAt: new Date().toISOString(),
      workspaceId: "ws",
    };
    const ops: Array<{ action: string; operationId: string; targets: string[] }> = [];
    let applyId = "";
    const { result } = await applyAgentSurfaceMutation({
      inspectSnapshot: (_session, _context, resourceId) => (
        resourceId === "a.ts" ? inspectFor("a.ts", "A")
          : resourceId === "b.ts" ? inspectFor("b.ts", "B")
            : { status: "disk" }
      ),
      surfaceOwner: () => ({ ownerId: "surface", generation: 1, workspaceId: "ws" }),
      inspectDirtyBuffers: async () => [publication],
      requestSurfaceOperation: async (request, options) => {
        ops.push({
          action: request.action,
          operationId: request.operationId,
          targets: request.targets.map((target) => target.resource.resourceId),
        });
        if (request.action === "apply") {
          applyId = request.operationId;
          return request.targets.map((target, index) => ({
            resource: target.resource,
            status: "applied" as const,
            documentInstanceId: target.documentInstanceId,
            beforeLocalEditRevision: 2,
            beforeHash: target.bufferHash,
            afterLocalEditRevision: 3,
            afterHash: hash(index === 0 ? "C" : "D"),
          }));
        }
        expect(options?.signal?.aborted).toBeFalsy();
        expect(request.operationId).toBe(applyId);
        return request.targets.map((target) => ({
          resource: target.resource,
          status: "undone" as const,
          documentInstanceId: target.documentInstanceId,
          content: target.resource.resourceId === "a.ts" ? "A" : "B",
          afterLocalEditRevision: 4,
          afterHash: target.bufferHash,
        }));
      },
      inspectWorkspace: async () => ({ epoch: 1 }),
      readDisk: async () => ({ status: "binary", revision: "disk-x" }),
      writeDisk: async () => {
        throw new Error("failed disk path must not write");
      },
      deleteDisk: async () => ({ status: "deleted" }),
    }, {
      sessionId: "s1",
      workspaceId: "ws",
      context: context("ws", ["a.ts", "b.ts"]),
      changes: [
        { resourceId: "a.ts", action: "edit", edits: [{ oldText: "A", newText: "C" }] },
        { resourceId: "b.ts", action: "edit", edits: [{ oldText: "B", newText: "D" }] },
        { resourceId: "other.ts", action: "write", content: "disk-new" },
      ],
    });
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ action: "apply", targets: ["a.ts", "b.ts"] });
    expect(ops[1]).toMatchObject({ action: "undo", operationId: ops[0]?.operationId, targets: ["a.ts", "b.ts"] });
    expect(result.status).toBe("conflict");
    if (result.status === "disk") throw new Error("expected mixed results");
    expect(result.results.filter((row) => row.target === "surface").every((row) => row.status === "compensated")).toBe(true);
  });

  it("compensates applied surface paths while retaining a definite rejection", async () => {
    const inspectFor = (resourceId: string, content: string): SurfaceSnapshotInspectResult => ({
      status: "ready",
      bom: false,
      content,
      encoding: "utf-8",
      localEditRevision: 2,
      baseRevision: "disk-a",
      revision: "surface-draft:fixed:2",
      resource: { workspaceId: "ws", resourceId },
      source: "surface-draft",
    });
    const publication: DirtyBufferPublication = {
      generation: 1,
      ownerId: "surface",
      registrationId: "reg-1",
      resources: ["a.ts", "b.ts"].map((resourceId) => ({
        baseRevision: "disk-a",
        localEditRevision: 2,
        documentInstanceId: `doc-${resourceId}`,
        bufferHash: hash(resourceId === "a.ts" ? "A" : "B"),
        encoding: "utf-8" as const,
        bom: false,
        lineEnding: "lf" as const,
        resource: { workspaceId: "ws", resourceId },
      })),
      updatedAt: new Date().toISOString(),
      workspaceId: "ws",
    };
    const operations: Array<{ action: string; targets: string[] }> = [];
    const { result } = await applyAgentSurfaceMutation({
      inspectSnapshot: (_session, _context, resourceId) => (
        resourceId === "a.ts" ? inspectFor("a.ts", "A") : inspectFor("b.ts", "B")
      ),
      surfaceOwner: () => ({ ownerId: "surface", generation: 1, workspaceId: "ws" }),
      inspectDirtyBuffers: async () => [publication],
      requestSurfaceOperation: async (request) => {
        operations.push({ action: request.action, targets: request.targets.map((target) => target.resource.resourceId) });
        if (request.action === "apply") {
          return request.targets.map((target) => target.resource.resourceId === "a.ts"
            ? {
                resource: target.resource,
                status: "applied" as const,
                documentInstanceId: target.documentInstanceId,
                beforeLocalEditRevision: 2,
                beforeHash: target.bufferHash,
                afterLocalEditRevision: 3,
                afterHash: hash("C"),
              }
            : {
                resource: target.resource,
                status: "failed" as const,
                message: "surface rejected this path",
              });
        }
        return request.targets.map((target) => ({
          resource: target.resource,
          status: "undone" as const,
          documentInstanceId: target.documentInstanceId,
          content: "A",
          afterLocalEditRevision: 4,
          afterHash: hash("A"),
        }));
      },
      inspectWorkspace: async () => ({ epoch: 1 }),
      readDisk: async () => ({ status: "binary" as const, revision: "disk-binary" }),
      writeDisk: async () => ({ status: "conflict" as const }),
      deleteDisk: async () => ({ status: "conflict" as const }),
    }, {
      sessionId: "s1",
      workspaceId: "ws",
      context: context("ws", ["a.ts", "b.ts"]),
      changes: [
        { resourceId: "a.ts", action: "edit", edits: [{ oldText: "A", newText: "C" }] },
        { resourceId: "b.ts", action: "edit", edits: [{ oldText: "B", newText: "D" }] },
      ],
    });
    expect(operations).toEqual([
      { action: "apply", targets: ["a.ts", "b.ts"] },
      { action: "undo", targets: ["a.ts"] },
    ]);
    if (result.status === "disk") throw new Error("expected surface results");
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "a.ts", status: "compensated" }),
      expect.objectContaining({ path: "b.ts", status: "conflict" }),
    ]));
  });
});

describe("durable agent mutation ordering", () => {
  it("aborts after a later intent CAS fails before any side effect", async () => {
    const safety: RecoveryState = { kind: "missing" };
    const target: RecoveryState = { kind: "regular-file", objectHash: `sha256-${"c".repeat(64)}`, byteLength: 1 };
    let operationState = "applying";
    let failSecondIntent = true;
    const files = ["first.ts", "second.ts"].map((path) => ({
      path, phase: "pending", revision: 1, targetJson: JSON.stringify(target), safetyJson: null as string | null,
    }));
    let data: PersistedAgentMutationData | undefined;
    const port = {
      async createOperation(input: { data: Record<string, unknown> }) {
        data = input.data as PersistedAgentMutationData;
        return { operationId: data.operationId, state: operationState, revision: 1, data, files };
      },
      async getOperation() { return data ? { operationId: data.operationId, state: operationState, revision: 1, data, files } : null; },
      async listOperations() { return data ? [{ operationId: data.operationId, state: operationState, sessionId: data.sessionId }] : []; },
      async updateOperationFile(input: { path: string; phase: string; safety?: RecoveryState }) {
        if (input.path === "second.ts" && input.phase === "apply-intent" && failSecondIntent) throw new Error("injected second intent CAS failure");
        const file = files.find((entry) => entry.path === input.path)!;
        file.phase = input.phase;
        file.revision += 1;
        if (input.safety) file.safetyJson = JSON.stringify(input.safety);
        return { revision: file.revision };
      },
      async completeOperation(input: { state: string }) { operationState = input.state; return { revision: 2, state: input.state }; },
      async releaseOperation() { return { released: true }; },
    };
    const durable: DurableFileOperationContext = {
      durableRecoveryStore: port,
      fileStore: { captureState: async (_identity: unknown, _root: string, path: string) => ({ path, state: safety }) } as never,
      identity: { authorityId: "host", canonicalRoot: "", filesystemProfile: "test", workspaceId: "ws" },
      root: "",
      resourceOperationGate: { run: async (_resources, operation) => operation() },
    };
    await expect(beginAgentMutationOperationAsync(durable, {
      operationId: "partial-intent", sessionId: "s1", workspaceId: "ws",
      targetKinds: { "first.ts": "disk", "second.ts": "disk" },
      targets: { "first.ts": { expected: safety, target }, "second.ts": { expected: safety, target } },
      safety: { "first.ts": safety, "second.ts": safety },
    })).rejects.toThrow(/second intent/i);
    failSecondIntent = false;
    expect(await reconcileInterruptedAgentMutations(durable)).toEqual({ compensated: [], needsAttention: [], aborted: ["partial-intent"] });
    expect(operationState).toBe("aborted");
  });

  it("compensates an earlier disk path without a database and persists the terminal state", async () => {
    const safety: RecoveryState = { kind: "regular-file", objectHash: `sha256-${"a".repeat(64)}`, byteLength: 4, mode: 0o644 };
    const target: RecoveryState = { kind: "regular-file", objectHash: `sha256-${"b".repeat(64)}`, byteLength: 6, mode: 0o644 };
    let current: RecoveryState = target;
    let operationState = "applying";
    const file = { path: "first.ts", phase: "target-observed", revision: 2, targetJson: JSON.stringify(target), safetyJson: JSON.stringify(safety) };
    const data: PersistedAgentMutationData = {
      operationId: "mixed-agent-operation",
      sessionId: "s1",
      workspaceId: "ws",
      intent: "agent-surface-write",
      targetKinds: { "first.ts": "disk", "second.ts": "disk" },
      surfaceBindings: {},
      diskIdentities: {},
      targets: { "first.ts": { expected: safety, target }, "second.ts": { expected: safety, target } },
      safety: { "first.ts": safety, "second.ts": safety },
      appliedPaths: ["first.ts"],
      compensatedPaths: [],
      needsAttentionPaths: [],
      results: [],
      failure: "second.ts failed",
    };
    const durable = {
      async createOperation() { return {}; },
      async listOperations() { return []; },
      async getOperation() { return { operationId: data.operationId, workspaceId: "ws", state: operationState, revision: 1, data, files: [file] }; },
      async updateOperationFile(input: { phase: string }) {
        file.phase = input.phase;
        file.revision += 1;
        return { revision: file.revision };
      },
      async completeOperation(input: { state: string }) {
        operationState = input.state;
        return { revision: 2, state: input.state };
      },
      async releaseOperation() { return { released: true }; },
    };
    const context: DurableFileOperationContext = {
      durableRecoveryStore: durable,
      fileStore: {
        captureState: async () => ({ path: "first.ts", state: current }),
        applyState: async (_identity: unknown, _root: string, _path: string, state: RecoveryState) => { current = state; },
      } as never,
      identity: { authorityId: "host", canonicalRoot: "", filesystemProfile: "test", workspaceId: "ws" },
      root: "",
      resourceOperationGate: { run: async (_resources, operation) => operation() },
    };
    expect("database" in context).toBe(false);
    expect(await compensateAgentMutationDiskPath(context, data, "first.ts")).toBe("compensated");
    await finalizeAgentMutationOperation(context, data, []);
    expect(current).toEqual(safety);
    expect(file.phase).toBe("safety-observed");
    expect(operationState).toBe("compensated");
  });

  it("waits for Rust intent CAS before the editor and for terminal CAS before returning", async () => {
    const inspect: SurfaceSnapshotInspectResult = {
      status: "ready",
      bom: false,
      content: "B\n",
      encoding: "utf-8",
      localEditRevision: 2,
      baseRevision: "disk-a",
      revision: "surface-draft:fixed:2",
      resource: { workspaceId: "ws", resourceId: "draft.ts" },
      source: "surface-draft",
    };
    const publication: DirtyBufferPublication = {
      generation: 1,
      ownerId: "surface",
      registrationId: "reg-1",
      resources: [{
        baseRevision: "disk-a",
        localEditRevision: 2,
        documentInstanceId: "doc-1",
        bufferHash: hash("B\n"),
        encoding: "utf-8",
        bom: false,
        lineEnding: "lf",
        resource: { workspaceId: "ws", resourceId: "draft.ts" },
      }],
      updatedAt: new Date().toISOString(),
      workspaceId: "ws",
    };
    const intent = deferred<void>();
    const terminal = deferred<void>();
    let intentReleased = false;
    let terminalReleased = false;
    let operationId = "";
    let revision = 1;
    let phase = "pending";
    let state = "applying";
    let data: Record<string, unknown> = {};
    let editorCalls = 0;
    let settled = false;
    const port = {
      async createOperation(input: { operationId: string; workspaceId: string; kind: string; state: string; data: Record<string, unknown>; targets: Record<string, { expected?: RecoveryState; target?: RecoveryState; safety?: RecoveryState }>; sessionId?: string }) {
        operationId = input.operationId;
        state = input.state;
        data = structuredClone(input.data);
        return { operationId, revision, state, data, files: [{ path: "draft.ts", phase, revision: 1, targetJson: JSON.stringify(input.targets["draft.ts"]?.target), safetyJson: JSON.stringify(input.targets["draft.ts"]?.safety) }] };
      },
      async getOperation() {
        return { operationId, revision, state, data, files: [{ path: "draft.ts", phase, revision, targetJson: JSON.stringify((data.targets as Record<string, { target?: RecoveryState }>)?.["draft.ts"]?.target), safetyJson: JSON.stringify((data.safety as Record<string, RecoveryState>)?.["draft.ts"]) }] };
      },
      async updateOperationFile(input: { phase: string }) {
        if (input.phase === "external-intent" && !intentReleased) await intent.promise;
        phase = input.phase;
        revision += 1;
        return { revision };
      },
      async completeOperation(input: { state: string }) {
        if (input.state === "complete" && !terminalReleased) await terminal.promise;
        state = input.state;
        revision += 1;
        return { operationId, revision, state };
      },
      async listOperations() { return []; },
      async releaseOperation() { return { released: true }; },
    };
    const durable: DurableFileOperationContext = {
      durableRecoveryStore: port,
      fileStore: {} as never,
      identity: { authorityId: "host", canonicalRoot: "", filesystemProfile: "test", workspaceId: "ws" },
      root: "",
      resourceOperationGate: { run: async (_resources, operation) => operation() },
    };
    const requestSurfaceOperation = async (request: DocumentSurfaceOperationRequest) => {
      editorCalls += 1;
      expect(request.action).toBe("apply");
      return [{
        resource: { workspaceId: "ws", resourceId: "draft.ts" },
        status: "applied" as const,
        documentInstanceId: "doc-1",
        beforeLocalEditRevision: 2,
        beforeHash: hash("B\n"),
        afterLocalEditRevision: 3,
        afterHash: hash("C\n"),
      }];
    };
    const run = applyAgentSurfaceMutation({
      inspectSnapshot: () => inspect,
      surfaceOwner: () => ({ ownerId: "surface", generation: 1, workspaceId: "ws" }),
      inspectDirtyBuffers: async () => [publication],
      requestSurfaceOperation,
      inspectWorkspace: async () => ({ epoch: 1 }),
      readDisk: async () => ({ status: "ready" as const, content: "A\n", revision: "disk-a" }),
      writeDisk: async () => ({ status: "conflict" as const }),
      deleteDisk: async () => ({ status: "conflict" as const }),
      durable,
    }, {
      sessionId: "s1",
      workspaceId: "ws",
      context: context("ws", ["draft.ts"]),
      changes: [{ resourceId: "draft.ts", action: "edit", edits: [{ oldText: "B\n", newText: "C\n" }] }],
    }).then((value) => { settled = true; return value; });
    await Promise.resolve();
    await Promise.resolve();
    expect(editorCalls).toBe(0);
    intentReleased = true;
    intent.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editorCalls).toBe(1);
    expect(settled).toBe(false);
    terminalReleased = true;
    terminal.resolve();
    const result = await run;
    expect(settled).toBe(true);
    expect(result.result.status).toBe("applied");
  });

  it("reconciles an interrupted disk phase through the Rust operation after host restart", async () => {
    const safety: RecoveryState = { kind: "regular-file", objectHash: `sha256-${"a".repeat(64)}`, byteLength: 4, mode: 0o644 };
    const target: RecoveryState = { kind: "regular-file", objectHash: `sha256-${"b".repeat(64)}`, byteLength: 6, mode: 0o644 };
    const operation: Record<string, unknown> = {
      operationId: "agent-restart-op",
      state: "applying",
      revision: 3,
      data: {
        operationId: "agent-restart-op",
        workspaceId: "ws",
        sessionId: "s1",
        targetKinds: { "disk.ts": "disk" },
        targets: { "disk.ts": { expected: safety, target } },
        safety: { "disk.ts": safety },
        appliedPaths: ["disk.ts"],
        compensatedPaths: [],
        needsAttentionPaths: [],
        results: [],
      },
      files: [{ path: "disk.ts", phase: "target-observed", revision: 3, targetJson: JSON.stringify(target), safetyJson: JSON.stringify(safety) }],
    };
    const durable = {
      async createOperation() { return {}; },
      async listOperations() { return [{ operationId: "agent-restart-op", state: "applying", sessionId: "s1" }]; },
      async getOperation() { return operation; },
      async updateOperationFile(input: { phase: string }) {
        const file = (operation.files as Array<Record<string, unknown>>)[0]!;
        file.phase = input.phase;
        operation.revision = Number(operation.revision) + 1;
        file.revision = operation.revision;
        return { revision: operation.revision };
      },
      async completeOperation(input: { state: string }) {
        operation.state = input.state;
        operation.revision = Number(operation.revision) + 1;
        return { revision: operation.revision, state: operation.state };
      },
      async releaseOperation() { return { released: true }; },
    };
    const context: DurableFileOperationContext = {
      durableRecoveryStore: durable,
      fileStore: { captureState: async () => ({ state: safety }) } as never,
      identity: { authorityId: "host", canonicalRoot: "", filesystemProfile: "test", workspaceId: "ws" },
      root: "",
      resourceOperationGate: { run: async (_resources, run) => run() },
    };
    const outcome = await reconcileInterruptedAgentMutations(context);
    expect(outcome).toEqual({ compensated: ["agent-restart-op"], needsAttention: [], aborted: [] });
    expect(operation.state).toBe("compensated");
    expect((operation.files as Array<Record<string, unknown>>)[0]?.phase).toBe("safety-observed");
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
