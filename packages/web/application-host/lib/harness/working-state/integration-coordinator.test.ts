import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWorkspaceRecoveryEngine, type CreateWorkspaceRecoveryEngineOptions } from "../../recovery/journal-engine.js";
import { openRecoveryJournalCatalog } from "../../recovery/journal-catalog.js";
import { createRecoveryFileStore } from "../../recovery/file-store.test-helper.js";
import { asTestWorkingStateRootAccess, createTestWorkingStateRootAccess, createWorkingStateObjectCollector, createWorkingStateStoreContextAccess } from "./working-state-root-adapter.test-helper.js";
import { IntegrationCoordinator } from "./integration-coordinator.js";
import type { RecoveryState } from "./types.js";
import { createThreadWorktreeRuntime } from "../thread-worktree.js";
import { applyDurableFileOperation, markDurableExternalDispatched, reconcileInterruptedKernelBranchIntegrations } from "../../recovery/durable-file-operation.js";
import { createDocumentAuthority } from "../../documents/authority.js";
import { createInMemoryRecoveryDurablePort } from "../../recovery/recovery-durable-port.test-helper.js";
import { createCodeSubmissionRuntime, selectCodeChanges, submittedCodeBaseline } from "./code-submission.js";
import { createThreadRegistry } from "../thread-registry.js";
import { VirtualWriteGate, acquireVirtualWriteTicket } from "./virtual-write-gate.js";

const roots: string[] = [];
const recoveryEngines = new Set<{ dispose(): Promise<void> }>();
const trackEngine = <T extends { dispose(): Promise<void> }>(engine: T): T => { recoveryEngines.add(engine); return engine; };
const textHash = (text: string) => `sha256-${createHash("sha256").update(text).digest("hex")}`;
const dirtyPublication = (resourceId: string, content: string, localEditRevision = 1) => ({
  ownerId: "editor-a",
  generation: 1,
  registrationId: "registration-a",
  resources: [{
    resource: { resourceId },
    localEditRevision,
    baseRevision: "base",
    documentInstanceId: `document-${resourceId}`,
    bufferHash: textHash(content),
    encoding: "utf-8",
    bom: false,
    lineEnding: "lf" as const,
  }],
});

const createHarness = async (
  baseFileStore = createRecoveryFileStore(),
  durableRecoveryStore: DurableTestStore = createInMemoryRecoveryDurablePort(),
) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "varin-integration-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  let durableObjectRoot = path.join(root, "durable-file-objects");
  await fs.promises.mkdir(workspace, { recursive: true });
  // createRecoveryFileStore uses its `root` argument as the content-object
  // directory. Production kernel storage ignores this legacy parameter because
  // it owns one durable object store. Pin the test seam to one root as well so
  // recovery-engine restart does not accidentally change object authority.
  const fileStore = {
    ...baseFileStore,
    captureState: (identity: Parameters<typeof baseFileStore.captureState>[0], _root: string, inputPath: string, options?: Parameters<typeof baseFileStore.captureState>[3]) => (
      baseFileStore.captureState(identity, durableObjectRoot, inputPath, options)
    ),
    applyState: (identity: Parameters<typeof baseFileStore.applyState>[0], _root: string, inputPath: string, state: RecoveryState) => (
      baseFileStore.applyState(identity, durableObjectRoot, inputPath, state)
    ),
    verifyObject: (_root: string, state: RecoveryState) => baseFileStore.verifyObject(durableObjectRoot, state),
  };
  const directoryWorkspaces = new Map<string, string>();
  const documents: CreateWorkspaceRecoveryEngineOptions["documents"] = {
    inspectWorkspace: async () => ({ root: workspace, workspaceId: "ws" }),
    listWorkspaceRegistrations: async () => [{ canonicalPath: workspace, workspaceId: "ws" }],
    beginDirtyStateBarrier: async () => ({ release: async () => undefined, settle: async () => undefined }),
    inspectDirtyBuffers: async () => [],
    runResourceOperation: vi.fn(async (_workspaceId, _resources, operation) => operation()),
  };
  const navigation: CreateWorkspaceRecoveryEngineOptions["sessionNavigation"] = {
    prepare: async () => ({ expectedLeafId: null, targetLeafId: null }),
    prepareLeaf: async () => ({ expectedLeafId: null, targetLeafId: null }),
    commit: async () => ({}),
    commitLeaf: async () => ({}),
  };
  const resolveDirectoryApplyContext: NonNullable<CreateWorkspaceRecoveryEngineOptions["resolveDirectoryApplyContext"]> = async (directory) => {
    const normalized = path.resolve(directory);
    const workspaceId = directoryWorkspaces.get(normalized)
      ?? (path.resolve(workspace) === normalized ? "ws" : undefined);
    if (!workspaceId) throw new Error(`Unable to resolve execution workspace: ${directory}`);
    return {
      workspaceId,
      resourceOperationGate: {
        run: (resources, operation) => documents.runResourceOperation!(workspaceId, resources, operation),
      },
    };
  };
  const engine = trackEngine(createWorkspaceRecoveryEngine({
    authorityId: "test",
    dataDir,
    documents,
    durableRecoveryStore,
    fileStore,
    sessionNavigation: navigation,
    resolveDirectoryApplyContext,
  }));
  // WorkingStateStore itself is a legacy unit fixture and still needs its own
  // test SQLite context. Integration durable metadata does not use or inspect it.
  const workingStateRoot = path.join(root, "working-state-data");
  const workingStateDatabase = await openRecoveryJournalCatalog(workingStateRoot, { create: true });
  if (!workingStateDatabase) throw new Error("Working-state test catalog is missing");
  trackEngine({ dispose: async () => { workingStateDatabase.close(); } });
  durableObjectRoot = workingStateRoot;
  const workingStates = createTestWorkingStateRootAccess(createWorkingStateStoreContextAccess({
    database: workingStateDatabase,
    fileStore,
    identity: { authorityId: "working-state-test", canonicalRoot: workspace, filesystemProfile: "test", workspaceId: "ws" },
    resourceOperationGate: { run: (resources, operation) => documents.runResourceOperation!("ws", resources, operation) },
    root: workingStateRoot,
    collectUnreachableObjects: createWorkingStateObjectCollector(workingStateRoot, workingStateDatabase),
  }), durableRecoveryStore);
  return {
    coordinator: new IntegrationCoordinator({ workingStates, resolveDirectoryApplyContext }),
    dataDir,
    durableRecoveryStore,
    directoryWorkspaces,
    documents,
    engine,
    fileStore,
    navigation,
    resolveDirectoryApplyContext,
    root,
    workingStates,
    workspace,
  };
};

const prepareResult = async (h: Awaited<ReturnType<typeof createHarness>>, child: string, branchId = "thread-1") => {
  return h.workingStates.withStore("ws", "test-publish", async (store) => {
    await store.createBranch("ws", branchId, await store.captureDirectory(h.workspace), "base");
    return store.publishDirectoryResult(branchId, child);
  });
};

type DurableTestStore = ReturnType<typeof createInMemoryRecoveryDurablePort>;
type DurableTestFile = { path: string; phase: string; revision: number; targetJson: string | null; safetyJson: string | null };

const durableFiles = (operation: Record<string, unknown> | null): DurableTestFile[] => (
  Array.isArray(operation?.files) ? operation.files as DurableTestFile[] : []
);

const durableChanges = async (durable: DurableTestStore, input: { workspaceId: string; executionId?: string }) => {
  if (!durable.listChanges) throw new Error("durable recovery change reader is unavailable");
  return durable.listChanges(input);
};

type DurableSeedTarget = { expected?: RecoveryState; target?: RecoveryState; safety?: RecoveryState };

const seedDurableOperation = async (
  durable: DurableTestStore,
  input: {
    operationId: string;
    workspaceId?: string;
    kind?: string;
    state?: string;
    data: Record<string, unknown>;
    targets?: Record<string, DurableSeedTarget>;
    phases?: Record<string, "pending" | "apply-intent" | "target-observed" | "needs-attention">;
    surfacePaths?: string[];
  },
) => {
  const workspaceId = input.workspaceId ?? "ws";
  const targets = input.targets ?? {};
  const surfacePaths = new Set(input.surfacePaths ?? []);
  const targetKinds = Object.fromEntries(Object.keys(targets).map((file) => [
    file,
    surfacePaths.has(file) ? "surface" : "disk",
  ]));
  await durable.createOperation({
    operationId: input.operationId,
    workspaceId,
    kind: input.kind ?? "integration",
    state: input.state ?? "applying",
    data: { targetKinds, externalBindings: {}, ...input.data },
    targets,
    ...(input.surfacePaths ? { surfacePaths: input.surfacePaths } : {}),
  });
  for (const [file, desired] of Object.entries(input.phases ?? {})) {
    if (desired === "pending") continue;
    let operation = await durable.getOperation(workspaceId, input.operationId);
    let row = durableFiles(operation).find((entry) => entry.path === file);
    if (!row) throw new Error(`Seeded durable operation has no file ${file}`);
    if (row.phase === "pending") {
      await durable.updateOperationFile({
        operationId: input.operationId,
        workspaceId,
        path: file,
        expectedRevision: row.revision,
        expectedPhase: "pending",
        phase: "apply-intent",
        ...(targets[file]?.safety ? { safety: targets[file]!.safety } : {}),
      });
    }
    if (desired === "apply-intent") continue;
    operation = await durable.getOperation(workspaceId, input.operationId);
    row = durableFiles(operation).find((entry) => entry.path === file);
    if (!row) throw new Error(`Seeded durable operation lost file ${file}`);
    await durable.updateOperationFile({
      operationId: input.operationId,
      workspaceId,
      path: file,
      expectedRevision: row.revision,
      expectedPhase: row.phase,
      phase: desired,
    });
  }
  return durable.getOperation(workspaceId, input.operationId);
};

const reopenHarnessEngine = (
  h: Awaited<ReturnType<typeof createHarness>>,
  overrides: { resolveDirectoryApplyContext?: CreateWorkspaceRecoveryEngineOptions["resolveDirectoryApplyContext"] } = {},
) => trackEngine(createWorkspaceRecoveryEngine({
  authorityId: "test",
  dataDir: h.dataDir,
  documents: h.documents,
  durableRecoveryStore: h.durableRecoveryStore,
  fileStore: h.fileStore,
  sessionNavigation: h.navigation,
  resolveDirectoryApplyContext: overrides.resolveDirectoryApplyContext ?? h.resolveDirectoryApplyContext,
}));

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled([...recoveryEngines].map((engine) => engine.dispose()));
  recoveryEngines.clear();
  for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

describe("IntegrationCoordinator", () => {
  it("finishes an admitted merge while materialization waits on its existing virtual-write ticket", async () => {
    const h = await createHarness();
    await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "old\n");
    const result = await h.workingStates.withBranchStore("ws", "merge-switch-setup", async store => {
      const base = await store.captureDirectory(h.workspace);
      await store.createBranch("ws", "source", base); await store.createBranch("ws", "recipient", base);
      const object = await store.putObject(Buffer.from("new\n"));
      await store.commitVirtualWrites("source", 0, { "a.txt": { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength } });
      return store.publishHeadResult("source");
    });
    const gate = new VirtualWriteGate();
    const ticket = await acquireVirtualWriteTicket(gate, "recipient-session", () => true);
    if (ticket === "disk") throw new Error("Expected virtual authority");
    const switching = gate.beginSwitch("recipient-session");
    const coordinator = new IntegrationCoordinator({ workingStates: h.workingStates, holdParentVirtualWrite: async sessionId => {
      expect(gate.switching(sessionId)).toBe(false); // Reacquiring here would wait for the switch, which is waiting for this merge.
      const held = await acquireVirtualWriteTicket(gate, sessionId, () => true);
      return held === "disk" ? { status: "disk" } : { status: "virtual", release: held.finish };
    } });
    try {
      expect(gate.switching("recipient-session")).toBe(true);
      expect((await coordinator.mergeResult({ workspaceId: "ws", threadId: "source", branchId: "source", resultRevision: result.resultRevision,
        parentWriteHeld: true, parentAuthority: { kind: "branch", branchId: "recipient", sessionId: "recipient-session" } })).status).toBe("applied");
    } finally { ticket.finish(); await switching; gate.endSwitch("recipient-session"); }
    await h.workingStates.withBranchStore("ws", "merge-switch-check", async store => {
      const file = (await store.readStateSlice("recipient", ["a.txt"]))!["a.txt"]!;
      expect(file.kind === "regular-file" && (await store.getObject(file.objectHash))?.toString()).toBe("new\n");
    });
  });

  it("selected code preserves unsent hunks and recipient edits through repeated and final integration", async () => {
    const h = await createHarness();
    const registry = createThreadRegistry({ dataDir: h.dataDir, hostId: "test" });
    try {
      const source = await registry.createThread({ scopeId: "ws", parent: { kind: "session", id: "main" }, brief: "Source", kind: "implementation", createdBy: "agent", autoRun: false, concurrency: 2, worktree: "isolated", tools: ["write"], permissions: {} });
      const target = await registry.createThread({ scopeId: "ws", parent: source.parent, brief: "Recipient", kind: "implementation", createdBy: "agent", autoRun: false, concurrency: 2, worktree: "isolated", tools: ["write"], permissions: {} });
      const original = "first=old\nkeep1\nkeep2\nlast=old\n";
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), original);
      const prepared = await h.workingStates.withBranchStore("ws", "selected-code-setup", async store => {
        const base = await store.captureDirectory(h.workspace);
        await store.createBranch("ws", "source", base); await store.createBranch("ws", "recipient", base);
        const sourceText = "first=new\nkeep1\nkeep2\nlast=new\n";
        const object = await store.putObject(Buffer.from(sourceText));
        const current = { "a.txt": { kind: "regular-file" as const, objectHash: object.hash, byteLength: object.byteLength } };
        await store.commitVirtualWrites("source", 0, current);
        const selected = await selectCodeChanges(store, [{ path: "a.txt", edits: [{ before: "first=old\n", after: "first=new\n" }] }], base, current);
        await store.createBranch("ws", "selected", base);
        await store.commitVirtualWrites("selected", 0, selected);
        return { selected: await store.publishHeadResult("selected"), full: await store.publishHeadResult("source") };
      });
      const first = await h.coordinator.mergeResult({ workspaceId: "ws", threadId: source.id, branchId: "selected", resultRevision: prepared.selected.resultRevision,
        operationId: "selected-first", parentAuthority: { kind: "branch", branchId: "recipient" } });
      expect(first.status).toBe("applied");
      await registry.recordCodeSubmission("ws", { id: "selection", fingerprint: "selection", fromThreadId: source.id, toThreadId: target.id, branchId: "selected",
        resultRevision: prepared.selected.resultRevision, paths: ["a.txt"], acceptedPaths: ["a.txt"], appliedPaths: ["a.txt"], conflictPaths: [], status: "applied", createdAt: new Date().toISOString() });
      const baseline = await h.workingStates.withBranchStore("ws", "selected-code-recipient-edit", async store => {
        const state = await store.readStateSlice("recipient", ["a.txt"]);
        const file = state!["a.txt"]!;
        expect(file.kind === "regular-file" && (await store.getObject(file.objectHash))?.toString()).toBe("first=new\nkeep1\nkeep2\nlast=old\n");
        const edited = await store.putObject(Buffer.from("first=recipient-edited\nkeep1\nkeep2\nlast=old\n"));
        await store.commitVirtualWrites("recipient", (await store.getBranchRoot("recipient"))!.writeRevision, { "a.txt": { kind: "regular-file", objectHash: edited.hash, byteLength: edited.byteLength } });
        return submittedCodeBaseline(store, (await registry.getThreadById("ws", source.id))!, target.id);
      });
      const restarted = new IntegrationCoordinator({ workingStates: h.workingStates });
      expect((await restarted.mergeResult({ workspaceId: "ws", threadId: source.id, branchId: "selected", resultRevision: prepared.selected.resultRevision,
        operationId: "selected-first", parentAuthority: { kind: "branch", branchId: "recipient" } })).status).toBe("applied");
      const final = await restarted.mergeResult({ workspaceId: "ws", threadId: source.id, branchId: "source", resultRevision: prepared.full.resultRevision,
        baseStatesOverride: baseline, parentAuthority: { kind: "branch", branchId: "recipient" } });
      expect(final.status).toBe("applied");
      await h.workingStates.withBranchStore("ws", "selected-code-check", async store => {
        const state = (await store.readStateSlice("recipient", ["a.txt"]))!["a.txt"]!;
        expect(state.kind === "regular-file" && (await store.getObject(state.objectHash))?.toString()).toBe("first=recipient-edited\nkeep1\nkeep2\nlast=new\n");
      });
      const fullBaseline = { branchId: "source", resultRevision: prepared.full.resultRevision, receiver: { kind: "thread" as const, id: target.id },
        recipientAuthority: "branch:recipient", sourcePaths: ["a.txt"], codeReceiptIds: ["selection"] };
      await registry.setIntegration("ws", source.id, "merged", final.diffStats, undefined, prepared.full.resultRevision, fullBaseline);
      const retract = async (text: string) => h.workingStates.withBranchStore("ws", "source-retraction", async store => {
        const object = await store.putObject(Buffer.from(text));
        await store.commitVirtualWrites("source", (await store.getBranchRoot("source"))!.writeRevision,
          { "a.txt": { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength } });
        return store.publishHeadResult("source");
      });
      const resolveBaseStates = async (store: Parameters<typeof submittedCodeBaseline>[0]) => {
        const current = (await registry.getThreadById("ws", source.id))!;
        return submittedCodeBaseline(store, current, target.id, "branch:recipient", current.mergedSource);
      };
      const retracted = await retract("first=new\nkeep1\nkeep2\nlast=old\n");
      const input = { workspaceId: "ws", threadId: source.id, branchId: "source", resolveBaseStates, parentAuthority: { kind: "branch" as const, branchId: "recipient" } };
      const retraction = await restarted.mergeResult({ ...input, resultRevision: retracted.resultRevision });
      expect(retraction.status).toBe("applied");
      await registry.setIntegration("ws", source.id, "merged", retraction.diffStats, undefined, retracted.resultRevision,
        { ...fullBaseline, resultRevision: retracted.resultRevision });
      await h.workingStates.withBranchStore("ws", "retracted-source-check", async store => {
        const file = (await store.readStateSlice("recipient", ["a.txt"]))!["a.txt"]!;
        expect(file.kind === "regular-file" && (await store.getObject(file.objectHash))?.toString()).toBe("first=recipient-edited\nkeep1\nkeep2\nlast=old\n");
      });
      const originalAgain = await retract(original);
      expect(originalAgain.changedPaths).toEqual([]);
      expect((await restarted.previewResult({ ...input, resultRevision: originalAgain.resultRevision })).conflictPaths).toEqual(["a.txt"]);
      expect((await restarted.mergeResult({ ...input, resultRevision: originalAgain.resultRevision })).status).toBe("conflict");
      await h.workingStates.withBranchStore("ws", "conflicting-retraction-keeps-recipient", async store => {
        const file = (await store.readStateSlice("recipient", ["a.txt"]))!["a.txt"]!;
        expect(file.kind === "regular-file" && (await store.getObject(file.objectHash))?.toString()).toBe("first=recipient-edited\nkeep1\nkeep2\nlast=old\n");
      });
    } finally { await registry.dispose(); }
  });

  it("selected code resumes queued application after restart, reports real conflicts and never repeats a completed write", async () => {
    const h = await createHarness();
    let registry = createThreadRegistry({ dataDir: h.dataDir, hostId: "test" });
    let runtime: ReturnType<typeof createCodeSubmissionRuntime> | undefined;
    const errors: unknown[] = [];
    const applied = new Map<string, () => void>();
    let allowed = false;
    try {
      const source = await registry.createThread({ scopeId: "ws", parent: { kind: "session", id: "main" }, brief: "Source", kind: "implementation", createdBy: "agent", autoRun: false, concurrency: 2, worktree: "isolated", tools: ["write"], permissions: {} });
      const target = await registry.createThread({ scopeId: "ws", parent: source.parent, brief: "Recipient", kind: "implementation", createdBy: "agent", autoRun: false, concurrency: 2, worktree: "isolated", tools: ["write"], permissions: {} });
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "old\n");
      await h.workingStates.withBranchStore("ws", "selected-queue-setup", async store => {
        const base = await store.captureDirectory(h.workspace);
        await store.createBranch("ws", "source", base); await store.createBranch("ws", "recipient", base);
        const object = await store.putObject(Buffer.from("new\n"));
        await store.commitVirtualWrites("source", 0, { "a.txt": { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength } });
      });
      const create = () => createCodeSubmissionRuntime({ registry, workingStates: h.workingStates, onError: error => errors.push(error),
        capture: async (_scope, _source, _target, paths, store) => ({ base: (await store.readStateSlice("source", paths, { revision: 0 }))!, current: (await store.readStateSlice("source", paths))! }),
        apply: async (_scope, _target, submission) => allowed ? h.coordinator.mergeResult({ workspaceId: "ws", threadId: source.id,
          branchId: submission.branchId, resultRevision: submission.resultRevision, operationId: `selected-${submission.id}`, parentAuthority: { kind: "branch", branchId: "recipient" } }) : null,
        notify: async (_scope, _thread, submission) => { applied.get(submission.id)?.(); },
      });
      runtime = create();
      const request = { threadId: target.id, files: [{ path: "a.txt" }] };
      expect((await runtime.submit("ws", source, target, request, "once")).status).toBe("queued");
      await runtime.dispose(); runtime = undefined; await registry.dispose();
      registry = createThreadRegistry({ dataDir: h.dataDir, hostId: "test" }); allowed = true;
      const completed = new Promise<void>(resolve => applied.set("once", resolve));
      runtime = create(); await runtime.reconcile(); await completed; await runtime.dispose(); runtime = create();
      await h.workingStates.withBranchStore("ws", "selected-queue-edit", async store => {
        const object = await store.putObject(Buffer.from("recipient-edit\n"));
        await store.commitVirtualWrites("recipient", (await store.getBranchRoot("recipient"))!.writeRevision, { "a.txt": { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength } });
      });
      expect((await runtime.submit("ws", source, target, request, "once")).status).toBe("applied");
      await runtime.dispose(); runtime = create();
      await h.workingStates.withBranchStore("ws", "selected-conflict-edit", async store => {
        const object = await store.putObject(Buffer.from("source-next\n"));
        await store.commitVirtualWrites("source", (await store.getBranchRoot("source"))!.writeRevision, { "a.txt": { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength } });
      });
      const conflicted = new Promise<void>(resolve => applied.set("conflict", resolve));
      await runtime.submit("ws", source, target, request, "conflict"); await conflicted; await runtime.dispose(); runtime = undefined;
      expect((await registry.getThreadById("ws", source.id))?.codeSubmissions?.find(entry => entry.id === "conflict")).toMatchObject({ status: "conflict", acceptedPaths: [], conflictPaths: ["a.txt"] });
      await h.workingStates.withBranchStore("ws", "selected-queue-check", async store => {
        const state = (await store.readStateSlice("recipient", ["a.txt"]))!["a.txt"]!;
        expect(state.kind === "regular-file" && (await store.getObject(state.objectHash))?.toString()).toBe("recipient-edit\n");
      });
      expect(errors).toEqual([]);
      await registry.recordCodeSubmission("ws", { id: "interrupted-capture", fingerprint: "fixed-selection", fromThreadId: source.id, toThreadId: target.id,
        branchId: "code-interrupted", resultRevision: 0, paths: ["a.txt"], status: "capturing", appliedPaths: [], acceptedPaths: [], conflictPaths: [], notificationsPending: true, createdAt: new Date().toISOString() });
      await h.workingStates.withBranchStore("ws", "simulate-interrupted-code-capture", store => store.createBranch("ws", "code-interrupted", {}));
      const discarded = new Promise<void>(resolve => applied.set("interrupted-capture", resolve));
      runtime = create(); await runtime.reconcile(); await discarded; await runtime.dispose(); runtime = undefined;
      expect((await registry.getThreadById("ws", source.id))?.codeSubmissions?.find(entry => entry.id === "interrupted-capture")?.status).toBe("failed");
      await h.workingStates.withBranchStore("ws", "interrupted-code-released", async store => expect(await store.getBranchRoot("code-interrupted")).toBeNull());
    } finally { await runtime?.dispose(); await registry.dispose(); }
  });
  it("does not apply a manual conflict resolution against a parent newer than the reviewed revision", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "base\n");
      const child = path.join(h.root, "reviewed-child");
      await fs.promises.cp(h.workspace, child, { recursive: true });
      await fs.promises.writeFile(path.join(child, "a.txt"), "child\n");
      const result = await prepareResult(h, child);
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "parent at review\n");
      const input = { workspaceId: "ws", threadId: "thread-1", branchId: "thread-1", resultRevision: result.resultRevision };
      const preview = await h.coordinator.previewResult(input);
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "new user edit\n");
      await h.coordinator.mergeResult({
        ...input,
        expectedBindingFingerprint: preview.bindingFingerprint,
        resolutions: [{ path: "a.txt", choice: "text", text: "reviewed resolution\n", expectedParentRevision: preview.binding["a.txt"]!.revision }],
      }).catch(() => undefined);
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("new user edit\n");
    } finally {
      await h.engine.dispose();
    }
  });

  it("keeps a surface-only integration unfinished until the buffer application is confirmed", async () => {
    const h = await createHarness();
    let releaseApply: (() => void) | undefined;
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "base\n");
      const child = path.join(h.root, "surface-child");
      await fs.promises.cp(h.workspace, child, { recursive: true });
      await fs.promises.writeFile(path.join(child, "a.txt"), "child\n");
      const result = await prepareResult(h, child);
      const applyGate = new Promise<void>((resolve) => { releaseApply = resolve; });
      let signalApplyStarted!: () => void;
      const applyStarted = new Promise<void>((resolve) => { signalApplyStarted = resolve; });
      const coordinator = new IntegrationCoordinator({
        workingStates: h.workingStates,
        inspectDirtyBuffers: async () => [dirtyPublication("a.txt", "base\n")],
        requestSurfaceOperation: async (request) => {
          if (request.action === "capture") return [{
            resource: { workspaceId: "ws", resourceId: "a.txt" }, status: "captured",
            documentInstanceId: "document-a.txt", beforeLocalEditRevision: 1,
            beforeHash: textHash("base\n"), content: "base\n",
          }];
          signalApplyStarted();
          await applyGate;
          return [{
            resource: { workspaceId: "ws", resourceId: "a.txt" }, status: "applied",
            documentInstanceId: "document-a.txt", beforeLocalEditRevision: 1,
            beforeHash: textHash("base\n"), afterLocalEditRevision: 2, afterHash: textHash("child\n"),
          }];
        },
      });
      const pending = coordinator.mergeResult({
        workspaceId: "ws", threadId: "thread-1", branchId: "thread-1", resultRevision: result.resultRevision,
      });
      let settled = false;
      void pending.finally(() => { settled = true; });
      await applyStarted;
      expect(settled).toBe(false);
      const pendingOperations = await h.durableRecoveryStore.listOperations("ws", "integration");
      expect(pendingOperations).toHaveLength(1);
      expect(pendingOperations[0]).toMatchObject({ state: "awaiting-surface" });
      releaseApply?.();
      const merged = await pending;
      expect(merged.status).toBe("applied");
      expect(await h.durableRecoveryStore.getOperation("ws", merged.operationId)).toMatchObject({ state: "complete" });
    } finally {
      releaseApply?.();
      await h.engine.dispose();
    }
  });

  it("runs a non-Git prepare, publish, merge, reclaim, and reopen file chain", async () => {
    const h = await createHarness();
    const runtime = createThreadWorktreeRuntime({
      createWorktree: async (_source, input) => {
        const target = path.join(h.root, "worktrees", String(input.worktreeName));
        await fs.promises.mkdir(target, { recursive: true });
        return { path: target };
      },
      getWorktreeBootstrapStatus: async () => ({ status: "ready", phase: "setup-ready", error: null, updatedAt: Date.now() }),
    });
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "base");
      const prepared = await runtime.prepare({ mode: "isolated", sourceRoot: h.workspace, threadId: "thread-chain" });
      await h.workingStates.withStore("ws", "chain-baseline", async (store) => {
        await store.createBranch("ws", "thread-thread-chain", await store.captureDirectory(prepared.cwd), "zero-commit");
      });
      await fs.promises.writeFile(path.join(prepared.cwd, "a.txt"), "child result");
      const result = await h.workingStates.withStore("ws", "chain-publish", (store) => (
        store.publishDirectoryResult("thread-thread-chain", prepared.cwd)
      ));
      const snapshotted = await runtime.snapshot(prepared.worktree!);
      expect((await runtime.reclaim(snapshotted)).reclaimed).toBe(true);
      await h.coordinator.mergeResult({ workspaceId: "ws", threadId: "thread-chain", branchId: "thread-thread-chain", resultRevision: result.resultRevision });
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("child result");
      await h.workingStates.withStore("ws", "chain-reopen", (store) => (
        store.materializeResult("thread-thread-chain", result.resultRevision, prepared.cwd)
      ));
      expect(await fs.promises.readFile(path.join(prepared.cwd, "a.txt"), "utf8")).toBe("child result");
    } finally {
      await h.engine.dispose();
    }
  });

  it("integrates only base-to-selected-result changes and preserves unrelated parent files", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "base\n");
      await fs.promises.writeFile(path.join(h.workspace, "delete.txt"), "remove\n");
      await fs.promises.writeFile(path.join(h.workspace, "binary.bin"), Buffer.from([0, 1, 2]));
      await fs.promises.writeFile(path.join(h.workspace, "script.sh"), "echo base\n", { mode: 0o644 });
      const child = path.join(h.root, "child");
      await fs.promises.cp(h.workspace, child, { recursive: true });
      await fs.promises.writeFile(path.join(child, "a.txt"), "result one\n");
      await fs.promises.rm(path.join(child, "delete.txt"));
      await fs.promises.writeFile(path.join(child, "binary.bin"), Buffer.from([0, 9, 2]));
      await fs.promises.chmod(path.join(child, "script.sh"), 0o755);
      const childMode = (await fs.promises.stat(path.join(child, "script.sh"))).mode & 0o777;
      let symlinkSupported = true;
      try {
        await fs.promises.symlink("a.txt", path.join(child, "link.txt"));
      } catch {
        symlinkSupported = false;
      }
      const first = await prepareResult(h, child);
      await fs.promises.writeFile(path.join(child, "a.txt"), "result two\n");
      const second = await h.workingStates.withStore("ws", "test-publish", (store) => store.publishDirectoryResult("thread-1", child));
      await fs.promises.writeFile(path.join(h.workspace, "parent-only.txt"), "keep me\n");

      const merged = await h.coordinator.mergeResult({ workspaceId: "ws", threadId: "thread-1", branchId: "thread-1", resultRevision: first.resultRevision });
      expect(merged.status).toBe("applied");
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("result one\n");
      expect(await fs.promises.stat(path.join(h.workspace, "delete.txt")).then(() => true, () => false)).toBe(false);
      expect(await fs.promises.readFile(path.join(h.workspace, "binary.bin"))).toEqual(Buffer.from([0, 9, 2]));
      expect((await fs.promises.stat(path.join(h.workspace, "script.sh"))).mode & 0o777).toBe(childMode);
      if (symlinkSupported) expect(await fs.promises.readlink(path.join(h.workspace, "link.txt"))).toBe("a.txt");
      expect(await fs.promises.readFile(path.join(h.workspace, "parent-only.txt"), "utf8")).toBe("keep me\n");
      expect(second.resultRevision).toBe(2);
      const durable = await h.durableRecoveryStore.getOperation("ws", merged.operationId);
      const row = durableFiles(durable).find((file) => file.path === "a.txt");
      if (!row?.targetJson || !row.safetyJson) throw new Error("expected durable integration file states");
      const target = JSON.parse(row.targetJson) as RecoveryState;
      const safety = JSON.parse(row.safetyJson) as RecoveryState;
      expect(target.kind).toBe("regular-file");
      expect(safety.kind).toBe("regular-file");
      await h.workingStates.withStore("ws", "inspect-integration-objects", async (store) => {
        if (target.kind === "regular-file") expect(await store.getObject(target.objectHash)).not.toBeNull();
        if (safety.kind === "regular-file") expect(await store.getObject(safety.objectHash)).not.toBeNull();
      }, "shared");
    } finally {
      await h.engine.dispose();
    }
  });

  it("three-way merges parent edits and reports structural conflicts without overwriting them", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "text.txt"), "one\ntwo\nthree\n");
      await fs.promises.writeFile(path.join(h.workspace, "binary.bin"), Buffer.from([0, 1, 2]));
      const child = path.join(h.root, "child");
      await fs.promises.cp(h.workspace, child, { recursive: true });
      await fs.promises.writeFile(path.join(child, "text.txt"), "one\ntwo\nchild\n");
      await fs.promises.writeFile(path.join(child, "binary.bin"), Buffer.from([0, 9, 2]));
      const result = await prepareResult(h, child);
      await fs.promises.writeFile(path.join(h.workspace, "text.txt"), "parent\ntwo\nthree\n");
      await fs.promises.chmod(path.join(h.workspace, "text.txt"), 0o444);
      const parentMode = (await fs.promises.stat(path.join(h.workspace, "text.txt"))).mode & 0o777;
      await fs.promises.writeFile(path.join(h.workspace, "binary.bin"), Buffer.from([0, 8, 2]));

      const merged = await h.coordinator.mergeResult({ workspaceId: "ws", threadId: "thread-1", branchId: "thread-1", resultRevision: result.resultRevision });
      expect(merged.status).toBe("conflict");
      expect(merged.conflictPaths).toContain("binary.bin");
      expect(await fs.promises.readFile(path.join(h.workspace, "binary.bin"))).toEqual(Buffer.from([0, 8, 2]));
      expect(await fs.promises.readFile(path.join(h.workspace, "text.txt"), "utf8")).toContain("child");
      expect((await fs.promises.stat(path.join(h.workspace, "text.txt"))).mode & 0o777).toBe(parentMode);
    } finally {
      await h.engine.dispose();
    }
  });

  it("keeps an unsaved draft target off disk, then allows integration after the exact draft is saved", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "draft.txt"), "disk bytes\n");
      const child = path.join(h.root, "child-draft-target");
      await fs.promises.mkdir(child);
      await fs.promises.writeFile(path.join(child, "draft.txt"), "child bytes\n");
      const result = await h.workingStates.withStore("ws", "draft-target-result", async (store) => {
        const diskState = await store.captureDirectory(h.workspace);
        const object = await store.putObject(Buffer.from("unsaved draft\n"));
        const current = diskState["draft.txt"]!;
        const draftState: RecoveryState = {
          kind: "regular-file",
          objectHash: object.hash,
          byteLength: object.byteLength,
          ...(current.kind === "regular-file" && current.mode !== undefined ? { mode: current.mode } : {}),
        };
        await store.createBranch("ws", "thread-draft-target", { ...diskState, "draft.txt": draftState }, "base", ["draft.txt"]);
        return store.publishDirectoryResult("thread-draft-target", child);
      });
      expect(result.changedPaths).toEqual(["draft.txt"]);

      const blocked = await h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-draft-target",
        branchId: "thread-draft-target",
        resultRevision: result.resultRevision,
      });
      expect(blocked).toMatchObject({
        status: "conflict",
        appliedPaths: [],
        conflictPaths: ["draft.txt"],
        surfaceTargetPaths: ["draft.txt"],
      });
      expect(await fs.promises.readFile(path.join(h.workspace, "draft.txt"), "utf8")).toBe("disk bytes\n");

      await fs.promises.writeFile(path.join(h.workspace, "draft.txt"), "unsaved draft\n");
      const saved = await h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-draft-target",
        branchId: "thread-draft-target",
        resultRevision: result.resultRevision,
      });
      expect(saved).toMatchObject({ status: "applied", appliedPaths: ["draft.txt"], conflictPaths: [] });
      expect(await fs.promises.readFile(path.join(h.workspace, "draft.txt"), "utf8")).toBe("child bytes\n");

      const alreadyPresent = await h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-draft-target",
        branchId: "thread-draft-target",
        resultRevision: result.resultRevision,
      });
      expect(alreadyPresent).toMatchObject({ status: "applied", appliedPaths: [], conflictPaths: [] });
      expect(alreadyPresent.surfaceTargetPaths).toBeUndefined();
    } finally {
      await h.engine.dispose();
    }
  });

  it("reuses a completed conflict operation when the same result and resulting parent state are retried", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "conflict.txt"), "base\n");
      const child = path.join(h.root, "child-conflict-retry");
      await fs.promises.cp(h.workspace, child, { recursive: true });
      await fs.promises.writeFile(path.join(child, "conflict.txt"), "child\n");
      const result = await prepareResult(h, child);
      await fs.promises.writeFile(path.join(h.workspace, "conflict.txt"), "parent\n");

      const first = await h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-1",
        branchId: "thread-1",
        resultRevision: result.resultRevision,
      });
      const firstContent = await fs.promises.readFile(path.join(h.workspace, "conflict.txt"), "utf8");
      expect(first.status).toBe("conflict");
      expect(firstContent.match(/<<<<<<< parent/gu)).toHaveLength(1);

      const retried = await h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-1",
        branchId: "thread-1",
        resultRevision: result.resultRevision,
      });
      expect(retried.status).toBe("conflict");
      expect(retried.operationId).toBe(first.operationId);
      expect(retried.appliedPaths).toEqual([]);
      expect(await fs.promises.readFile(path.join(h.workspace, "conflict.txt"), "utf8")).toBe(firstContent);

      await fs.promises.writeFile(path.join(h.workspace, "conflict.txt"), "parent changed after conflict\n");
      const replanned = await h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-1",
        branchId: "thread-1",
        resultRevision: result.resultRevision,
      });
      expect(replanned.operationId).not.toBe(first.operationId);
    } finally {
      await h.engine.dispose();
    }
  });

  it("does not modify the user's Git index", async () => {
    const h = await createHarness();
    const git = (args: string[]) => execFileSync("git", args, { cwd: h.workspace, encoding: "utf8" });
    try {
      git(["init"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "Test"]);
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "base\n");
      await fs.promises.writeFile(path.join(h.workspace, "staged.txt"), "committed\n");
      git(["add", "-A"]);
      git(["commit", "-m", "base"]);
      const child = path.join(h.root, "child-index");
      await fs.promises.mkdir(child);
      await fs.promises.writeFile(path.join(child, "a.txt"), "child\n");
      await fs.promises.writeFile(path.join(child, "staged.txt"), "committed\n");
      const result = await prepareResult(h, child);
      await fs.promises.writeFile(path.join(h.workspace, "staged.txt"), "user staged\n");
      git(["add", "staged.txt"]);
      const before = git(["diff", "--cached", "--binary"]);

      await h.coordinator.mergeResult({ workspaceId: "ws", threadId: "thread-1", branchId: "thread-1", resultRevision: result.resultRevision });
      expect(git(["diff", "--cached", "--binary"])).toBe(before);
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("child\n");
    } finally {
      await h.engine.dispose();
    }
  });

  it("binds a completed integration into the active parent turn checkpoint", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "base");
      const started = await h.engine.recordTurnStart({
        activeWriterScopes: [],
        executionId: "parent-execution",
        provenance: "caused-by",
        runtimeGeneration: 1,
        sessionId: "parent-session",
        userEntryId: "parent-user-entry",
        workerId: "parent-worker",
        workspaceId: "ws",
      });
      expect(started.status).toBe("ready");
      const child = path.join(h.root, "child-turn-binding");
      await fs.promises.mkdir(child);
      await fs.promises.writeFile(path.join(child, "a.txt"), "merged");
      const result = await prepareResult(h, child);
      await h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-1",
        branchId: "thread-1",
        resultRevision: result.resultRevision,
        executionId: "parent-execution",
        requireTurnBinding: true,
      });
      const settled = await h.engine.recordTurnSettled({
        executionId: "parent-execution",
        workspaceId: "ws",
        activeWriterScopes: [],
        assistantEntryId: "parent-assistant-entry",
        mutationObserved: true,
        observationComplete: true,
        observedResourceIds: ["a.txt"],
        provenance: "caused-by",
      });
      expect(settled.status).toBe("ready");
      if (settled.status !== "ready") throw new Error("turn settlement failed");
      expect(settled.binding).toMatchObject({ status: "ready" });
      const selection = await durableChanges(h.durableRecoveryStore, { workspaceId: "ws", executionId: "parent-execution" });
      const row = selection.changes.find((change) => change.path === "a.txt");
      expect(row?.toolName).toBe("thread.merge");
      expect(row?.before).not.toEqual(row?.after);
    } finally {
      await h.engine.dispose();
    }
  });

  it("validates the parent turn binding before reconciling an interrupted integration", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "integration-target");
      await h.workingStates.withStore("ws", "seed-bound-recovery", async (store, context) => {
        const target = (await context.fileStore.captureState(context.identity, context.root, "a.txt", { store: true })).state;
        const beforeObject = await store.putObject(Buffer.from("before"));
        const safety: RecoveryState = {
          kind: "regular-file",
          objectHash: beforeObject.hash,
          byteLength: beforeObject.byteLength,
          ...(target.kind === "regular-file" && target.mode !== undefined ? { mode: target.mode } : {}),
        };
        const targets = { "a.txt": { expected: safety, target } };
        const data = {
          operationId: "interrupted-before-binding-check",
          threadId: "thread-1",
          resultRevision: 1,
          targets,
          safety: { "a.txt": safety },
          conflictPaths: [],
          appliedPaths: ["a.txt"],
          compensatedPaths: [],
          needsAttentionPaths: [],
          diffStats: { files: 1, insertions: 1, deletions: 0 },
        };
        await seedDurableOperation(h.durableRecoveryStore, {
          operationId: data.operationId,
          data: { ...data, executionId: "missing-parent-execution", requireTurnBinding: true },
          targets: { "a.txt": { ...targets["a.txt"]!, safety } },
          phases: { "a.txt": "target-observed" },
        });
      });

      await expect(h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-1",
        branchId: "thread-1",
        resultRevision: 1,
        executionId: "missing-parent-execution",
        requireTurnBinding: true,
      })).rejects.toThrow(/requires recovery|Parent turn recovery binding/);
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("integration-target");
      expect(await h.durableRecoveryStore.getOperation("ws", "interrupted-before-binding-check"))
        .toMatchObject({ state: "needs-attention" });
    } finally {
      await h.engine.dispose();
    }
  });

  it("releasing terminal recovery metadata does not release WorkingState result objects", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "base");
      const child = path.join(h.root, "child-retention");
      await fs.promises.mkdir(child);
      await fs.promises.writeFile(path.join(child, "a.txt"), "retained result");
      const result = await prepareResult(h, child);
      const merged = await h.coordinator.mergeResult({ workspaceId: "ws", threadId: "thread-1", branchId: "thread-1", resultRevision: result.resultRevision });
      expect(await h.durableRecoveryStore.releaseOperation("ws", merged.operationId)).toMatchObject({ released: true });
      expect(await h.durableRecoveryStore.getOperation("ws", merged.operationId)).toBeNull();
      await h.workingStates.withStore("ws", "read-retained-result", async (store) => {
        const retained = store.getResult("thread-1", result.resultRevision);
        expect(retained).not.toBeNull();
        const state = retained!.pathStates["a.txt"]!;
        expect(state.kind).toBe("regular-file");
        if (state.kind === "regular-file") expect((await store.getObject(state.objectHash))?.toString()).toBe("retained result");
      }, "shared");
    } finally {
      await h.engine.dispose();
    }
  });

  it("refuses explicit durable release while an integration still needs recovery", async () => {
    const h = await createHarness();
    try {
      await seedDurableOperation(h.durableRecoveryStore, {
        operationId: "unfinished-integration",
        data: { operationId: "unfinished-integration", threadId: "thread-1", resultRevision: 1, targets: {}, safety: {}, conflictPaths: [], appliedPaths: [], compensatedPaths: [], needsAttentionPaths: [], diffStats: { files: 0, insertions: 0, deletions: 0 } },
      });
      expect(await h.durableRecoveryStore.releaseOperation("ws", "unfinished-integration")).toMatchObject({ released: false });
      expect(await h.durableRecoveryStore.getOperation("ws", "unfinished-integration")).toMatchObject({ state: "applying" });
    } finally {
      await h.engine.dispose();
    }
  });

  it("conditionally compensates earlier paths when a later write fails", async () => {
    const native = createRecoveryFileStore();
    const durableRecoveryStore = createInMemoryRecoveryDurablePort();
    let applies = 0;
    const fileStore = { ...native, applyState: vi.fn(async (...args: Parameters<typeof native.applyState>) => {
      applies += 1;
      if (applies === 1) {
        const operations = await durableRecoveryStore.listOperations("ws", "integration");
        expect(operations).toHaveLength(1);
        const operation = await durableRecoveryStore.getOperation("ws", String(operations[0]!.operationId));
        expect(durableFiles(operation)).toHaveLength(2);
        expect(durableFiles(operation).every((row) => row.phase === "apply-intent" && row.safetyJson)).toBe(true);
      }
      if (applies === 2) throw new Error("injected second-path failure");
      await native.applyState(...args);
    }) };
    const h = await createHarness(fileStore, durableRecoveryStore);
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "a-base");
      await fs.promises.writeFile(path.join(h.workspace, "b.txt"), "b-base");
      const child = path.join(h.root, "child");
      await fs.promises.cp(h.workspace, child, { recursive: true });
      await fs.promises.writeFile(path.join(child, "a.txt"), "a-child");
      await fs.promises.writeFile(path.join(child, "b.txt"), "b-child");
      const result = await prepareResult(h, child);
      const merged = await h.coordinator.mergeResult({ workspaceId: "ws", threadId: "thread-1", branchId: "thread-1", resultRevision: result.resultRevision });
      expect(merged.status).toBe("compensated");
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("a-base");
      expect(await fs.promises.readFile(path.join(h.workspace, "b.txt"), "utf8")).toBe("b-base");
      expect(h.documents.runResourceOperation).toHaveBeenCalledWith(
        "ws",
        [expect.objectContaining({ scope: "subtree" })],
        expect.any(Function),
      );
    } finally {
      await h.engine.dispose();
    }
  });

  it("preserves a later user edit when compensation no longer matches the integration target", async () => {
    const native = createRecoveryFileStore();
    let applies = 0;
    let workspace = "";
    const fileStore = { ...native, applyState: vi.fn(async (...args: Parameters<typeof native.applyState>) => {
      applies += 1;
      if (applies === 2) {
        await fs.promises.writeFile(path.join(workspace, "a.txt"), "user after integration");
        throw new Error("injected second-path failure");
      }
      await native.applyState(...args);
    }) };
    const h = await createHarness(fileStore);
    workspace = h.workspace;
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "a-base");
      await fs.promises.writeFile(path.join(h.workspace, "b.txt"), "b-base");
      const child = path.join(h.root, "child-user-edit");
      await fs.promises.cp(h.workspace, child, { recursive: true });
      await fs.promises.writeFile(path.join(child, "a.txt"), "a-child");
      await fs.promises.writeFile(path.join(child, "b.txt"), "b-child");
      const result = await prepareResult(h, child);
      const merged = await h.coordinator.mergeResult({ workspaceId: "ws", threadId: "thread-1", branchId: "thread-1", resultRevision: result.resultRevision });
      expect(merged.status).toBe("needs-attention");
      expect(merged.needsAttentionPaths).toContain("a.txt");
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("user after integration");
    } finally {
      await h.engine.dispose();
    }
  });

  it("queues a Documents save behind the final integration check and returns its original-revision conflict", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "varin-integration-documents-gate-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    await fs.promises.mkdir(workspace, { recursive: true });
    const documents = createDocumentAuthority({
      hostId: "test",
      dataDir,
      isAllowedRoot: async () => true,
      isTrusted: async () => true,
    });
    const identity = await documents.resolveWorkspace({ path: workspace });
    const native = createRecoveryFileStore();
    let announceApply: (() => void) | undefined;
    let continueApply: (() => void) | undefined;
    const applyStarted = new Promise<void>((resolve) => { announceApply = resolve; });
    const applyRelease = new Promise<void>((resolve) => { continueApply = resolve; });
    const fileStore = {
      ...native,
      applyState: vi.fn(async (...args: Parameters<typeof native.applyState>) => {
        announceApply?.();
        await applyRelease;
        await native.applyState(...args);
      }),
    };
    const navigation: CreateWorkspaceRecoveryEngineOptions["sessionNavigation"] = {
      prepare: async () => ({ expectedLeafId: null, targetLeafId: null }),
      prepareLeaf: async () => ({ expectedLeafId: null, targetLeafId: null }),
      commit: async () => ({}),
      commitLeaf: async () => ({}),
    };
    const durableRecoveryStore = createInMemoryRecoveryDurablePort();
    const engine = trackEngine(createWorkspaceRecoveryEngine({
      authorityId: "test",
      dataDir,
      documents,
      durableRecoveryStore,
      fileStore,
      sessionNavigation: navigation,
    }));
    try {
      await fs.promises.writeFile(path.join(workspace, "a.txt"), "base");
      const original = await documents.read({ workspaceId: identity.workspaceId, resourceId: "a.txt" });
      if (original.status !== "ready") throw new Error("Expected original document revision");
      const child = path.join(root, "child-documents-gate");
      await fs.promises.mkdir(child);
      await fs.promises.writeFile(path.join(child, "a.txt"), "child");
      const workingStateRoot = path.join(root, "working-state-data");
      const workingStateDatabase = await openRecoveryJournalCatalog(workingStateRoot, { create: true });
      if (!workingStateDatabase) throw new Error("Working-state test catalog is missing");
      trackEngine({ dispose: async () => { workingStateDatabase.close(); } });
      const workingStates = createTestWorkingStateRootAccess(createWorkingStateStoreContextAccess({
        database: workingStateDatabase,
        fileStore,
        identity: { authorityId: "working-state-gate-test", canonicalRoot: workspace, filesystemProfile: "test", workspaceId: identity.workspaceId },
        resourceOperationGate: { run: (resources, operation) => documents.runResourceOperation!(identity.workspaceId, resources, operation) },
        root: workingStateRoot,
        collectUnreachableObjects: createWorkingStateObjectCollector(workingStateRoot, workingStateDatabase),
      }), durableRecoveryStore);
      const result = await workingStates.withBranchStore(identity.workspaceId, "test-publish", async (store) => {
        await store.createBranch(identity.workspaceId, "thread-gated", await store.captureDirectory(workspace), "base");
        return store.publishDirectoryResult("thread-gated", child);
      });
      const coordinator = new IntegrationCoordinator({ workingStates });
      const merging = coordinator.mergeResult({
        workspaceId: identity.workspaceId,
        threadId: "thread-gated",
        branchId: "thread-gated",
        resultRevision: result.resultRevision,
      });
      await applyStarted;

      let saveSettled = false;
      const saving = documents.write({
        resource: { workspaceId: identity.workspaceId, resourceId: "a.txt" },
        token: { workspaceId: identity.workspaceId, epoch: identity.epoch, owner: { kind: "test", id: "user-save" } },
        content: "user content started after final check",
        encoding: "utf-8",
        bom: false,
        expectedRevision: original.revision,
      }).finally(() => { saveSettled = true; });
      await new Promise((resolve) => setImmediate(resolve));
      expect(saveSettled).toBe(false);

      continueApply?.();
      expect((await merging).status).toBe("applied");
      const save = await saving;
      expect(save.status).toBe("conflict");
      if (save.status === "conflict") {
        expect(save.current).toMatchObject({ status: "ready" });
        if (save.current.status === "ready") expect(save.current.revision).not.toBe(original.revision);
      }
      expect(await fs.promises.readFile(path.join(workspace, "a.txt"), "utf8")).toBe("child");
    } finally {
      continueApply?.();
      await Promise.allSettled([engine.dispose(), documents.dispose()]);
    }
  });

  it("compensates instead of reporting success when the final operation commit fails", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "before");
      const applied = await h.workingStates.withStore("ws", "final-commit-failure", async (store, context) => {
        const before = (await context.fileStore.captureState(context.identity, context.root, "a.txt", { store: true })).state;
        const object = await store.putObject(Buffer.from("target"));
        const target: RecoveryState = { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength, ...(before.kind === "regular-file" && before.mode !== undefined ? { mode: before.mode } : {}) };
        const persisted = createInMemoryRecoveryDurablePort();
        const durableRecoveryStore = {
          ...persisted,
          completeOperation: async (input: Parameters<typeof persisted.completeOperation>[0]) => {
            if (input.state === "complete") throw new Error("injected final commit failure");
            return persisted.completeOperation(input);
          },
        };
        return applyDurableFileOperation({ ...context, durableRecoveryStore }, {
          id: "final-commit-failure",
          workspaceId: "ws",
          threadId: "thread-1",
          resultRevision: 1,
          targets: { "a.txt": { expected: before, target } },
          conflictPaths: [],
          diffStats: { files: 1, insertions: 1, deletions: 0 },
        });
      });
      expect(applied.status).toBe("compensated");
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("before");
    } finally {
      await h.engine.dispose();
    }
  });

  it("recovers a failed final commit before replanning a retry that would otherwise look like a no-op", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "base");
      const child = path.join(h.root, "child-final-retry");
      await fs.promises.mkdir(child);
      await fs.promises.writeFile(path.join(child, "a.txt"), "child");
      const result = await prepareResult(h, child);
      let terminalWrites = 0;
      const flakyDurable = {
        ...h.durableRecoveryStore,
        completeOperation: async (input: Parameters<typeof h.durableRecoveryStore.completeOperation>[0]) => {
          if (input.state === "complete" || input.state === "compensated" || input.state === "needs-attention") {
            terminalWrites += 1;
            throw new Error(terminalWrites === 1 ? "persistent final commit failure" : "persistent compensation status failure");
          }
          return h.durableRecoveryStore.completeOperation(input);
        },
      };
      const flakyCoordinator = new IntegrationCoordinator({
        workingStates: asTestWorkingStateRootAccess(h.workingStates, flakyDurable),
      });
      await expect(flakyCoordinator.mergeResult({ workspaceId: "ws", threadId: "thread-1", branchId: "thread-1", resultRevision: result.resultRevision }))
        .rejects.toThrow("compensation status could not be persisted");
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("base");

      const retry = await h.coordinator.mergeResult({ workspaceId: "ws", threadId: "thread-1", branchId: "thread-1", resultRevision: result.resultRevision });
      expect(retry.status).toBe("applied");
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("child");
    } finally {
      await h.engine.dispose();
    }
  });

  it("startup recovery uses the durable recovery port and restores exact regular/link/delete states", async () => {
    const h = await createHarness();
    let symlinkSupported = true;
    try {
      await fs.promises.writeFile(path.join(h.workspace, "regular.txt"), "before");
      await fs.promises.writeFile(path.join(h.workspace, "deleted.txt"), "restore me");
      try {
        await fs.promises.symlink("old-target", path.join(h.workspace, "link.txt"));
      } catch {
        symlinkSupported = false;
      }
      await h.workingStates.withStore("ws", "seed-crash", async (store, context) => {
        const regularBefore = (await context.fileStore.captureState(context.identity, context.root, "regular.txt", { store: true })).state;
        const deletedBefore = (await context.fileStore.captureState(context.identity, context.root, "deleted.txt", { store: true })).state;
        const regularObject = await store.putObject(Buffer.from("after"));
        const targets: Record<string, { expected: RecoveryState; target: RecoveryState }> = {
          "regular.txt": { expected: regularBefore, target: { kind: "regular-file", objectHash: regularObject.hash, byteLength: regularObject.byteLength, mode: regularBefore.kind === "regular-file" ? regularBefore.mode : undefined } },
          "deleted.txt": { expected: deletedBefore, target: { kind: "missing" } },
        };
        if (symlinkSupported) {
          const linkBefore = (await context.fileStore.captureState(context.identity, context.root, "link.txt", { store: true })).state;
          targets["link.txt"] = { expected: linkBefore, target: { kind: "symlink", symlinkTarget: "new-target" } };
        }
        const data = { operationId: "crashed-integration", threadId: "thread-1", resultRevision: 1, targets, safety: Object.fromEntries(Object.entries(targets).map(([file, states]) => [file, states.expected])), conflictPaths: [], appliedPaths: [], compensatedPaths: [], needsAttentionPaths: [], diffStats: { files: Object.keys(targets).length, insertions: 0, deletions: 0 } };
        await seedDurableOperation(h.durableRecoveryStore, {
          operationId: "crashed-integration",
          data,
          targets: Object.fromEntries(Object.entries(targets).map(([file, states]) => [file, { ...states, safety: states.expected }])),
          phases: Object.fromEntries(Object.keys(targets).map((file) => [file, "apply-intent" as const])),
        });
        for (const [file, states] of Object.entries(targets)) await context.fileStore.applyState(context.identity, context.root, file, states.target);
      });
      await h.engine.dispose();

      const restarted = reopenHarnessEngine(h);
      await restarted.fenceUnfinishedOperations();
      expect(await fs.promises.readFile(path.join(h.workspace, "regular.txt"), "utf8")).toBe("before");
      expect(await fs.promises.readFile(path.join(h.workspace, "deleted.txt"), "utf8")).toBe("restore me");
      if (symlinkSupported) expect(await fs.promises.readlink(path.join(h.workspace, "link.txt"))).toBe("old-target");
      expect(h.documents.runResourceOperation).toHaveBeenCalledWith(
        "ws",
        [expect.objectContaining({ scope: "subtree" })],
        expect.any(Function),
      );
      expect(await h.durableRecoveryStore.getOperation("ws", "crashed-integration")).toMatchObject({ state: "compensated" });
      await restarted.dispose();
    } finally {
      await h.engine.dispose();
    }
  });

  it("startup recovery leaves unexpected content untouched and marks needs-attention", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "before");
      await h.workingStates.withStore("ws", "seed-drift-crash", async (store, context) => {
        const before = (await context.fileStore.captureState(context.identity, context.root, "a.txt", { store: true })).state;
        const object = await store.putObject(Buffer.from("target"));
        const target: RecoveryState = { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength, ...(before.kind === "regular-file" && before.mode !== undefined ? { mode: before.mode } : {}) };
        const targets = { "a.txt": { expected: before, target } };
        const data = { operationId: "crashed-drift", threadId: "thread-1", resultRevision: 1, targets, safety: { "a.txt": before }, conflictPaths: [], appliedPaths: [], compensatedPaths: [], needsAttentionPaths: [], diffStats: { files: 1, insertions: 0, deletions: 0 } };
        await seedDurableOperation(h.durableRecoveryStore, {
          operationId: "crashed-drift", data,
          targets: { "a.txt": { ...targets["a.txt"]!, safety: before } },
          phases: { "a.txt": "apply-intent" },
        });
        await context.fileStore.applyState(context.identity, context.root, "a.txt", target);
      });
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "external edit");
      await h.engine.dispose();
      const restarted = reopenHarnessEngine(h);
      await restarted.fenceUnfinishedOperations();
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("external edit");
      expect(await h.durableRecoveryStore.getOperation("ws", "crashed-drift")).toMatchObject({ state: "needs-attention" });
      await restarted.dispose();
    } finally {
      await h.engine.dispose();
    }
  });

  it("startup recovery never replays a dispatched surface target as disk and keeps the mixed operation visible", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "disk.txt"), "before");
      await h.workingStates.withStore("ws", "seed-surface-crash", async (store, context) => {
        const before = (await context.fileStore.captureState(context.identity, context.root, "disk.txt", { store: true })).state;
        const diskTargetObject = await store.putObject(Buffer.from("after"));
        const surfaceBeforeObject = await store.putObject(Buffer.from("surface before"));
        const surfaceTargetObject = await store.putObject(Buffer.from("surface after"));
        const diskTarget: RecoveryState = {
          kind: "regular-file", objectHash: diskTargetObject.hash, byteLength: diskTargetObject.byteLength,
          ...(before.kind === "regular-file" && before.mode !== undefined ? { mode: before.mode } : {}),
        };
        const surfaceBefore: RecoveryState = { kind: "regular-file", objectHash: surfaceBeforeObject.hash, byteLength: surfaceBeforeObject.byteLength };
        const surfaceTarget: RecoveryState = { kind: "regular-file", objectHash: surfaceTargetObject.hash, byteLength: surfaceTargetObject.byteLength };
        const durableContext = { ...context, durableRecoveryStore: h.durableRecoveryStore };
        const pending = await applyDurableFileOperation(durableContext, {
          id: "crashed-surface-integration", workspaceId: "ws", threadId: "thread-surface-crash", resultRevision: 1,
          targets: { "disk.txt": { expected: before, target: diskTarget } },
          externalTargets: { "surface.txt": { expected: surfaceBefore, target: surfaceTarget } },
          externalBindings: { "surface.txt": {
            ownerId: "surface", ownerGeneration: 1, ownerRegistrationId: "registration",
            documentInstanceId: "document", baseRevision: "base", beforeLocalEditRevision: 1,
            beforeHash: textHash("surface before"), encoding: "utf-8", bom: false, lineEnding: "lf",
          } },
          conflictPaths: [], diffStats: { files: 2, insertions: 2, deletions: 0 },
        });
        expect(pending.status).toBe("pending");
        await markDurableExternalDispatched(durableContext, pending.operationId, ["surface.txt"]);
      });
      await h.engine.dispose();
      const restarted = reopenHarnessEngine(h);
      await restarted.fenceUnfinishedOperations();
      expect(await fs.promises.readFile(path.join(h.workspace, "disk.txt"), "utf8")).toBe("after");
      const recoveredSurface = await h.durableRecoveryStore.getOperation("ws", "crashed-surface-integration");
      expect(recoveredSurface).toMatchObject({ state: "needs-attention" });
      expect(durableFiles(recoveredSurface).find((file) => file.path === "surface.txt")).toMatchObject({ phase: "needs-attention" });
      await restarted.dispose();
    } finally {
      await h.engine.dispose();
    }
  });

  it("startup recovery never reconciles another workspace's row in a shared catalog", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "workspace-one");
      await h.workingStates.withStore("ws", "seed-other-workspace", async (store, context) => {
        const current = (await context.fileStore.captureState(context.identity, context.root, "a.txt", { store: true })).state;
        const object = await store.putObject(Buffer.from("other-target"));
        const target: RecoveryState = { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength, ...(current.kind === "regular-file" && current.mode !== undefined ? { mode: current.mode } : {}) };
        const targets = { "a.txt": { expected: current, target } };
        const data = { operationId: "other-workspace-operation", threadId: "other-thread", resultRevision: 1, targets, safety: { "a.txt": current }, conflictPaths: [], appliedPaths: [], compensatedPaths: [], needsAttentionPaths: [], diffStats: { files: 1, insertions: 0, deletions: 0 } };
        await seedDurableOperation(h.durableRecoveryStore, {
          workspaceId: "other-workspace", operationId: "other-workspace-operation", data,
          targets: { "a.txt": { ...targets["a.txt"]!, safety: current } }, phases: { "a.txt": "apply-intent" },
        });
        await seedDurableOperation(h.durableRecoveryStore, {
          workspaceId: "other-workspace", operationId: "other-workspace-combined", kind: "combined", state: "applying-files",
          data: { malformedForeignRecord: true },
        });
      });
      await h.engine.fenceUnfinishedOperations();
      expect(await h.durableRecoveryStore.getOperation("other-workspace", "other-workspace-operation")).toMatchObject({ state: "applying" });
      expect(await h.durableRecoveryStore.getOperation("other-workspace", "other-workspace-combined")).toMatchObject({ state: "applying-files" });
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("workspace-one");
    } finally {
      await h.engine.dispose();
    }
  });

  it("previews a clean disk result as merge-ready and invalidates after the parent changes", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "base\n");
      const child = path.join(h.root, "child-preview");
      await fs.promises.mkdir(child);
      await fs.promises.writeFile(path.join(child, "a.txt"), "child\n");
      const result = await prepareResult(h, child);
      const first = await h.coordinator.previewResult({
        workspaceId: "ws",
        threadId: "thread-1",
        branchId: "thread-1",
        resultRevision: result.resultRevision,
      });
      expect(first.mergeReady).toBe(true);
      expect(first.valid).toBe(true);
      expect(first.paths[0]?.target).toBe("disk");
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "parent continued\n");
      expect(h.coordinator.invalidateWorkspace("ws", ["a.txt"])).toMatchObject([{
        threadId: "thread-1", valid: false, mergeReady: false,
      }]);
      const second = await h.coordinator.previewResult({
        workspaceId: "ws",
        threadId: "thread-1",
        branchId: "thread-1",
        resultRevision: result.resultRevision,
      });
      expect(second.bindingFingerprint).not.toBe(first.bindingFingerprint);
      expect(second.mergeReady).toBe(false);
      expect(second.conflictPaths).toContain("a.txt");
    } finally {
      await h.engine.dispose();
    }
  });

  it("applies a supplied editor buffer without writing disk and records the surface phase", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "draft.txt"), "disk bytes\n");
      const child = path.join(h.root, "child-surface");
      await fs.promises.mkdir(child);
      await fs.promises.writeFile(path.join(child, "draft.txt"), "child bytes\n");
      const result = await h.workingStates.withStore("ws", "surface-result", async (store) => {
        const diskState = await store.captureDirectory(h.workspace);
        const object = await store.putObject(Buffer.from("unsaved draft\n"));
        const current = diskState["draft.txt"]!;
        await store.createBranch("ws", "thread-surface", {
          ...diskState,
          "draft.txt": {
            kind: "regular-file",
            objectHash: object.hash,
            byteLength: object.byteLength,
            ...(current.kind === "regular-file" && current.mode !== undefined ? { mode: current.mode } : {}),
          },
        }, "base", ["draft.txt"]);
        return store.publishDirectoryResult("thread-surface", child);
      });
      const coordinator = new IntegrationCoordinator({
        workingStates: h.workingStates,
        inspectDirtyBuffers: async () => [dirtyPublication("draft.txt", "unsaved draft\n", 4)],
        requestSurfaceOperation: async (request) => {
          if (request.action === "capture") return [{
            resource: { workspaceId: "ws", resourceId: "draft.txt" }, status: "captured",
            documentInstanceId: "document-draft.txt", beforeLocalEditRevision: 4,
            beforeHash: textHash("unsaved draft\n"), content: "unsaved draft\n",
          }];
          if (request.action === "apply") return [{
            resource: { workspaceId: "ws", resourceId: "draft.txt" }, status: "applied",
            documentInstanceId: "document-draft.txt", beforeLocalEditRevision: 4,
            beforeHash: textHash("unsaved draft\n"), afterLocalEditRevision: 5,
            afterHash: textHash("child bytes\n"),
          }];
          throw new Error("unexpected undo");
        },
      });
      const merged = await coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-surface",
        branchId: "thread-surface",
        resultRevision: result.resultRevision,
      });
      expect(await fs.promises.readFile(path.join(h.workspace, "draft.txt"), "utf8")).toBe("disk bytes\n");
      expect(merged.preview?.mergeReady).toBe(true);
      const surfaceOperation = await h.durableRecoveryStore.getOperation("ws", merged.operationId);
      expect(durableFiles(surfaceOperation).find((file) => file.path === "draft.txt")).toMatchObject({ phase: "external-target-observed" });
      const surfaceData = (surfaceOperation?.result ?? surfaceOperation?.data) as {
        externalBindings?: Record<string, { afterLocalEditRevision?: number; afterHash?: string }>;
      } | undefined;
      expect(surfaceData?.externalBindings?.["draft.txt"]).toMatchObject({
        afterLocalEditRevision: 5, afterHash: textHash("child bytes\n"),
      });
    } finally {
      await h.engine.dispose();
    }
  });

  it("compensates disk paths when the same operation's surface group explicitly rejects apply", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "disk.txt"), "disk base\n");
      await fs.promises.writeFile(path.join(h.workspace, "surface.txt"), "saved base\n");
      const child = path.join(h.root, "mixed-surface-child");
      await fs.promises.cp(h.workspace, child, { recursive: true });
      await fs.promises.writeFile(path.join(child, "disk.txt"), "disk child\n");
      await fs.promises.writeFile(path.join(child, "surface.txt"), "surface child\n");
      const result = await h.workingStates.withStore("ws", "mixed-surface-result", async (store) => {
        const base = await store.captureDirectory(h.workspace);
        const draft = await store.putObject(Buffer.from("surface draft\n"));
        const saved = base["surface.txt"]!;
        await store.createBranch("ws", "thread-mixed-surface", {
          ...base,
          "surface.txt": {
            kind: "regular-file", objectHash: draft.hash, byteLength: draft.byteLength,
            ...(saved.kind === "regular-file" && saved.mode !== undefined ? { mode: saved.mode } : {}),
          },
        }, "base", ["surface.txt"]);
        return store.publishDirectoryResult("thread-mixed-surface", child);
      });
      const coordinator = new IntegrationCoordinator({
        workingStates: h.workingStates,
        inspectDirtyBuffers: async () => [dirtyPublication("surface.txt", "surface draft\n", 2)],
        requestSurfaceOperation: async (request) => request.action === "capture" ? [{
          resource: { workspaceId: "ws", resourceId: "surface.txt" }, status: "captured",
          documentInstanceId: "document-surface.txt", beforeLocalEditRevision: 2,
          beforeHash: textHash("surface draft\n"), content: "surface draft\n",
        }] : [{
          resource: { workspaceId: "ws", resourceId: "surface.txt" }, status: "failed",
          documentInstanceId: "document-surface.txt", afterLocalEditRevision: 2,
          afterHash: textHash("surface draft\n"),
          message: "buffer changed before apply",
        }],
      });
      const merged = await coordinator.mergeResult({
        workspaceId: "ws", threadId: "thread-mixed-surface", branchId: "thread-mixed-surface",
        resultRevision: result.resultRevision,
      });
      expect(merged.status).toBe("compensated");
      expect(await fs.promises.readFile(path.join(h.workspace, "disk.txt"), "utf8")).toBe("disk base\n");
      expect(await fs.promises.readFile(path.join(h.workspace, "surface.txt"), "utf8")).toBe("saved base\n");
    } finally {
      await h.engine.dispose();
    }
  });

  it("undoes surface and disk targets as one conditional Integration operation", async () => {
    const h = await createHarness();
    let surfaceText = "surface draft\n";
    let surfaceRevision = 3;
    try {
      await fs.promises.writeFile(path.join(h.workspace, "disk.txt"), "disk base\n");
      await fs.promises.writeFile(path.join(h.workspace, "surface.txt"), "saved base\n");
      const child = path.join(h.root, "mixed-undo-child");
      await fs.promises.cp(h.workspace, child, { recursive: true });
      await fs.promises.writeFile(path.join(child, "disk.txt"), "disk child\n");
      await fs.promises.writeFile(path.join(child, "surface.txt"), "surface child\n");
      const result = await h.workingStates.withStore("ws", "mixed-undo-result", async (store) => {
        const base = await store.captureDirectory(h.workspace);
        const draft = await store.putObject(Buffer.from(surfaceText));
        const saved = base["surface.txt"]!;
        await store.createBranch("ws", "thread-mixed-undo", {
          ...base,
          "surface.txt": {
            kind: "regular-file", objectHash: draft.hash, byteLength: draft.byteLength,
            ...(saved.kind === "regular-file" && saved.mode !== undefined ? { mode: saved.mode } : {}),
          },
        }, "base", ["surface.txt"]);
        return store.publishDirectoryResult("thread-mixed-undo", child);
      });
      const coordinator = new IntegrationCoordinator({
        workingStates: h.workingStates,
        inspectDirtyBuffers: async () => [dirtyPublication("surface.txt", surfaceText, surfaceRevision)],
        requestSurfaceOperation: async (request) => {
          if (request.action === "capture") return [{
            resource: { workspaceId: "ws", resourceId: "surface.txt" }, status: "captured",
            documentInstanceId: "document-surface.txt", beforeLocalEditRevision: surfaceRevision,
            beforeHash: textHash(surfaceText), content: surfaceText,
          }];
          if (request.action === "apply") {
            const before = surfaceText;
            surfaceText = request.targets[0]!.newText!;
            const beforeRevision = surfaceRevision++;
            return [{
              resource: { workspaceId: "ws", resourceId: "surface.txt" }, status: "applied",
              documentInstanceId: "document-surface.txt", beforeLocalEditRevision: beforeRevision,
              beforeHash: textHash(before), afterLocalEditRevision: surfaceRevision, afterHash: textHash(surfaceText),
            }];
          }
          surfaceText = "surface draft\n";
          surfaceRevision += 1;
          return [{
            resource: { workspaceId: "ws", resourceId: "surface.txt" }, status: "undone",
            documentInstanceId: "document-surface.txt", afterLocalEditRevision: surfaceRevision,
            afterHash: textHash(surfaceText),
          }];
        },
      });
      const merged = await coordinator.mergeResult({
        workspaceId: "ws", threadId: "thread-mixed-undo", branchId: "thread-mixed-undo",
        resultRevision: result.resultRevision,
      });
      expect(merged.status).toBe("applied");
      expect(await fs.promises.readFile(path.join(h.workspace, "disk.txt"), "utf8")).toBe("disk child\n");
      expect(surfaceText).toBe("surface child\n");
      const undone = await coordinator.undoIntegration({
        workspaceId: "ws", threadId: "thread-mixed-undo", operationId: merged.operationId,
        sourceOwner: { ownerId: "editor-a", generation: 1 },
      });
      expect(undone.status).toBe("compensated");
      expect(await fs.promises.readFile(path.join(h.workspace, "disk.txt"), "utf8")).toBe("disk base\n");
      expect(surfaceText).toBe("surface draft\n");
      const repeated = await coordinator.undoIntegration({
        workspaceId: "ws", threadId: "thread-mixed-undo", operationId: merged.operationId,
        sourceOwner: { ownerId: "editor-a", generation: 1 },
      });
      expect(repeated.status).toBe("compensated");
      expect(await fs.promises.readFile(path.join(h.workspace, "disk.txt"), "utf8")).toBe("disk base\n");
      expect(surfaceText).toBe("surface draft\n");
    } finally {
      await h.engine.dispose();
    }
  });

  it("normalizes a UTF-8 BOM and CRLF draft for surface merge while preserving its editor format binding", async () => {
    const h = await createHarness();
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    try {
      await fs.promises.writeFile(path.join(h.workspace, "draft-crlf.txt"), "saved\r\n");
      const child = path.join(h.root, "surface-crlf-child");
      await fs.promises.mkdir(child);
      await fs.promises.writeFile(path.join(child, "draft-crlf.txt"), Buffer.concat([bom, Buffer.from("child\r\n")]));
      const result = await h.workingStates.withStore("ws", "surface-crlf-result", async (store) => {
        const disk = await store.captureDirectory(h.workspace);
        const draft = await store.putObject(Buffer.concat([bom, Buffer.from("base\r\n")]));
        const current = disk["draft-crlf.txt"]!;
        await store.createBranch("ws", "thread-surface-crlf", {
          ...disk,
          "draft-crlf.txt": {
            kind: "regular-file", objectHash: draft.hash, byteLength: draft.byteLength,
            ...(current.kind === "regular-file" && current.mode !== undefined ? { mode: current.mode } : {}),
          },
        }, "base", ["draft-crlf.txt"]);
        return store.publishDirectoryResult("thread-surface-crlf", child);
      });
      let appliedText: string | undefined;
      const basePublication = dirtyPublication("draft-crlf.txt", "base\n", 6);
      const publication = {
        ...basePublication,
        resources: [{ ...basePublication.resources[0]!, bom: true, lineEnding: "crlf" as const }],
      };
      const coordinator = new IntegrationCoordinator({
        workingStates: h.workingStates,
        inspectDirtyBuffers: async () => [publication],
        requestSurfaceOperation: async (request) => {
          if (request.action === "capture") return [{
            resource: { workspaceId: "ws", resourceId: "draft-crlf.txt" }, status: "captured",
            documentInstanceId: "document-draft-crlf.txt", beforeLocalEditRevision: 6,
            beforeHash: textHash("base\n"), content: "base\n",
          }];
          appliedText = request.targets[0]?.newText;
          return [{
            resource: { workspaceId: "ws", resourceId: "draft-crlf.txt" }, status: "applied",
            documentInstanceId: "document-draft-crlf.txt", beforeLocalEditRevision: 6,
            beforeHash: textHash("base\n"), afterLocalEditRevision: 7, afterHash: textHash("child\n"),
          }];
        },
      });
      const merged = await coordinator.mergeResult({
        workspaceId: "ws", threadId: "thread-surface-crlf", branchId: "thread-surface-crlf",
        resultRevision: result.resultRevision,
      });
      expect(merged.status).toBe("applied");
      expect(appliedText).toBe("child\n");
      expect(merged.preview?.binding["draft-crlf.txt"]).toMatchObject({ bom: true, lineEnding: "crlf" });
      expect(await fs.promises.readFile(path.join(h.workspace, "draft-crlf.txt"), "utf8")).toBe("saved\r\n");
    } finally {
      await h.engine.dispose();
    }
  });

  it("classifies a live dirty publication as a surface target even after the draft is saved on disk", async () => {
    const h = await createHarness();
    const coordinator = new IntegrationCoordinator({
      workingStates: h.workingStates,
      inspectDirtyBuffers: async () => [dirtyPublication("live.txt", "saved disk\n", 3)],
      requestSurfaceOperation: async () => [{
        resource: { workspaceId: "ws", resourceId: "live.txt" }, status: "captured",
        documentInstanceId: "document-live.txt", beforeLocalEditRevision: 3,
        beforeHash: textHash("saved disk\n"), content: "saved disk\n",
      }],
    });
    try {
      await fs.promises.writeFile(path.join(h.workspace, "live.txt"), "saved disk\n");
      const child = path.join(h.root, "child-live");
      await fs.promises.mkdir(child);
      await fs.promises.writeFile(path.join(child, "live.txt"), "child\n");
      const result = await prepareResult(h, child, "thread-live");
      const preview = await coordinator.previewResult({
        workspaceId: "ws",
        threadId: "thread-live",
        branchId: "thread-live",
        resultRevision: result.resultRevision,
      });
      expect(preview.mergeReady).toBe(true);
      expect(preview.surfaceTargetPaths).toEqual(["live.txt"]);
      expect(preview.paths[0]?.target).toBe("surface");
    } finally {
      await h.engine.dispose();
    }
  });

  it("does not fall back to disk when the turn's explicit draft owner is disconnected", async () => {
    const h = await createHarness();
    const coordinator = new IntegrationCoordinator({
      workingStates: h.workingStates,
      inspectDirtyBuffers: async () => [],
    });
    try {
      await fs.promises.writeFile(path.join(h.workspace, "draft.txt"), "saved baseline\n");
      const child = path.join(h.root, "child-disconnected-owner");
      await fs.promises.mkdir(child);
      await fs.promises.writeFile(path.join(child, "draft.txt"), "child\n");
      const result = await h.workingStates.withStore("ws", "disconnected-owner-result", async (store) => {
        const base = await store.captureDirectory(h.workspace);
        await store.createBranch("ws", "thread-disconnected-owner", base, "base", ["draft.txt"]);
        return store.publishDirectoryResult("thread-disconnected-owner", child);
      });
      const preview = await coordinator.previewResult({
        workspaceId: "ws",
        threadId: "thread-disconnected-owner",
        branchId: "thread-disconnected-owner",
        resultRevision: result.resultRevision,
        sourceOwner: { ownerId: "disconnected-editor", generation: 4 },
      });
      expect(preview.mergeReady).toBe(false);
      expect(preview.unavailablePaths).toEqual(["draft.txt"]);
      expect(preview.paths[0]?.target).toBe("unavailable");
      expect(await fs.promises.readFile(path.join(h.workspace, "draft.txt"), "utf8")).toBe("saved baseline\n");
    } finally {
      await h.engine.dispose();
    }
  });

  it("applies a virtual new file that omitted mode onto the workspace", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "kept.txt"), "base\n");
      const result = await h.workingStates.withStore("ws", "virtual-new-file", async (store) => {
        await store.createBranch("ws", "thread-virtual-new", await store.captureDirectory(h.workspace), "base");
        const object = await store.putObject(Buffer.from("added by virtual write\n"));
        expect(await store.commitVirtualWrite("thread-virtual-new", 0, "added.txt", {
          kind: "regular-file",
          objectHash: object.hash,
          byteLength: object.byteLength,
        })).toMatchObject({ status: "committed" });
        return store.publishHeadResult("thread-virtual-new");
      });
      const merged = await h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-virtual-new",
        branchId: "thread-virtual-new",
        resultRevision: result.resultRevision,
      });
      expect(merged).toMatchObject({ status: "applied" });
      expect(merged.appliedPaths).toEqual(["added.txt"]);
      expect(await fs.promises.readFile(path.join(h.workspace, "added.txt"), "utf8")).toBe("added by virtual write\n");
      expect(await fs.promises.readFile(path.join(h.workspace, "kept.txt"), "utf8")).toBe("base\n");
      const added = path.join(h.workspace, "added.txt");
      const beforeMode = (await fs.promises.lstat(added)).mode & 0o7777;
      await fs.promises.chmod(added, beforeMode ^ 0o111);
      const afterMode = (await fs.promises.lstat(added)).mode & 0o7777;
      if (afterMode === beforeMode) return;
      const undone = await h.coordinator.undoIntegration({
        workspaceId: "ws",
        threadId: "thread-virtual-new",
        operationId: merged.operationId,
      });
      expect(undone.status).toBe("needs-attention");
    } finally {
      await h.engine.dispose();
    }
  });

  it("applies a materialized parent directory without writing recovery objects into that directory", async () => {
    const h = await createHarness();
    const parentDir = path.join(h.root, "parent-worktree");
    try {
      await fs.promises.mkdir(parentDir, { recursive: true });
      h.directoryWorkspaces.set(path.resolve(parentDir), "parent-exec");
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "parent\n");
      await fs.promises.writeFile(path.join(parentDir, "a.txt"), "parent\n");
      const child = path.join(h.root, "dir-child");
      await fs.promises.cp(h.workspace, child, { recursive: true });
      await fs.promises.writeFile(path.join(child, "a.txt"), "grandchild\n");
      const result = await prepareResult(h, child);
      const merged = await h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-1",
        branchId: "thread-1",
        resultRevision: result.resultRevision,
        parentAuthority: { kind: "directory", directory: parentDir, workspaceId: "parent-exec" },
      });
      expect(h.documents.runResourceOperation).toHaveBeenCalledWith(
        "parent-exec",
        [expect.objectContaining({ scope: "subtree" })],
        expect.any(Function),
      );
      expect(h.documents.runResourceOperation).not.toHaveBeenCalledWith(
        "ws",
        [expect.objectContaining({ resourceId: "a.txt" })],
        expect.any(Function),
      );
      expect(merged).toMatchObject({ status: "applied", appliedPaths: ["a.txt"] });
      expect(await fs.promises.readFile(path.join(parentDir, "a.txt"), "utf8")).toBe("grandchild\n");
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("parent\n");
      expect(await fs.promises.stat(path.join(parentDir, ".varin")).then(() => true, () => false)).toBe(false);
      const parentListing = await fs.promises.readdir(parentDir, { recursive: true });
      expect(parentListing.some((entry) => String(entry).includes("staging") || String(entry).includes("objects"))).toBe(false);
    } finally {
      await h.engine.dispose();
    }
  });

  it("startup directory reconcile writes through the execution Documents gate and keeps objects on the owning root", async () => {
    const h = await createHarness();
    const parentDir = path.join(h.root, "parent-worktree");
    try {
      await fs.promises.mkdir(parentDir, { recursive: true });
      h.directoryWorkspaces.set(path.resolve(parentDir), "parent-exec");
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "owning\n");
      await fs.promises.writeFile(path.join(parentDir, "a.txt"), "before\n");
      await h.workingStates.withStore("ws", "seed-directory-crash", async (store, context) => {
        const before = (await context.fileStore.captureState(
          { ...context.identity, canonicalRoot: parentDir },
          context.root,
          "a.txt",
          { store: true },
        )).state;
        const object = await store.putObject(Buffer.from("after\n"));
        const target: RecoveryState = {
          kind: "regular-file",
          objectHash: object.hash,
          byteLength: object.byteLength,
          ...(before.kind === "regular-file" && before.mode !== undefined ? { mode: before.mode } : {}),
        };
        const targets = { "a.txt": { expected: before, target } };
        const data = {
          operationId: "crashed-directory",
          threadId: "thread-1",
          resultRevision: 1,
          targets,
          safety: { "a.txt": before },
          conflictPaths: [],
          appliedPaths: [],
          compensatedPaths: [],
          needsAttentionPaths: [],
          diffStats: { files: 1, insertions: 0, deletions: 0 },
          applyCanonicalRoot: parentDir,
          applyExecutionWorkspaceId: "parent-exec",
        };
        await seedDurableOperation(h.durableRecoveryStore, {
          operationId: "crashed-directory", data,
          targets: { "a.txt": { ...targets["a.txt"]!, safety: before } },
          phases: { "a.txt": "apply-intent" },
        });
        await context.fileStore.applyState({ ...context.identity, canonicalRoot: parentDir }, context.root, "a.txt", target);
      });
      await h.engine.dispose();
      vi.mocked(h.documents.runResourceOperation!).mockClear();
      const restarted = reopenHarnessEngine(h);
      await restarted.fenceUnfinishedOperations();
      expect(await fs.promises.readFile(path.join(parentDir, "a.txt"), "utf8")).toBe("before\n");
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("owning\n");
      expect(h.documents.runResourceOperation).toHaveBeenCalledWith(
        "parent-exec",
        [expect.objectContaining({ scope: "subtree" })],
        expect.any(Function),
      );
      expect(h.documents.runResourceOperation).not.toHaveBeenCalledWith(
        "ws",
        [expect.objectContaining({ resourceId: "a.txt" })],
        expect.any(Function),
      );
      expect(await fs.promises.stat(path.join(parentDir, ".varin")).then(() => true, () => false)).toBe(false);
      expect(await h.durableRecoveryStore.getOperation("ws", "crashed-directory")).toMatchObject({ state: "compensated" });
      await restarted.dispose();
    } finally {
      await h.engine.dispose();
    }
  });

  it("marks directory reconcile needs-attention when the execution directory cannot be resolved", async () => {
    const h = await createHarness();
    const parentDir = path.join(h.root, "missing-parent");
    try {
      await fs.promises.mkdir(parentDir, { recursive: true });
      await fs.promises.writeFile(path.join(parentDir, "a.txt"), "leave-me\n");
      await h.workingStates.withStore("ws", "seed-unresolved-directory", async (store, context) => {
        const before = (await context.fileStore.captureState(
          { ...context.identity, canonicalRoot: parentDir },
          context.root,
          "a.txt",
          { store: true },
        )).state;
        const object = await store.putObject(Buffer.from("after\n"));
        const target: RecoveryState = {
          kind: "regular-file",
          objectHash: object.hash,
          byteLength: object.byteLength,
          ...(before.kind === "regular-file" && before.mode !== undefined ? { mode: before.mode } : {}),
        };
        const targets = { "a.txt": { expected: before, target } };
        const data = {
          operationId: "unresolved-directory",
          threadId: "thread-1",
          resultRevision: 1,
          targets,
          safety: { "a.txt": before },
          conflictPaths: [],
          appliedPaths: [],
          compensatedPaths: [],
          needsAttentionPaths: [],
          diffStats: { files: 1, insertions: 0, deletions: 0 },
          applyCanonicalRoot: parentDir,
          applyExecutionWorkspaceId: "parent-exec",
        };
        await seedDurableOperation(h.durableRecoveryStore, {
          operationId: "unresolved-directory", data,
          targets: { "a.txt": { ...targets["a.txt"]!, safety: before } },
          phases: { "a.txt": "apply-intent" },
        });
        await context.fileStore.applyState({ ...context.identity, canonicalRoot: parentDir }, context.root, "a.txt", target);
      });
      await h.engine.dispose();
      vi.mocked(h.documents.runResourceOperation!).mockClear();
      const restarted = reopenHarnessEngine(h, {
        resolveDirectoryApplyContext: async () => { throw new Error("execution directory is gone"); },
      });
      await restarted.fenceUnfinishedOperations();
      expect(await fs.promises.readFile(path.join(parentDir, "a.txt"), "utf8")).toBe("after\n");
      expect(h.documents.runResourceOperation).not.toHaveBeenCalled();
      expect(await h.durableRecoveryStore.getOperation("ws", "unresolved-directory")).toMatchObject({ state: "needs-attention" });
      await restarted.dispose();
    } finally {
      await h.engine.dispose();
    }
  });

  it("reconciles a branch CAS that crashed before the complete record", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "kept.txt"), "base\n");
      const published = await h.workingStates.withStore("ws", "branch-crash-setup", async (store) => {
        const captured = await store.captureDirectory(h.workspace);
        await store.createBranch("ws", "thread-parent", captured, "base");
        await store.createBranch("ws", "thread-child", captured, "base");
        const object = await store.putObject(Buffer.from("from-child\n"));
        await store.commitVirtualWrites("thread-child", 0, {
          "child.txt": { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength },
        });
        return store.publishHeadResult("thread-child");
      });
      const crashing = new IntegrationCoordinator({
        workingStates: h.workingStates,
        commitParentVirtualWrites: async (input) => {
          const committed = await input.store.commitVirtualWrites(
            input.branchId,
            input.expectedWriteRevision,
            input.files,
          );
          if (committed.status !== "committed") throw new Error("expected branch CAS to commit before the crash");
          throw new Error("injected crash after branch CAS");
        },
      });
      await expect(crashing.mergeResult({
        workspaceId: "ws",
        threadId: "thread-child",
        branchId: "thread-child",
        resultRevision: published.resultRevision,
        parentAuthority: { kind: "branch", branchId: "thread-parent" },
      })).rejects.toThrow("injected crash after branch CAS");
      const branchOperations = await h.durableRecoveryStore.listOperations("ws", "integration");
      expect(branchOperations).toHaveLength(1);
      expect(branchOperations[0]).toMatchObject({ state: "applying" });
      const operationId = String(branchOperations[0]!.operationId);
      const hasChild = await h.workingStates.withStore("ws", "inspect-crashed-branch", async (store) => (
        store.effectiveState("thread-parent")?.["child.txt"]?.kind === "regular-file"
      ), "shared");
      expect(hasChild).toBe(true);
      await h.engine.dispose();
      const restarted = reopenHarnessEngine(h);
      await restarted.fenceUnfinishedOperations();
      const restartedStates = h.workingStates;
      await restartedStates.withBranchStore("ws", "reconcile-crashed-branch", (store, context) => {
        if (!context?.durableRecoveryStore) throw new Error("durable recovery storage missing");
        return reconcileInterruptedKernelBranchIntegrations({ ...context, durableRecoveryStore: context.durableRecoveryStore }, store);
      });
      expect(await h.durableRecoveryStore.getOperation("ws", operationId)).toMatchObject({ state: "complete" });
      const retry = await new IntegrationCoordinator({
        workingStates: restartedStates,
      }).mergeResult({
        workspaceId: "ws",
        threadId: "thread-child",
        branchId: "thread-child",
        resultRevision: published.resultRevision,
        parentAuthority: { kind: "branch", branchId: "thread-parent" },
      });
      expect(retry.operationId).toBe(operationId);
      expect(retry.status).toBe("applied");
      await restartedStates.withStore("ws", "assert-parent-kept-child", async (store) => {
        const live = store.effectiveState("thread-parent")!;
        const childFile = live["child.txt"];
        if (childFile?.kind !== "regular-file") throw new Error("expected child file after reconcile");
        expect(await store.getObject(childFile.objectHash)).toEqual(Buffer.from("from-child\n"));
      }, "shared");
      await restarted.dispose();
    } finally {
      await h.engine.dispose();
    }
  });

  it("persists a branch parent integration so retry is idempotent and undo is reversible", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "kept.txt"), "base\n");
      const published = await h.workingStates.withStore("ws", "branch-parent-setup", async (store) => {
        const captured = await store.captureDirectory(h.workspace);
        await store.createBranch("ws", "thread-parent", captured, "base");
        await store.createBranch("ws", "thread-child", captured, "base");
        const object = await store.putObject(Buffer.from("from-child\n"));
        await store.commitVirtualWrites("thread-child", 0, {
          "child.txt": { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength },
        });
        return store.publishHeadResult("thread-child");
      });
      const first = await h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-child",
        branchId: "thread-child",
        resultRevision: published.resultRevision,
        parentAuthority: { kind: "branch", branchId: "thread-parent" },
      });
      expect(first).toMatchObject({ status: "applied", appliedPaths: ["child.txt"] });
      expect(await h.durableRecoveryStore.listOperations("ws", "integration"))
        .toEqual([expect.objectContaining({ operationId: first.operationId, state: "complete" })]);
      const retry = await h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-child",
        branchId: "thread-child",
        resultRevision: published.resultRevision,
        parentAuthority: { kind: "branch", branchId: "thread-parent" },
      });
      expect(retry.operationId).toBe(first.operationId);
      expect(retry.status).toBe("applied");
      await h.workingStates.withStore("ws", "assert-parent-has-child", async (store) => {
        const live = store.effectiveState("thread-parent")!;
        const childFile = live["child.txt"];
        if (childFile?.kind !== "regular-file") throw new Error("expected child file on parent");
        expect(await store.getObject(childFile.objectHash)).toEqual(Buffer.from("from-child\n"));
      }, "shared");
      const undone = await h.coordinator.undoIntegration({
        workspaceId: "ws",
        threadId: "thread-child",
        operationId: first.operationId,
      });
      expect(undone.status).toBe("compensated");
      await h.workingStates.withStore("ws", "assert-parent-restored", async (store) => {
        const live = store.effectiveState("thread-parent")!;
        expect(live["child.txt"] ?? { kind: "missing" }).toEqual({ kind: "missing" });
      }, "shared");
    } finally {
      await h.engine.dispose();
    }
  });

  it("undoes a branch integration through the materialized parent directory and syncs the branch cache", async () => {
    const h = await createHarness();
    const parentDir = path.join(h.root, "materialized-parent");
    try {
      await fs.promises.mkdir(parentDir, { recursive: true });
      h.directoryWorkspaces.set(path.resolve(parentDir), "parent-exec");
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "before\n");
      await fs.promises.writeFile(path.join(parentDir, "a.txt"), "before\n");
      const published = await h.workingStates.withStore("ws", "materialized-undo-setup", async (store) => {
        const base = await store.captureDirectory(h.workspace);
        await store.createBranch("ws", "thread-parent-materialized", base, "base");
        await store.createBranch("ws", "thread-child-materialized", base, "base");
        const object = await store.putObject(Buffer.from("after\n"));
        await store.commitVirtualWrites("thread-child-materialized", 0, {
          "a.txt": { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength },
        });
        return store.publishHeadResult("thread-child-materialized");
      });
      const merged = await h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-child-materialized",
        branchId: "thread-child-materialized",
        resultRevision: published.resultRevision,
        parentAuthority: { kind: "branch", branchId: "thread-parent-materialized" },
      });
      await h.workingStates.withStore("ws", "materialize-parent-for-undo", async (store) => {
        const parentResult = await store.publishHeadResult("thread-parent-materialized");
        await store.materializeResult("thread-parent-materialized", parentResult.resultRevision, parentDir);
      });
      const undone = await h.coordinator.undoIntegration({
        workspaceId: "ws",
        threadId: "thread-child-materialized",
        operationId: merged.operationId,
        parentAuthority: { kind: "directory", directory: parentDir, workspaceId: "parent-exec" },
      });
      expect(undone.status).toBe("compensated");
      expect(await fs.promises.readFile(path.join(parentDir, "a.txt"), "utf8")).toBe("before\n");
      await h.workingStates.withStore("ws", "assert-materialized-undo-branch", (store) => {
        expect(store.effectiveState("thread-parent-materialized")?.["a.txt"]).toMatchObject({ kind: "regular-file" });
        return undefined;
      }, "shared");
      const parentState = await h.workingStates.withStore("ws", "read-materialized-undo-branch", async (store) => {
        const state = store.effectiveState("thread-parent-materialized")?.["a.txt"];
        return state?.kind === "regular-file" ? store.getObject(state.objectHash) : null;
      }, "shared");
      expect(parentState).toEqual(Buffer.from("before\n"));
    } finally {
      await h.engine.dispose();
    }
  });

  it("leaves a later materialized parent edit untouched and reports attention", async () => {
    const h = await createHarness();
    const parentDir = path.join(h.root, "materialized-parent-drift");
    try {
      await fs.promises.mkdir(parentDir, { recursive: true });
      h.directoryWorkspaces.set(path.resolve(parentDir), "parent-exec");
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "before\n");
      await fs.promises.writeFile(path.join(parentDir, "a.txt"), "before\n");
      const published = await h.workingStates.withStore("ws", "materialized-drift-setup", async (store) => {
        const base = await store.captureDirectory(h.workspace);
        await store.createBranch("ws", "thread-parent-drift", base, "base");
        await store.createBranch("ws", "thread-child-drift", base, "base");
        const object = await store.putObject(Buffer.from("after\n"));
        await store.commitVirtualWrites("thread-child-drift", 0, {
          "a.txt": { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength },
        });
        return store.publishHeadResult("thread-child-drift");
      });
      const merged = await h.coordinator.mergeResult({
        workspaceId: "ws", threadId: "thread-child-drift", branchId: "thread-child-drift",
        resultRevision: published.resultRevision,
        parentAuthority: { kind: "branch", branchId: "thread-parent-drift" },
      });
      await h.workingStates.withStore("ws", "materialize-parent-for-drift", async (store) => {
        const parentResult = await store.publishHeadResult("thread-parent-drift");
        await store.materializeResult("thread-parent-drift", parentResult.resultRevision, parentDir);
      });
      await fs.promises.writeFile(path.join(parentDir, "a.txt"), "user edit\n");
      const undone = await h.coordinator.undoIntegration({
        workspaceId: "ws", threadId: "thread-child-drift", operationId: merged.operationId,
        parentAuthority: { kind: "directory", directory: parentDir, workspaceId: "parent-exec" },
      });
      expect(undone.status).toBe("needs-attention");
      expect(await fs.promises.readFile(path.join(parentDir, "a.txt"), "utf8")).toBe("user edit\n");
    } finally {
      await h.engine.dispose();
    }
  });

  it("reconciles a crash after materialized branch undo apply", async () => {
    let crashAfterApply = false;
    const native = createRecoveryFileStore();
    const crashingStore = {
      ...native,
      applyState: async (...args: Parameters<typeof native.applyState>) => {
        await native.applyState(...args);
        if (crashAfterApply) throw new Error("injected crash after materialized undo apply");
      },
    };
    const h = await createHarness(crashingStore);
    const parentDir = path.join(h.root, "materialized-parent-crash");
    try {
      await fs.promises.mkdir(parentDir, { recursive: true });
      h.directoryWorkspaces.set(path.resolve(parentDir), "parent-exec");
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "before\n");
      await fs.promises.writeFile(path.join(parentDir, "a.txt"), "before\n");
      const published = await h.workingStates.withStore("ws", "materialized-crash-setup", async (store) => {
        const base = await store.captureDirectory(h.workspace);
        await store.createBranch("ws", "thread-parent-crash", base, "base");
        await store.createBranch("ws", "thread-child-crash", base, "base");
        const object = await store.putObject(Buffer.from("after\n"));
        await store.commitVirtualWrites("thread-child-crash", 0, {
          "a.txt": { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength },
        });
        return store.publishHeadResult("thread-child-crash");
      });
      const merged = await h.coordinator.mergeResult({
        workspaceId: "ws", threadId: "thread-child-crash", branchId: "thread-child-crash",
        resultRevision: published.resultRevision,
        parentAuthority: { kind: "branch", branchId: "thread-parent-crash" },
      });
      await h.workingStates.withStore("ws", "materialize-parent-for-crash", async (store) => {
        const parentResult = await store.publishHeadResult("thread-parent-crash");
        await store.materializeResult("thread-parent-crash", parentResult.resultRevision, parentDir);
      });
      crashAfterApply = true;
      await expect(h.coordinator.undoIntegration({
        workspaceId: "ws", threadId: "thread-child-crash", operationId: merged.operationId,
        parentAuthority: { kind: "directory", directory: parentDir, workspaceId: "parent-exec" },
      })).rejects.toThrow("injected crash");
      crashAfterApply = false;
      await h.engine.dispose();
      const restarted = reopenHarnessEngine(h);
      await restarted.fenceUnfinishedOperations();
      expect(await fs.promises.readFile(path.join(parentDir, "a.txt"), "utf8")).toBe("before\n");
      const restartedStates = h.workingStates;
      await restartedStates.withBranchStore("ws", "reconcile-materialized-undo-branch", (store, context) => {
        if (!context?.durableRecoveryStore) throw new Error("durable recovery storage missing");
        return reconcileInterruptedKernelBranchIntegrations({ ...context, durableRecoveryStore: context.durableRecoveryStore, resolveDirectoryApplyContext: h.resolveDirectoryApplyContext }, store);
      });
      const branchBytes = await restartedStates.withStore("ws", "inspect-materialized-undo-branch", async (store) => {
        const state = store.effectiveState("thread-parent-crash")?.["a.txt"];
        return state?.kind === "regular-file" ? store.getObject(state.objectHash) : null;
      }, "shared");
      expect(branchBytes).toEqual(Buffer.from("before\n"));
      expect(await h.durableRecoveryStore.getOperation("ws", merged.operationId)).toMatchObject({ state: "undone" });
      await restarted.dispose();
    } finally {
      await h.engine.dispose();
    }
  });
});
