import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkspaceRecoveryContractError,
  createWorkspaceRecoveryAPI,
  parseRecoveryConversation,
  parseRecoveryFileTarget,
  parseRecoveryStorageLocation,
  parseRecoveryRetentionPolicy,
  parseRecoveryStorageStatus,
  parseRecoveryStorageWorkspaceSummary,
  parseWorkspaceCombinedRecoveryApplyInput,
  parseWorkspaceCombinedRecoveryPlan,
  parseWorkspaceRecoveryCheckpointSummary,
  parseWorkspaceRecoveryEntryBindingResult,
  parseWorkspaceRecoveryMutationAfterInput,
  parseWorkspaceRecoveryTurnBinding,
} from "../src/index.js";

const checkpoint = () => ({
  byteLength: 5,
  changedPathCount: 1,
  createdAt: "2026-08-30T00:00:00.000Z",
  entryId: "user-1",
  executionId: "execution-1",
  id: "checkpoint-1",
  sequence: 1,
  conversation: { kind: 'thread', threadId: "session-1", branchId: 'branch-1' },
  source: "turn",
  state: "ready",
  workspaceId: "workspace-1",
});

test("parses every storage mode and journal-oriented storage counts", () => {
  assert.deepEqual(parseRecoveryStorageLocation({ mode: "application-data" }), { mode: "application-data" });
  assert.deepEqual(parseRecoveryStorageLocation({ mode: "workspace-local" }), { mode: "workspace-local" });
  assert.deepEqual(parseRecoveryStorageLocation({ mode: "workspace-adjacent" }), { mode: "workspace-adjacent" });
  assert.deepEqual(parseRecoveryStorageLocation({ mode: "custom", customRoot: "/recovery" }), {
    customRoot: "/recovery",
    mode: "custom",
  });
  assert.throws(
    () => parseRecoveryStorageLocation({ mode: "application-data", customRoot: "/escape" }),
    WorkspaceRecoveryContractError,
  );
  assert.equal(parseRecoveryStorageStatus({
    authorityId: "authority-1",
    byteLength: 0,
    catalog: { currentSchemaVersion: 5, retiredCatalogCount: 0, state: "ready" },
    checkpointCount: 0,
    encryption: { available: false, enabled: false },
    location: { mode: "workspace-local" },
    locationSource: "global",
    objectCount: 0,
    readyCheckpointCount: 0,
    registryRevision: 1,
    state: "missing",
  }).checkpointCount, 0);
  assert.equal(parseRecoveryStorageWorkspaceSummary({
    byteLength: 0,
    canonicalRoot: "/workspace",
    catalog: { currentSchemaVersion: 5, retiredCatalogCount: 0, state: "ready" },
    checkpointCount: 0,
    lastActivityAt: null,
    location: { mode: "application-data" },
    locationSource: "workspace",
    migrationRequired: false,
    objectCount: 0,
    state: "missing",
    storageAvailable: true,
    workspaceAvailable: true,
    workspaceId: "workspace-1",
  }).workspaceAvailable, true);
});

test("keeps recovery retention optional and rejects unsafe timestamp ranges", () => {
  assert.deepEqual(parseRecoveryRetentionPolicy({
    maxAgeDays: null,
    maxByteLength: 1024,
    maxCheckpointCount: 20,
    maxOperationCount: null,
  }), {
    maxAgeDays: null,
    maxByteLength: 1024,
    maxCheckpointCount: 20,
    maxOperationCount: null,
  });
  assert.throws(() => parseRecoveryRetentionPolicy({
    maxAgeDays: Number.MAX_SAFE_INTEGER,
    maxByteLength: null,
    maxCheckpointCount: null,
    maxOperationCount: null,
  }), WorkspaceRecoveryContractError);
});

test("keeps mutation boundaries, turn binding coverage, and entry binding explicit", () => {
  assert.equal(parseWorkspaceRecoveryMutationAfterInput({
    executionId: "execution-1",
    mutationId: "mutation-1",
    path: "/workspace/note.txt",
    succeeded: true,
    toolCallId: "tool-1",
    toolName: "write",
    workspaceId: "workspace-1",
  }).succeeded, true);
  assert.throws(() => parseWorkspaceRecoveryMutationAfterInput({
    executionId: "execution-1",
    mutationId: "mutation-1",
    path: "/workspace/note.txt",
    toolCallId: "tool-1",
    toolName: "write",
    workspaceId: "workspace-1",
  }), WorkspaceRecoveryContractError);

  const binding = parseWorkspaceRecoveryTurnBinding({
    activeWriterScopes: [],
    checkpointId: "checkpoint-1",
    executionId: "execution-1",
    provenance: "caused-by",
    runtimeGeneration: 1,
    runtimeKey: "worker-1@1",
    conversation: { kind: 'thread', threadId: "session-1", branchId: 'branch-1' },
    startedAt: "2026-08-30T00:00:00.000Z",
    status: "ready",
    unrecordedResourceIds: [],
    userEntryId: "user-1",
    workerId: "worker-1",
    workspaceId: "workspace-1",
  });
  assert.equal(binding.checkpointId, "checkpoint-1");
  assert.deepEqual(parseWorkspaceRecoveryEntryBindingResult({
    reason: "checkpoint-incomplete",
    status: "incomplete",
  }), {
    reason: "checkpoint-incomplete",
    status: "incomplete",
  });
});

test("plans only affected paths and keeps conflict handling explicit", () => {
  const physical = { kind: 'physical' as const, workspaceId: 'resource-workspace', threadId: 'thread', runId: 'run',
    rootId: 'original-root', canonicalRoot: '/same-name', executionWorkspaceId: 'execution-workspace', sourceMode: 'materialized' as const };
  const managed = { kind: 'managed' as const, hostId: 'resource-host', target: physical };
  const plan = parseWorkspaceCombinedRecoveryPlan({
    affectedPaths: ["src/a.ts"],
    fileTargets: { 'src/a.ts': { path: 'src/a.ts', target: managed } },
    changedBytes: 12,
    conflicts: [{ fingerprint: `sha256-${"b".repeat(64)}`, kind: "content-changed", message: "changed", path: "src/a.ts" }],
    coverage: "ready",
    createdAt: "2026-08-30T00:00:00.000Z",
    entryId: "user-1",
    expectedLeafId: "leaf-2",
    id: "operation-1",
    removedEntryIds: ["user-1", "assistant-1"],
    revision: `sha256-${"a".repeat(64)}`,
    conversation: { kind: 'thread', threadId: "session-1", branchId: 'branch-1' },
    targetLeafId: "leaf-1",
    uncoveredPaths: [],
    uncoveredReasons: [],
    workspaceId: "workspace-1",
  });
  assert.deepEqual(plan.affectedPaths, ["src/a.ts"]);
  assert.deepEqual(plan.fileTargets?.['src/a.ts']?.target, managed);
  assert.throws(() => parseRecoveryFileTarget({ ...managed, target: managed }), WorkspaceRecoveryContractError);
  assert.throws(() => parseRecoveryFileTarget({ ...managed, target: { kind: 'workspace' } }), WorkspaceRecoveryContractError);
  assert.equal(plan.conflicts[0]?.kind, "content-changed");
  assert.deepEqual(plan.uncoveredPaths, []);
  assert.deepEqual(plan.uncoveredReasons, []);
  assert.deepEqual(parseWorkspaceCombinedRecoveryApplyInput({
    confirmedConflicts: [{ fingerprint: plan.conflicts[0]?.fingerprint, path: "src/a.ts" }],
    conflictPolicy: "overwrite-confirmed",
    expectedRevision: plan.revision,
    operationId: plan.id,
  }).confirmedConflicts, [{ fingerprint: plan.conflicts[0]?.fingerprint, path: "src/a.ts" }]);
  assert.throws(() => parseWorkspaceCombinedRecoveryApplyInput({
    confirmedConflicts: [],
    conflictPolicy: "overwrite-confirmed",
    expectedRevision: plan.revision,
    operationId: plan.id,
  }), WorkspaceRecoveryContractError);
  assert.throws(() => parseWorkspaceCombinedRecoveryApplyInput({
    confirmedConflicts: [],
    conflictPolicy: "overwrite",
    expectedRevision: plan.revision,
    operationId: plan.id,
  }), WorkspaceRecoveryContractError);
});

test("browser-safe API invokes the current checkpoint method", async () => {
  const requests: unknown[] = [];
  const api = createWorkspaceRecoveryAPI(async (request) => {
    requests.push(request);
    return { page: { checkpoints: [checkpoint()], nextCursor: null }, status: "ready" };
  });
  const result = await api.listCheckpoints({ workspaceId: "workspace-1" });
  assert.equal(result.status, "ready");
  assert.deepEqual(requests, [{
    args: [{ workspaceId: "workspace-1" }],
    method: "listCheckpoints",
    serviceId: "varin.workspace-recovery",
    version: 7,
  }]);
});


test("rejects retired or mixed conversation identities rather than coercing them to a native Thread", () => {
  for (const conversation of [
    { kind: "pi", sessionId: "old-history" },
    { kind: "thread", threadId: "thread", branchId: "branch", sessionId: "old-history" },
    { kind: "thread", threadId: "thread" },
  ]) assert.throws(() => parseRecoveryConversation(conversation), WorkspaceRecoveryContractError);
  const legacy = { ...checkpoint(), conversation: { kind: "pi", sessionId: "old-history" } };
  const original = structuredClone(legacy);
  assert.throws(() => parseWorkspaceRecoveryCheckpointSummary(legacy), WorkspaceRecoveryContractError);
  assert.deepEqual(legacy, original);
});
