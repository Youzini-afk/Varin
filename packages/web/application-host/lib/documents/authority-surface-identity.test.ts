import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachLiveSurfaceCompleter,
  createDocumentAuthorityHarness,
  hashSurfaceText,
  type DocumentAuthorityHarness,
  type LiveSurfaceBuffer,
} from "./contract-fixtures.js";
import {
  beginAgentMutationOperationAsync,
  markAgentMutationPathApplied,
  markAgentMutationSurfaceDispatched,
  reconcileInterruptedAgentMutations,
} from "./agent-mutation-operation.js";
import { createRecoveryFileStore } from "../recovery/file-store.test-helper.js";
import type { DurableFileOperationContext } from "../recovery/durable-file-operation.js";
import {
  createInMemoryRecoveryDurablePort,
} from "../recovery/recovery-durable-port.test-helper.js";

import { createNativeAuthorityTestRuntime } from "../kernel/native-authority.test-helper.js";
import type { RecoveryDurableOperationPort } from "../recovery/journal-engine.js";

const utf16LeHello = Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);

const bindDurableCatalog = async (harness: DocumentAuthorityHarness) => {
  const native = await createNativeAuthorityTestRuntime({ documents: harness.authority, hostId: harness.authority.hostId, dataDir: harness.dataDir });
  const cleanup = harness.cleanup;
  harness.cleanup = async () => { try { await native.dispose(); } finally { await cleanup(); } };
  const context = await native.engine.withWorkspaceStorage(harness.identity.workspaceId, { mode: "exclusive", purpose: "surface-identity-acceptance", create: true }, current => current);
  return { ...native, context, objectRoot: context.root, identity: context.identity, fileStore: context.fileStore, durableRecoveryStore: native.recovery };
};

const inspectAgentMutationOperation = async (
  durableRecoveryStore: RecoveryDurableOperationPort,
  workspaceId: string,
  operationId: string,
): Promise<(Record<string, unknown> & { data: Record<string, unknown> }) | null> => {
  const operation = await durableRecoveryStore.getOperation(
    workspaceId,
    operationId,
  );
  if (!operation) return null;
  const data =
    operation.result && typeof operation.result === "object"
      ? (operation.result as Record<string, unknown>)
      : (operation.data as Record<string, unknown>);
  return { ...operation, data };
};

describe("surface identity and durable compensation", () => {
  let harness: DocumentAuthorityHarness | undefined;

  afterEach(async () => {
    if (!harness) return;
    const current = harness;
    harness = undefined;
    await current.cleanup();
  });

  it("keeps CRLF disk bytes while editing the normalized dirty buffer twice and via apply_patch write", async () => {
    harness = await createDocumentAuthorityHarness();
    await bindDurableCatalog(harness);
    const live = new Map<string, LiveSurfaceBuffer>();
    const surface = attachLiveSurfaceCompleter(harness.authority, {
      generation: 1,
      live,
      ownerId: "surface-owner",
      workspaceId: harness.identity.workspaceId,
    });
    try {
      const diskBytes = Buffer.from("A\r\n", "utf8");
      await fs.promises.writeFile(
        path.join(harness.workspaceRoot, "draft.ts"),
        diskBytes,
      );
      const disk = await harness.authority.read(harness.resource("draft.ts"));
      if (disk.status !== "ready") throw new Error("Expected CRLF fixture");
      const binding = {
        baseRevision: disk.revision,
        localEditRevision: 2,
        documentInstanceId: "document-instance",
        bufferHash: hashSurfaceText("B\n"),
        encoding: "utf-8" as const,
        bom: false,
        lineEnding: "crlf" as const,
        resource: harness.resource("draft.ts"),
      };
      live.set("draft.ts", { ...binding, content: "B\n" });
      await harness.authority.publishDirtyBuffers({
        generation: 1,
        ownerId: "surface-owner",
        resources: [binding],
        workspaceId: harness.identity.workspaceId,
      });
      const context = await harness.authority.captureAgentInputSnapshot({
        generation: 1,
        ownerId: "surface-owner",
        sessionId: "session-crlf",
        resources: [{ ...binding, content: "B\r\n" }],
      });
      harness.authority.commitAgentInputSnapshot("session-crlf", context);

      const first = await harness.authority.applyAgentSurfaceWrite(
        "session-crlf",
        harness.identity.workspaceId,
        context,
        [
          {
            resourceId: "draft.ts",
            action: "edit",
            edits: [{ oldText: "B\n", newText: "C\n" }],
          },
        ],
      );
      expect(first.status).toBe("applied");
      expect(live.get("draft.ts")?.content).toBe("C\n");
      expect(
        await fs.promises.readFile(
          path.join(harness.workspaceRoot, "draft.ts"),
        ),
      ).toEqual(diskBytes);
      expect(
        harness.authority.readAgentInputSnapshot(
          "session-crlf",
          context,
          "draft.ts",
          harness.identity.workspaceId,
        ),
      ).toMatchObject({
        status: "ready",
        content: "C\r\n",
        source: "surface-draft",
      });
      expect(
        harness.authority.inspectAgentInputSnapshot(
          "session-crlf",
          context,
          "draft.ts",
          harness.identity.workspaceId,
        ),
      ).toMatchObject({
        status: "ready",
        content: "C\r\n",
        bufferHash: hashSurfaceText("C\n"),
        lineEnding: "crlf",
      });

      const second = await harness.authority.applyAgentSurfaceWrite(
        "session-crlf",
        harness.identity.workspaceId,
        context,
        [
          {
            resourceId: "draft.ts",
            action: "edit",
            edits: [{ oldText: "C\n", newText: "E\n" }],
          },
        ],
      );
      expect(second.status).toBe("applied");
      expect(live.get("draft.ts")?.content).toBe("E\n");
      expect(
        harness.authority.readAgentInputSnapshot(
          "session-crlf",
          context,
          "draft.ts",
          harness.identity.workspaceId,
        ),
      ).toMatchObject({
        status: "ready",
        content: "E\r\n",
      });
      expect(
        await fs.promises.readFile(
          path.join(harness.workspaceRoot, "draft.ts"),
        ),
      ).toEqual(diskBytes);

      const afterSecond = harness.authority.inspectAgentInputSnapshot(
        "session-crlf",
        context,
        "draft.ts",
        harness.identity.workspaceId,
      );
      if (afterSecond.status !== "ready")
        throw new Error("Expected CRLF snapshot after the second edit");
      const patched = await harness.authority.applyAgentSurfaceWrite(
        "session-crlf",
        harness.identity.workspaceId,
        context,
        [
          {
            resourceId: "draft.ts",
            action: "write",
            content: "P\n",
            expectedRevision: afterSecond.revision,
            expectedHash: hashSurfaceText("E\n"),
          },
        ],
      );
      expect(patched.status).toBe("applied");
      expect(live.get("draft.ts")?.content).toBe("P\n");
      expect(
        harness.authority.readAgentInputSnapshot(
          "session-crlf",
          context,
          "draft.ts",
          harness.identity.workspaceId,
        ),
      ).toMatchObject({
        status: "ready",
        content: "P\r\n",
      });
      expect(
        await fs.promises.readFile(
          path.join(harness.workspaceRoot, "draft.ts"),
        ),
      ).toEqual(diskBytes);
    } finally {
      surface.close();
    }
  });

  it("restores two surface paths with one Registry undo group after a later disk failure", async () => {
    harness = await createDocumentAuthorityHarness();
    await bindDurableCatalog(harness);
    const live = new Map<string, LiveSurfaceBuffer>();
    const surface = attachLiveSurfaceCompleter(harness.authority, {
      generation: 1,
      live,
      ownerId: "surface-owner",
      workspaceId: harness.identity.workspaceId,
    });
    try {
      await fs.promises.writeFile(
        path.join(harness.workspaceRoot, "a.ts"),
        "disk-a\n",
      );
      await fs.promises.writeFile(
        path.join(harness.workspaceRoot, "b.ts"),
        "disk-b\n",
      );
      await fs.promises.writeFile(
        path.join(harness.workspaceRoot, "blocked.bin"),
        Buffer.from([0x00, 0x01, 0x02]),
      );
      const diskA = await harness.authority.read(harness.resource("a.ts"));
      const diskB = await harness.authority.read(harness.resource("b.ts"));
      if (diskA.status !== "ready" || diskB.status !== "ready")
        throw new Error("Expected text fixtures");
      const bindingA = {
        baseRevision: diskA.revision,
        localEditRevision: 2,
        documentInstanceId: "doc-a",
        bufferHash: hashSurfaceText("A\n"),
        encoding: "utf-8" as const,
        bom: false,
        lineEnding: "lf" as const,
        resource: harness.resource("a.ts"),
      };
      const bindingB = {
        baseRevision: diskB.revision,
        localEditRevision: 2,
        documentInstanceId: "doc-b",
        bufferHash: hashSurfaceText("B\n"),
        encoding: "utf-8" as const,
        bom: false,
        lineEnding: "lf" as const,
        resource: harness.resource("b.ts"),
      };
      live.set("a.ts", { ...bindingA, content: "A\n" });
      live.set("b.ts", { ...bindingB, content: "B\n" });
      await harness.authority.publishDirtyBuffers({
        generation: 1,
        ownerId: "surface-owner",
        resources: [bindingA, bindingB],
        workspaceId: harness.identity.workspaceId,
      });
      const context = await harness.authority.captureAgentInputSnapshot({
        generation: 1,
        ownerId: "surface-owner",
        sessionId: "session-group",
        resources: [
          { ...bindingA, content: "A\n" },
          { ...bindingB, content: "B\n" },
        ],
      });
      harness.authority.commitAgentInputSnapshot("session-group", context);

      const result = await harness.authority.applyAgentSurfaceWrite(
        "session-group",
        harness.identity.workspaceId,
        context,
        [
          {
            resourceId: "a.ts",
            action: "edit",
            edits: [{ oldText: "A\n", newText: "C\n" }],
          },
          {
            resourceId: "b.ts",
            action: "edit",
            edits: [{ oldText: "B\n", newText: "D\n" }],
          },
          { resourceId: "blocked.bin", action: "write", content: "nope\n" },
        ],
      );
      expect(result.status).toBe("conflict");
      if (result.status === "disk") throw new Error("expected mixed results");
      expect(result.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "a.ts",
            target: "surface",
            status: "compensated",
          }),
          expect.objectContaining({
            path: "b.ts",
            target: "surface",
            status: "compensated",
          }),
          expect.objectContaining({
            path: "blocked.bin",
            target: "disk",
            status: "unavailable",
          }),
        ]),
      );
      expect(live.get("a.ts")?.content).toBe("A\n");
      expect(live.get("b.ts")?.content).toBe("B\n");
      expect(
        await fs.promises.readFile(
          path.join(harness.workspaceRoot, "a.ts"),
          "utf8",
        ),
      ).toBe("disk-a\n");
      expect(
        await fs.promises.readFile(
          path.join(harness.workspaceRoot, "b.ts"),
          "utf8",
        ),
      ).toBe("disk-b\n");

      const publication = (
        await harness.authority.inspectDirtyBuffers(
          harness.identity.workspaceId,
        )
      )[0]!;
      const secondUndo = await harness.authority.requestSurfaceOperation({
        action: "undo",
        generation: 1,
        operationId: result.operationId!,
        ownerId: "surface-owner",
        registrationId: publication.registrationId!,
        workspaceId: harness.identity.workspaceId,
        targets: [
          {
            ...bindingA,
            expectedAppliedRevision: live.get("a.ts")!.localEditRevision,
            expectedAppliedHash: live.get("a.ts")!.bufferHash,
          },
        ],
      });
      expect(secondUndo[0]?.status).toBe("failed");
      expect(live.get("a.ts")?.content).toBe("A\n");
      expect(live.get("b.ts")?.content).toBe("B\n");
    } finally {
      surface.close();
    }
  });

  it("restores UTF-16 BOM disk bytes after a later mixed-batch failure", async () => {
    harness = await createDocumentAuthorityHarness();
    const { durableRecoveryStore } = await bindDurableCatalog(harness);
    const live = new Map<string, LiveSurfaceBuffer>();
    const surface = attachLiveSurfaceCompleter(harness.authority, {
      generation: 1,
      live,
      ownerId: "surface-owner",
      workspaceId: harness.identity.workspaceId,
    });
    try {
      await fs.promises.writeFile(
        path.join(harness.workspaceRoot, "draft.ts"),
        "A\n",
      );
      await fs.promises.writeFile(
        path.join(harness.workspaceRoot, "wide.txt"),
        utf16LeHello,
      );
      await fs.promises.writeFile(
        path.join(harness.workspaceRoot, "blocked.bin"),
        Buffer.from([0x00, 0x01]),
      );
      const disk = await harness.authority.read(harness.resource("draft.ts"));
      const wide = await harness.authority.read(harness.resource("wide.txt"));
      expect(wide.status).toBe("unsupported-encoding");
      if (disk.status !== "ready") throw new Error("Expected draft fixture");
      const binding = {
        baseRevision: disk.revision,
        localEditRevision: 2,
        documentInstanceId: "document-instance",
        bufferHash: hashSurfaceText("B\n"),
        encoding: "utf-8" as const,
        bom: false,
        lineEnding: "lf" as const,
        resource: harness.resource("draft.ts"),
      };
      live.set("draft.ts", { ...binding, content: "B\n" });
      await harness.authority.publishDirtyBuffers({
        generation: 1,
        ownerId: "surface-owner",
        resources: [binding],
        workspaceId: harness.identity.workspaceId,
      });
      const context = await harness.authority.captureAgentInputSnapshot({
        generation: 1,
        ownerId: "surface-owner",
        sessionId: "session-utf16",
        resources: [{ ...binding, content: "B\n" }],
      });
      harness.authority.commitAgentInputSnapshot("session-utf16", context);

      const result = await harness.authority.applyAgentSurfaceWrite(
        "session-utf16",
        harness.identity.workspaceId,
        context,
        [
          {
            resourceId: "draft.ts",
            action: "edit",
            edits: [{ oldText: "B\n", newText: "C\n" }],
          },
          { resourceId: "wide.txt", action: "write", content: "overwritten\n" },
          { resourceId: "blocked.bin", action: "write", content: "nope\n" },
        ],
      );
      expect(result.status).toBe("conflict");
      expect(live.get("draft.ts")?.content).toBe("B\n");
      expect(
        await fs.promises.readFile(
          path.join(harness.workspaceRoot, "wide.txt"),
        ),
      ).toEqual(utf16LeHello);
      expect(
        await fs.promises.readFile(
          path.join(harness.workspaceRoot, "draft.ts"),
          "utf8",
        ),
      ).toBe("A\n");

      if (result.status === "disk" || !result.operationId)
        throw new Error("expected persisted mixed mutation");
      const persisted = await inspectAgentMutationOperation(
        durableRecoveryStore,
        harness.identity.workspaceId,
        result.operationId,
      );
      expect(
        (persisted?.data.diskIdentities as Record<string, unknown>)["wide.txt"],
      ).toMatchObject({
        encoding: "utf-16le",
        bom: true,
        existed: true,
      });
      expect(persisted?.state).toMatch(/compensated|needs-attention/);
    } finally {
      surface.close();
    }
  });

  it("records compensated or needs-attention after a surface apply then I/O throw", async () => {
    harness = await createDocumentAuthorityHarness();
    const { durableRecoveryStore, backend } = await bindDurableCatalog(harness);
    const write = backend.writeBytes.bind(backend);
    vi.spyOn(backend, "writeBytes").mockImplementation(async (identity, relative, bytes, options) => {
      if (relative === "other.ts") throw new Error("injected native disk I/O failure");
      return write(identity, relative, bytes, options);
    });
    const live = new Map<string, LiveSurfaceBuffer>();
    const surface = attachLiveSurfaceCompleter(harness.authority, {
      generation: 1,
      live,
      ownerId: "surface-owner",
      workspaceId: harness.identity.workspaceId,
    });
    try {
      await fs.promises.writeFile(
        path.join(harness.workspaceRoot, "draft.ts"),
        "A\n",
      );
      await fs.promises.writeFile(
        path.join(harness.workspaceRoot, "other.ts"),
        "disk\n",
      );
      const disk = await harness.authority.read(harness.resource("draft.ts"));
      if (disk.status !== "ready") throw new Error("Expected draft fixture");
      const binding = {
        baseRevision: disk.revision,
        localEditRevision: 2,
        documentInstanceId: "document-instance",
        bufferHash: hashSurfaceText("B\n"),
        encoding: "utf-8" as const,
        bom: false,
        lineEnding: "lf" as const,
        resource: harness.resource("draft.ts"),
      };
      live.set("draft.ts", { ...binding, content: "B\n" });
      await harness.authority.publishDirtyBuffers({
        generation: 1,
        ownerId: "surface-owner",
        resources: [binding],
        workspaceId: harness.identity.workspaceId,
      });
      const context = await harness.authority.captureAgentInputSnapshot({
        generation: 1,
        ownerId: "surface-owner",
        sessionId: "session-throw",
        resources: [{ ...binding, content: "B\n" }],
      });
      harness.authority.commitAgentInputSnapshot("session-throw", context);

      const result = await harness.authority.applyAgentSurfaceWrite(
        "session-throw",
        harness.identity.workspaceId,
        context,
        [
          {
            resourceId: "draft.ts",
            action: "edit",
            edits: [{ oldText: "B\n", newText: "C\n" }],
          },
          { resourceId: "other.ts", action: "write", content: "new-disk\n" },
        ],
      );
      expect(result.status).toBe("conflict");
      expect(live.get("draft.ts")?.content).toBe("B\n");
      expect(
        await fs.promises.readFile(
          path.join(harness.workspaceRoot, "other.ts"),
          "utf8",
        ),
      ).toBe("disk\n");
      if (result.status === "disk" || !result.operationId)
        throw new Error("expected persisted mutation");

      const persisted = await inspectAgentMutationOperation(
        durableRecoveryStore,
        harness.identity.workspaceId,
        result.operationId,
      );
      expect(persisted).not.toBeNull();
      expect(persisted?.state).toMatch(/compensated|needs-attention/);
      expect(persisted?.data.intent).toBe("agent-surface-write");
    } finally {
      surface.close();
    }
  });

  it("marks interrupted surface mutations needs-attention when the owner is gone", async () => {
    harness = await createDocumentAuthorityHarness();
    const objectRoot = path.join(harness.dataDir, "reconcile-objects");
    await fs.promises.mkdir(objectRoot, { recursive: true });
    const durableRecoveryStore = createInMemoryRecoveryDurablePort();
    const context: DurableFileOperationContext = {
      durableRecoveryStore,
      fileStore: createRecoveryFileStore(),
      identity: {
        authorityId: harness.authority.hostId,
        canonicalRoot: (
          await harness.authority.inspectWorkspace(harness.identity.workspaceId)
        ).root,
        filesystemProfile: "test",
        workspaceId: harness.identity.workspaceId,
      },
      resourceOperationGate: { run: async (_resources, next) => next() },
      root: objectRoot,
    };
    const data = await beginAgentMutationOperationAsync(context, {
      operationId: "op-surface-interrupt",
      sessionId: "session-interrupt",
      workspaceId: harness.identity.workspaceId,
      targetKinds: { "draft.ts": "surface" },
      surfaceBindings: {
        "draft.ts": {
          ownerId: "surface-owner",
          ownerGeneration: 1,
          ownerRegistrationId: "reg-1",
          documentInstanceId: "doc-1",
          baseRevision: "disk-a",
          beforeLocalEditRevision: 2,
          beforeHash: hashSurfaceText("B\n"),
          encoding: "utf-8",
          bom: false,
          lineEnding: "lf",
        },
      },
      targets: {
        "draft.ts": {
          expected: { kind: "missing" },
          target: { kind: "missing" },
        },
      },
      safety: { "draft.ts": { kind: "missing" } },
    });
    await markAgentMutationPathApplied(context, data, "draft.ts", {
      afterLocalEditRevision: 3,
      afterHash: hashSurfaceText("C\n"),
    });
    const outcome = await reconcileInterruptedAgentMutations(context, {
      surfaceOwnerAvailable: () => false,
    });
    expect(outcome.needsAttention).toContain("op-surface-interrupt");
    expect(
      (
        await inspectAgentMutationOperation(
          durableRecoveryStore,
          harness.identity.workspaceId,
          "op-surface-interrupt",
        )
      )?.state,
    ).toBe("needs-attention");
  });

  it("keeps dispatched surface uncertainty while compensating another applied disk path", async () => {
    harness = await createDocumentAuthorityHarness();
    const activeHarness = harness;
    const { objectRoot, identity, fileStore, durableRecoveryStore, context: nativeContext } =
      await bindDurableCatalog(activeHarness);
    await fs.promises.writeFile(
      path.join(activeHarness.workspaceRoot, "disk.txt"),
      "before\n",
    );
    {
      const safety = (
        await fileStore.captureState(identity, objectRoot, "disk.txt", {
          store: true,
        })
      ).state;
      await fs.promises.writeFile(
        path.join(activeHarness.workspaceRoot, "disk.txt"),
        "after\n",
      );
      const target = (
        await fileStore.captureState(identity, objectRoot, "disk.txt", {
          store: true,
        })
      ).state;
      await fs.promises.writeFile(
        path.join(activeHarness.workspaceRoot, "disk.txt"),
        "after\n",
      );
      const context: DurableFileOperationContext = nativeContext;
      const data = await beginAgentMutationOperationAsync(context, {
        operationId: "op-dispatched-surface",
        sessionId: "session-dispatched",
        workspaceId: activeHarness.identity.workspaceId,
        targetKinds: { "draft.ts": "surface", "disk.txt": "disk" },
        surfaceBindings: {
          "draft.ts": {
            ownerId: "surface-owner",
            ownerGeneration: 1,
            ownerRegistrationId: "reg-1",
            documentInstanceId: "doc-1",
            baseRevision: "disk-a",
            beforeLocalEditRevision: 2,
            beforeHash: hashSurfaceText("before\n"),
            encoding: "utf-8",
            bom: false,
            lineEnding: "lf",
          },
        },
        targets: {
          "draft.ts": {
            expected: { kind: "missing" },
            target: { kind: "missing" },
          },
          "disk.txt": { expected: safety, target },
        },
        safety: { "draft.ts": { kind: "missing" }, "disk.txt": safety },
      });
      await markAgentMutationSurfaceDispatched(context, data, "draft.ts");
      await markAgentMutationPathApplied(context, data, "disk.txt", { target });
      const outcome = await reconcileInterruptedAgentMutations(context, {
        surfaceOwnerAvailable: () => true,
      });
      expect(outcome.needsAttention).toContain("op-dispatched-surface");
      expect(
        await fs.promises.readFile(
          path.join(activeHarness.workspaceRoot, "disk.txt"),
          "utf8",
        ),
      ).toBe("before\n");
      const persisted = await inspectAgentMutationOperation(
        durableRecoveryStore,
        activeHarness.identity.workspaceId,
        "op-dispatched-surface",
      );
      expect(persisted?.state).toBe("needs-attention");
      expect(persisted?.data.needsAttentionPaths as string[]).toContain(
        "draft.ts",
      );
      expect(persisted?.data.compensatedPaths as string[]).toContain(
        "disk.txt",
      );
    }
  });

  it("rejects a stale disk source before dispatching any surface path", async () => {
    harness = await createDocumentAuthorityHarness();
    const activeHarness = harness;
    const { durableRecoveryStore } = await bindDurableCatalog(activeHarness);
    const live = new Map<string, LiveSurfaceBuffer>();
    const surface = attachLiveSurfaceCompleter(activeHarness.authority, {
      generation: 1,
      live,
      ownerId: "surface-owner",
      workspaceId: activeHarness.identity.workspaceId,
    });
    try {
      await fs.promises.writeFile(
        path.join(activeHarness.workspaceRoot, "draft.ts"),
        "disk\n",
      );
      await fs.promises.writeFile(
        path.join(activeHarness.workspaceRoot, "other.ts"),
        "disk\n",
      );
      const disk = await activeHarness.authority.read(
        activeHarness.resource("draft.ts"),
      );
      if (disk.status !== "ready") throw new Error("Expected disk fixture");
      const binding = {
        baseRevision: disk.revision,
        localEditRevision: 2,
        documentInstanceId: "document-instance",
        bufferHash: hashSurfaceText("draft\n"),
        encoding: "utf-8" as const,
        bom: false,
        lineEnding: "lf" as const,
        resource: activeHarness.resource("draft.ts"),
      };
      live.set("draft.ts", { ...binding, content: "draft\n" });
      await activeHarness.authority.publishDirtyBuffers({
        generation: 1,
        ownerId: "surface-owner",
        resources: [binding],
        workspaceId: activeHarness.identity.workspaceId,
      });
      const context = await activeHarness.authority.captureAgentInputSnapshot({
        generation: 1,
        ownerId: "surface-owner",
        sessionId: "session-stale-source",
        resources: [{ ...binding, content: "draft\n" }],
      });
      activeHarness.authority.commitAgentInputSnapshot(
        "session-stale-source",
        context,
      );
      const result = await activeHarness.authority.applyAgentSurfaceWrite(
        "session-stale-source",
        activeHarness.identity.workspaceId,
        context,
        [
          {
            resourceId: "draft.ts",
            action: "edit",
            edits: [{ oldText: "draft\n", newText: "changed\n" }],
          },
          {
            resourceId: "other.ts",
            action: "write",
            content: "new\n",
            expectedHash: hashSurfaceText("source-before\n"),
          },
        ],
      );
      expect(result.status).toBe("conflict");
      expect(live.get("draft.ts")?.content).toBe("draft\n");
      if (result.status === "disk" || !result.operationId)
        throw new Error("Expected durable stale operation");
      expect(
        (
          await inspectAgentMutationOperation(
            durableRecoveryStore,
            activeHarness.identity.workspaceId,
            result.operationId,
          )
        )?.state,
      ).toBe("aborted");
    } finally {
      surface.close();
    }
  });
});
