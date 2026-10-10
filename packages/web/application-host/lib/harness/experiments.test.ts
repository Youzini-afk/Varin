import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import type { KernelClient, KernelScopedClient } from "../kernel/kernel-client.js";
import type { KernelRecordResult } from "../kernel/protocol.generated.js";
import { createExperimentService, type ExperimentCaller } from "./experiments.js";
import type { ExperimentBackend, ResolvedExperimentBackend } from "./experiment-backend.js";
import type { ResourceService } from "./resources.js";
import { createSourceService } from "./sources.js";

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

/** An explicit in-memory Storage/backend fixture. The production ExperimentService remains the owner under test. */
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-admission-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "input.txt"), "immutable input");
  const records = new Map<string, KernelRecordResult>();
  const operations = new Map<string, Record<string, unknown>>();
  const branches = new Map<string, { root: string; paths: string[] }>();
  const events: string[] = [];
  const errors: Error[] = [];
  const caller: ExperimentCaller = { workspaceId: "ws", executionWorkspaceId: "exec", sessionId: "session", threadId: "thread", runId: "run", rootSessionId: "root", workspaceScope: [] };
  let currentRoot = root;
  let backendAvailable = true;
  let beforeReadBranch: () => Promise<void> = async () => {};
  let beforeCreateAck: (signal?: AbortSignal) => Promise<void> = async () => {};
  let loseDeleteReply = false;
  let sequence = 0;
  let beforeScan: (signal?: AbortSignal) => Promise<void> = async () => {};
  let beforePrepare: (signal?: AbortSignal) => Promise<void> = async () => {};
  let beforeCapture: (signal?: AbortSignal) => Promise<void> = async () => {};
  const activeLeases = new Set<string>();
  let beforeSpawn: () => Promise<void> = async () => {};
  let beforeInspect: () => Promise<void> = async () => {};
  let failKills = false;
  let loseCreateReply = false;
  let loseSpawnReply = false;
  let writerActiveOverride: boolean | undefined;
  let preparedRoot: string | undefined;
  let observed: "running" | "unknown" | "cancelled" = "running";
  let spawnCalls = 0;
  let resolveCalls = 0;
  let scanCalls = 0;
  let prepareCalls = 0;
  let admissionCalls = 0;
  let admissionRecovery: "confirmed" | "not-admitted" | "unknown" = "unknown";
  let beforeAdmit: () => Promise<void> = async () => {};
  let preparationRecovery: "drained" | "unknown" = "unknown";
  let recoveryCalls = 0;
  let captureCalls = 0;
  const committed = new Set<string>();
  const scoped = {
    async getRecord(_workspace: string, id: string) { return structuredClone(records.get(id) ?? null); },
    async putRecord(input: Record<string, unknown>) {
      const id = String(input.recordId); const prior = records.get(id);
      if (prior ? input.expectedRecordRevision !== prior.recordRevision : input.expectedRecordRevision !== undefined) throw new Error("record revision conflict");
      const record = { ...input, recordRevision: (prior?.recordRevision ?? 0) + 1, createdAt: prior?.createdAt ?? ++sequence, updatedAt: ++sequence } as unknown as KernelRecordResult;
      records.set(id, structuredClone(record)); events.push(`${id}:${input.state}`); return structuredClone(record);
    },
    async listRecords(input: { workspaceId: string; recordType: string }) { return { records: structuredClone([...records.values()].filter((r) => r.workspaceId === input.workspaceId && r.recordType === input.recordType)), nextCursor: null }; },
    async fileLeaseAcquire(input: { leaseId: string }) { activeLeases.add(input.leaseId); return { status: "acquired" }; },
    async fileLeaseRelease(input: { leaseId: string }) { activeLeases.delete(input.leaseId); return { released: true }; },
    async fileRootRegister() { return { rootId: "source-root" }; },
    async fileScan(_input: unknown, signal?: AbortSignal) { scanCalls++; await beforeScan(signal); signal?.throwIfAborted(); return { paths: ["input.txt"], fingerprint: "input-tree" }; },
    async fileCaptureBatch(input: { paths: string[]; store: boolean }, signal?: AbortSignal) {
      captureCalls++; await beforeCapture(signal); return { entries: input.paths.map((relative) => ({ path: relative,
        stateJson: JSON.stringify({ kind: "regular-file", objectHash: "sha256-input", byteLength: 15, mode: 420 }),
        ...(input.store ? { ownerId: "fixture-owner" } : {}) })) };
    },
    async createBranch(input: { branchId: string; operationId: string; entries: Array<{ path: string }> }, signal?: AbortSignal) {
      const result = { branchId: input.branchId, root: "sha256-frozen", created: true };
      branches.set(input.branchId, { root: result.root, paths: input.entries.map((e) => e.path) });
      operations.set(input.operationId, { state: "committed", result });
      await beforeCreateAck(signal);
      if (loseCreateReply) { loseCreateReply = false; throw new Error("create response lost"); }
      return result;
    },
    async readBranch(input: { branchId: string }) {
      await beforeReadBranch();
      const branch = branches.get(input.branchId); if (!branch) throw new Error("branch missing");
      return { workspaceId: "ws", root: branch.root, currentRoot: branch.root, entries: branch.paths.map((p) => ({ path: p })) };
    },
    async deleteBranch(input: { branchId: string; operationId: string }) {
      const result = { branchId: input.branchId, deleted: branches.delete(input.branchId) };
      operations.set(input.operationId, { state: "committed", result });
      if (loseDeleteReply) { loseDeleteReply = false; throw new Error("delete response lost"); }
      return result;
    },
    async getOperation(id: string) { return structuredClone(operations.get(id) ?? null); },
    async releaseBlob() {},
  } as unknown as KernelScopedClient;
  const client = { start: async () => ({}), issueGrant: async () => ({}), scoped: () => scoped } as unknown as KernelClient;
  const resources = {
    async listMachines() { return [{ machineId: "local", state: "available", connection: { status: "connected" }, capacity: { cpuCores: 64 }, commitments: [...committed].map((id) => ({ commitmentId: id, attemptId: id.slice(7), state: "confirmed", resources: {} })) }]; },
    async getMachineRecord(_workspace: string, machineId: string) { return machineId === "remote" ? { machineId: "remote" } : null; },
    async admit(_ws: string, _machine: string, _request: unknown, attemptId: string) { admissionCalls++; await beforeAdmit(); committed.add(`commit-${attemptId}`); events.push("admitted"); return { status: "confirmed", commitmentId: `commit-${attemptId}` }; },
    async reconcileAdmission(_ws: string, _machine: string, _request: unknown, attemptId: string) {
      if (admissionRecovery === "confirmed") { committed.add(`commit-${attemptId}`); return { status: "confirmed", commitmentId: `commit-${attemptId}` }; }
      return { status: admissionRecovery };
    },
    async release(_ws: string, id: string) { committed.delete(id); events.push("released"); },
    async getCommitmentAllocation() { return null; },
  } as unknown as ResourceService;
  const backend: ExperimentBackend = {
    backend: "fixture", controls: ["cancel", "attach", "collect"],
    async spawn(_site, request) { spawnCalls++; events.push("spawn"); await beforeSpawn(); if (loseSpawnReply) { loseSpawnReply = false; throw new Error("spawn reply lost"); } return { handle: { backendJobId: request.backendJobId }, observation: { status: observed, writerActive: writerActiveOverride ?? observed !== "cancelled" } }; },
    async inspect() { await beforeInspect(); return { status: observed, writerActive: writerActiveOverride ?? observed !== "cancelled" }; },
    async read(_site, _job, cursor) { events.push("read"); return { chunks: [], nextCursor: cursor, endCursor: cursor, observation: { status: observed, writerActive: writerActiveOverride ?? observed !== "cancelled" } }; },
    async kill() { events.push("kill"); if (failKills) throw new Error("temporary control outage"); observed = "cancelled"; },
    async release() { events.push("backend-release"); },
    async collectFile() { throw new Error("fixture has no output files"); },
  };
  const resolved: ResolvedExperimentBackend = {
    backend, site: { workspaceId: "ws", rootId: "execution-root", canonicalRoot: root, transport: null },
    async reconcilePreparation() { recoveryCalls++; return preparationRecovery; },
    async prepare({ signal, input }) { prepareCalls++; await beforePrepare(signal); return { site: this.site, cwd: "", inputRoot: preparedRoot ?? input.root }; },
  };
  const sources = createSourceService({ client });
  const makeService = () => {
    const service = createExperimentService({ client, resources, sources, resolveWorkspaceRoot: async () => { resolveCalls++; return currentRoot; }, resolveBackend: () => backendAvailable ? resolved : null, onError: (error) => errors.push(error) });
    cleanup.push(() => service.dispose()); return service;
  };
  const service = makeService();
  const snapshot = { schemaVersion: 1, branchId: "seed-branch", root: "sha256-seed", sourceRoot: root, workspaceId: "ws", executionWorkspaceId: "exec", captureScopes: [], capturedPathCount: 0, inventoryFingerprint: "seed", captureSemantics: { excludedDirectories: [".git", ".varin"], gitignore: "not-applied", ignoredFilesIncluded: true } };
  records.set("experiment.spec:seed", { recordId: "experiment.spec:seed", workspaceId: "ws", recordType: "experiment.spec", state: "active", recordRevision: 1, payloadJson: JSON.stringify({ id: "seed", command: "fixture-command", args: [], inputs: [], outputPaths: [], inputSnapshot: snapshot, resources: { cpuCores: 1 } }), references: [], createdAt: 1, updatedAt: 1 });
  return { root, caller, records, branches, operations, events, errors, service, makeService, committed, activeLeases, sources,
    backendAvailable: (value: boolean) => { backendAvailable = value; },
    readBranch: (fn: typeof beforeReadBranch) => { beforeReadBranch = fn; },
    createAck: (fn: typeof beforeCreateAck) => { beforeCreateAck = fn; },
    loseDelete: () => { loseDeleteReply = true; },
    inspect: (fn: typeof beforeInspect) => { beforeInspect = fn; },
    failKills: (value: boolean) => { failKills = value; },
    counters: () => ({ spawnCalls, resolveCalls, scanCalls, prepareCalls, recoveryCalls, captureCalls, admissionCalls }),
    admit: (fn: typeof beforeAdmit) => { beforeAdmit = fn; },
    recoverAdmission: (value: typeof admissionRecovery) => { admissionRecovery = value; },
    recoverPreparation: (value: typeof preparationRecovery) => { preparationRecovery = value; },
    setRoot: (value: string) => { currentRoot = value; },
    capture: (fn: typeof beforeCapture) => { beforeCapture = fn; },
    scan: (fn: typeof beforeScan) => { beforeScan = fn; }, prepare: (fn: typeof beforePrepare) => { beforePrepare = fn; }, spawn: (fn: typeof beforeSpawn) => { beforeSpawn = fn; },
    loseCreate: () => { loseCreateReply = true; }, loseSpawn: () => { loseSpawnReply = true; observed = "unknown"; },
    writerActive: (value: boolean) => { writerActiveOverride = value; },
    preparedRoot: (value: string) => { preparedRoot = value; },
    observe: (value: typeof observed) => { observed = value; },
  };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await turn(); }
  assert.fail("Expected the controlled owner transition to complete");
}

const intent = { requestId: "request", command: "fixture-command", args: ["first", "second"] };

describe("durable experiment admission with explicit Storage/backend fixtures", () => {
  it("returns its persisted receipt while capture is blocked and resolves duplicate receipts before live source access", async () => {
    const f = await fixture(); const entered = deferred(); const gate = deferred();
    f.scan(async (signal) => { entered.resolve(); await gate.promise; signal?.throwIfAborted(); });
    const accepted = await f.service.submit(f.caller, intent);
    assert.equal(accepted.spec, null); assert.equal(accepted.attempt.specId, null); assert.equal(accepted.attempt.state, "submitted");
    assert.ok(f.records.has(`experiment.attempt:${accepted.attempt.attemptId}`));
    await entered.promise; f.setRoot("/unavailable-new-root");
    const duplicate = await f.service.submit(f.caller, { ...intent, env: {} });
    assert.equal(duplicate.attempt.attemptId, accepted.attempt.attemptId); assert.equal(f.counters().resolveCalls, 1);
    await assert.rejects(f.service.submit(f.caller, { ...intent, args: ["second", "first"] }), /different experiment submission/);
    assert.equal(f.counters().resolveCalls, 1);
    const stop = await f.service.cancel(f.caller, accepted.attempt.attemptId);
    assert.equal(stop.state, "stopping"); assert.equal(stop.cancelRequested, true);
    assert.equal((await f.service.get(f.caller, accepted.attempt.attemptId)).attempt.state, "stopping");
    gate.resolve(); const settled = await f.service.wait(f.caller, accepted.attempt.attemptId, 1000);
    assert.equal(settled.attempt.state, "cancelled"); assert.equal(f.counters().spawnCalls, 0);
  });

  it("keeps the source lease until the native batch capture actually drains", async () => {
    const f = await fixture(); const entered = deferred(); const gate = deferred(); let captureSignal: AbortSignal | undefined;
    f.capture(async (signal) => { captureSignal = signal; entered.resolve(); await gate.promise; });
    const accepted = await f.service.submit(f.caller, intent); await entered.promise;
    await f.service.cancel(f.caller, accepted.attempt.attemptId);
    assert.equal(captureSignal?.aborted, true); assert.equal(f.activeLeases.size, 1);
    assert.equal((await f.service.get(f.caller, accepted.attempt.attemptId)).attempt.state, "stopping");
    gate.resolve(); assert.equal((await f.service.wait(f.caller, accepted.attempt.attemptId, 1000)).attempt.state, "cancelled");
    assert.equal(f.activeLeases.size, 0); assert.equal(f.counters().spawnCalls, 0);
  });

  it("does not tie an accepted attempt to the submitter's abort signal", async () => {
    const f = await fixture(); const controller = new AbortController(); const entered = deferred(); const gate = deferred();
    f.prepare(async (signal) => { entered.resolve(); await gate.promise; assert.equal(signal?.aborted, false); });
    const accepted = await f.service.submit(f.caller, { requestId: "independent", specId: "seed" }, controller.signal);
    controller.abort(); await entered.promise; gate.resolve(); await until(() => f.counters().spawnCalls === 1);
    await f.service.cancel(f.caller, accepted.attempt.attemptId);
    assert.equal((await f.service.wait(f.caller, accepted.attempt.attemptId, 1000)).attempt.state, "cancelled");
  });

  it("persists cancellation during uncooperative preparation and releases only after the worker drains", async () => {
    const f = await fixture(); const entered = deferred(); const gate = deferred(); let preparationSignal: AbortSignal | undefined;
    f.prepare(async (signal) => { preparationSignal = signal; entered.resolve(); await gate.promise; });
    const accepted = await f.service.submit(f.caller, { requestId: "prepare-stop", specId: "seed" }); await entered.promise;
    const stopped = await f.service.cancel(f.caller, accepted.attempt.attemptId);
    assert.equal(stopped.state, "stopping"); assert.equal(preparationSignal?.aborted, true); assert.equal(f.committed.size, 1);
    const other = await f.service.submit(f.caller, { requestId: "unrelated", command: "other" });
    assert.ok(other.attempt.attemptId); assert.equal((await f.service.get(f.caller, accepted.attempt.attemptId)).attempt.state, "stopping");
    gate.resolve(); assert.equal((await f.service.wait(f.caller, accepted.attempt.attemptId, 1000)).attempt.state, "cancelled");
    assert.equal(f.committed.size, 0); await f.service.cancel(f.caller, other.attempt.attemptId);
  });

  it("records and stops a late spawn reply without treating an early stop acknowledgement as termination", async () => {
    const f = await fixture(); const entered = deferred(); const gate = deferred();
    f.spawn(async () => { entered.resolve(); await gate.promise; f.observe("running"); });
    const accepted = await f.service.submit(f.caller, { requestId: "spawn-stop", specId: "seed" }); await entered.promise;
    await f.service.cancel(f.caller, accepted.attempt.attemptId); await until(() => f.events.includes("kill"));
    assert.equal((await f.service.get(f.caller, accepted.attempt.attemptId)).attempt.state, "stopping"); assert.equal(f.committed.size, 1);
    gate.resolve(); assert.equal((await f.service.wait(f.caller, accepted.attempt.attemptId, 1500)).attempt.state, "cancelled");
    assert.ok(f.events.filter((event) => event === "kill").length >= 2); assert.equal(f.counters().spawnCalls, 1); assert.equal(f.committed.size, 0);
  });

  it("recovers a committed capture after a lost reply without touching the live source again", async () => {
    const f = await fixture(); f.loseCreate(); const accepted = await f.service.submit(f.caller, intent);
    await until(() => f.errors.some((e) => e.message === "create response lost"));
    const scans = f.counters().scanCalls; f.setRoot("/no-longer-the-source");
    const restarted = f.makeService(); await restarted.ensureReconciled("ws"); await until(() => f.counters().spawnCalls === 1);
    assert.equal(f.counters().scanCalls, scans); assert.equal(f.counters().resolveCalls, 1);
    const detail = await restarted.get(f.caller, accepted.attempt.attemptId); assert.ok(detail.spec);
    await restarted.cancel(f.caller, accepted.attempt.attemptId);
  });

  it("hands a retired service's late spawn observation to the live service", async () => {
    const f = await fixture(); const entered = deferred(); const gate = deferred(); f.spawn(async () => { entered.resolve(); await gate.promise; });
    const accepted = await f.service.submit(f.caller, { requestId: "retire-spawn", specId: "seed" }); await entered.promise;
    f.service.detachObservers(); const restarted = f.makeService();
    const waiting = restarted.wait(f.caller, accepted.attempt.attemptId, 1000);
    f.observe("cancelled"); gate.resolve();
    assert.equal((await waiting).attempt.state, "cancelled"); assert.equal(f.counters().spawnCalls, 1); assert.equal(f.committed.size, 0);
  });

  it("requires an actual stopped backend state in addition to an idle writer", async () => {
    const f = await fixture(); f.writerActive(false);
    const accepted = await f.service.submit(f.caller, { requestId: "idle-writer", specId: "seed" });
    await until(() => f.events.includes("read")); await turn();
    assert.equal((await f.service.get(f.caller, accepted.attempt.attemptId)).attempt.state, "running"); assert.equal(f.committed.size, 1);
    await f.service.cancel(f.caller, accepted.attempt.attemptId);
    assert.equal((await f.service.wait(f.caller, accepted.attempt.attemptId, 1000)).attempt.state, "cancelled");
  });

  it("rejects preparation that returns a different input generation", async () => {
    const f = await fixture(); f.preparedRoot("sha256-replaced");
    const accepted = await f.service.submit(f.caller, { requestId: "wrong-root", specId: "seed" });
    const result = await f.service.wait(f.caller, accepted.attempt.attemptId, 1000);
    assert.equal(result.attempt.state, "failed"); assert.match(result.attempt.error ?? "", /frozen experiment snapshot/);
    await until(() => f.committed.size === 0); assert.equal(f.counters().spawnCalls, 0);
  });

  it("does not replay unknown spawn effects on response retry or service recreation", async () => {
    const f = await fixture(); f.loseSpawn(); const accepted = await f.service.submit(f.caller, { requestId: "unknown-spawn", specId: "seed" });
    await until(() => f.errors.some((e) => e.message === "spawn reply lost"));
    f.service.detachObservers(); const restarted = f.makeService();
    await restarted.submit(f.caller, { requestId: "unknown-spawn", specId: "seed" }); await restarted.ensureReconciled("ws"); await turn();
    assert.equal(f.counters().spawnCalls, 1); assert.equal(f.committed.size, 1);
    await restarted.cancel(f.caller, accepted.attempt.attemptId);
    assert.equal((await restarted.wait(f.caller, accepted.attempt.attemptId, 1500)).attempt.state, "cancelled");
  });

  it("holds unknown preparation effects until the original backend proves drain, without preparing again", async () => {
    const f = await fixture(); f.prepare(async () => { throw new Error("preparation connection lost"); });
    const accepted = await f.service.submit(f.caller, { requestId: "unknown-prepare", specId: "seed", machineId: "remote" });
    await until(() => f.errors.some((error) => error.message === "preparation connection lost"));
    f.backendAvailable(false);
    await f.service.ensureReconciled("ws");
    await until(() => [...f.records.values()].some((record) => record.recordType === "experiment.attempt" && record.payloadJson.includes("Original preparation backend is unavailable")));
    const offline = await f.service.get(f.caller, accepted.attempt.attemptId);
    assert.equal(offline.attempt.state, "submitted"); assert.equal(f.committed.size, 1);
    assert.equal(f.events.includes("released"), false);
    f.backendAvailable(true);
    await f.service.ensureReconciled("ws"); await f.service.get(f.caller, accepted.attempt.attemptId); await turn();
    assert.equal(f.counters().prepareCalls, 1, "unknown preparation must be observed before any active retry");
    const stopped = await f.service.cancel(f.caller, accepted.attempt.attemptId); assert.equal(stopped.state, "stopping");
    await until(() => f.counters().recoveryCalls > 0); assert.equal(f.committed.size, 1);
    const preparations = f.counters().prepareCalls;
    f.recoverPreparation("drained"); await f.service.ensureReconciled("ws");
    assert.equal((await f.service.wait(f.caller, accepted.attempt.attemptId, 1000)).attempt.state, "cancelled");
    assert.equal(f.committed.size, 0); assert.equal(f.counters().prepareCalls, preparations); assert.equal(f.counters().spawnCalls, 0);
  });

  it("does not treat a missing local admission mirror as proof that a remote allocation never happened", async () => {
    const f = await fixture(); f.admit(async () => { throw new Error("remote admission response lost"); });
    const accepted = await f.service.submit(f.caller, { requestId: "unknown-admission", specId: "seed" });
    await until(() => f.errors.some((error) => error.message === "remote admission response lost"));
    await f.service.get(f.caller, accepted.attempt.attemptId); await turn(); assert.equal(f.counters().admissionCalls, 1);
    await f.service.cancel(f.caller, accepted.attempt.attemptId); await turn();
    assert.equal((await f.service.get(f.caller, accepted.attempt.attemptId)).attempt.state, "stopping");
    f.recoverAdmission("confirmed"); await f.service.ensureReconciled("ws");
    assert.equal((await f.service.wait(f.caller, accepted.attempt.attemptId, 1000)).attempt.state, "cancelled");
    assert.ok(f.events.includes("released")); assert.equal(f.counters().admissionCalls, 1); assert.equal(f.counters().spawnCalls, 0);
  });

  it("does not replace a committed input snapshot whose branch is missing", async () => {
    const f = await fixture(); f.loseCreate(); const accepted = await f.service.submit(f.caller, intent);
    await until(() => f.errors.some((error) => error.message === "create response lost"));
    f.branches.clear(); const captures = f.counters().captureCalls;
    await f.service.ensureReconciled("ws"); await until(() => f.errors.some((error) => error.message === "branch missing"));
    assert.equal(f.counters().captureCalls, captures); assert.equal(f.counters().spawnCalls, 0);
    assert.match((await f.service.get(f.caller, accepted.attempt.attemptId)).attempt.error ?? "", /branch missing/);
    await f.service.cancel(f.caller, accepted.attempt.attemptId);
  });

  it("rejects invalid input metadata before admission or capture", async () => {
    const f = await fixture();
    await assert.rejects(f.service.submit(f.caller, { ...intent, inputs: [{ path: "../escape" }] }), /inside the workspace/);
    assert.equal([...f.records.values()].filter((record) => record.recordType === "experiment.attempt").length, 0);
    assert.equal(f.counters().scanCalls, 0); assert.equal(f.counters().spawnCalls, 0);
  });

  it("reports missing frozen specs explicitly while leaving unrelated control usable", async () => {
    const f = await fixture(); const gate = deferred(); const entered = deferred(); f.prepare(async () => { entered.resolve(); await gate.promise; });
    const accepted = await f.service.submit(f.caller, { requestId: "broken", specId: "seed" }); await entered.promise;
    f.records.delete("experiment.spec:seed");
    await assert.rejects(f.service.get(f.caller, accepted.attempt.attemptId), /spec is missing/);
    const stopped = await f.service.cancel(f.caller, accepted.attempt.attemptId); assert.equal(stopped.cancelRequested, true); gate.resolve();
    assert.equal((await f.service.wait(f.caller, accepted.attempt.attemptId, 1000)).attempt.state, "cancelled");
  });

  it("rejects corrupt accepted records while still controlling an unrelated valid attempt", async () => {
    const f = await fixture(); const bad = await f.service.submit(f.caller, { requestId: "bad", specId: "seed" });
    await f.service.cancel(f.caller, bad.attempt.attemptId);
    await f.service.wait(f.caller, bad.attempt.attemptId, 1000);
    const record = f.records.get(`experiment.attempt:${bad.attempt.attemptId}`)!;
    const original = JSON.parse(record.payloadJson) as Record<string, unknown>;
    for (const broken of [{ ...original, cancelRequested: undefined }, { ...original, backend: undefined }]) {
      record.payloadJson = JSON.stringify(broken);
      await assert.rejects(f.service.get(f.caller, bad.attempt.attemptId), /attempt is unreadable/);
      await assert.rejects(f.service.list(f.caller, {}), /attempt is unreadable/);
    }
    record.payloadJson = JSON.stringify(original); record.state = "invented-terminal";
    await assert.rejects(f.service.get(f.caller, bad.attempt.attemptId), /attempt is unreadable/);
    const valid = await f.service.submit(f.caller, { requestId: "valid", specId: "seed" });
    await f.service.cancel(f.caller, valid.attempt.attemptId);
    assert.equal((await f.service.wait(f.caller, valid.attempt.attemptId, 1000)).attempt.state, "cancelled");
  });

  it("reuses an explicit receipt across an authorized new Run and execution context without replacing attribution", async () => {
    const f = await fixture(); const entered = deferred(); const gate = deferred();
    f.scan(async () => { entered.resolve(); await gate.promise; });
    const first = await f.service.submit(f.caller, intent); await entered.promise;
    f.setRoot("/missing-new-source");
    const resumed = { ...f.caller, runId: "new-run", executionWorkspaceId: "new-execution", allowedThreadIds: ["thread"] };
    const retry = await f.service.submit(resumed, intent);
    assert.equal(retry.attempt.attemptId, first.attempt.attemptId); assert.equal(retry.attempt.runId, "run");
    assert.equal(f.counters().resolveCalls, 1);
    await f.service.cancel(resumed, first.attempt.attemptId); gate.resolve();
    assert.equal((await f.service.wait(resumed, first.attempt.attemptId, 1000)).attempt.state, "cancelled");
  });

  it("releases an unpublished candidate after cancellation and recovers a lost delete acknowledgement", async () => {
    const f = await fixture(); const entered = deferred(); const gate = deferred();
    f.readBranch(async () => { entered.resolve(); await gate.promise; });
    const accepted = await f.service.submit(f.caller, intent); await entered.promise;
    assert.equal(f.branches.size, 1); f.loseDelete();
    await f.service.cancel(f.caller, accepted.attempt.attemptId); gate.resolve();
    await until(() => f.errors.some((error) => error.message === "delete response lost"));
    const restarted = f.makeService();
    const result = await restarted.wait(f.caller, accepted.attempt.attemptId, 1000);
    assert.equal(result.attempt.state, "cancelled"); assert.equal(result.attempt.specId, null);
    assert.equal(f.branches.size, 0); assert.equal(f.counters().spawnCalls, 0);
  });

  it("keeps the original branch-create acknowledgement while accepting cancellation immediately", async () => {
    const f = await fixture(); const entered = deferred(); const gate = deferred();
    f.createAck(async (signal) => { assert.equal(signal, undefined); entered.resolve(); await gate.promise; });
    const accepted = await f.service.submit(f.caller, intent); await entered.promise;
    const stopped = await f.service.cancel(f.caller, accepted.attempt.attemptId);
    assert.equal(stopped.state, "stopping"); assert.equal(f.branches.size, 1); assert.equal(f.activeLeases.size, 1);
    gate.resolve();
    const result = await f.service.wait(f.caller, accepted.attempt.attemptId, 1000);
    assert.equal(result.attempt.state, "cancelled"); assert.equal(f.branches.size, 0); assert.equal(f.activeLeases.size, 0);
    assert.equal(f.counters().spawnCalls, 0);
  });

  it("transfers exactly one candidate branch to a reused immutable spec", async () => {
    const f = await fixture();
    const first = await f.service.submit(f.caller, { ...intent, requestId: "first-candidate" });
    await until(() => f.counters().spawnCalls === 1);
    const second = await f.service.submit({ ...f.caller, runId: "later-run" }, { ...intent, requestId: "duplicate-candidate" });
    await until(() => f.counters().spawnCalls === 2);
    const a = await f.service.get(f.caller, first.attempt.attemptId); const b = await f.service.get(f.caller, second.attempt.attemptId);
    assert.equal(a.attempt.specId, b.attempt.specId); assert.equal(f.branches.size, 1);
    await f.service.cancel(f.caller, first.attempt.attemptId); await f.service.cancel(f.caller, second.attempt.attemptId);
    await f.service.wait(f.caller, first.attempt.attemptId, 1000); await f.service.wait(f.caller, second.attempt.attemptId, 1000);
    assert.equal(f.branches.size, 1, "the published spec remains reusable");
  });

  it("keeps identical inline specs within each original creator's read boundary", async () => {
    const f = await fixture();
    const firstCaller = { ...f.caller, threadId: "first-thread", allowedThreadIds: ["first-thread"] };
    const secondCaller = { ...f.caller, threadId: "second-thread", allowedThreadIds: ["second-thread"] };
    const first = await f.service.submit(firstCaller, { ...intent, requestId: "first-owner" });
    await until(() => f.counters().spawnCalls === 1);
    const second = await f.service.submit(secondCaller, { ...intent, requestId: "second-owner" });
    await until(() => f.counters().spawnCalls === 2);
    const a = await f.service.get(firstCaller, first.attempt.attemptId);
    const b = await f.service.get(secondCaller, second.attempt.attemptId);
    assert.ok(a.spec); assert.ok(b.spec); assert.notEqual(a.spec.specId, b.spec.specId);
    assert.equal(f.branches.size, 2);
    await assert.rejects(f.service.get(firstCaller, second.attempt.attemptId), /Unknown experiment attempt/);
    await assert.rejects(f.service.submit(secondCaller, { requestId: "forbidden-spec", specId: a.spec.specId }), /Unknown experiment spec/);
    await f.service.cancel(firstCaller, first.attempt.attemptId); await f.service.cancel(secondCaller, second.attempt.attemptId);
    await f.service.wait(firstCaller, first.attempt.attemptId, 1000); await f.service.wait(secondCaller, second.attempt.attemptId, 1000);
  });

  it("authorizes source and retry metadata with the actual caller before admission", async () => {
    const f = await fixture(); const caller = { ...f.caller, allowedThreadIds: ["thread"] };
    const source = await f.sources.register("ws", { kind: "dataset", path: "input.txt" }, { sessionId: "foreign-session", threadId: "foreign-thread", runId: "foreign-run", workspaceScope: [] });
    await assert.rejects(f.service.submit(caller, { ...intent, inputs: [{ sourceId: source.sourceId }] }), /outside the caller/);
    assert.equal([...f.records.values()].filter((record) => record.recordType === "experiment.attempt").length, 0);
    const foreign = await f.service.submit({ ...f.caller, threadId: "foreign-thread" }, { requestId: "foreign-attempt", specId: "seed" });
    await f.service.cancel(f.caller, foreign.attempt.attemptId); await f.service.wait(f.caller, foreign.attempt.attemptId, 1000);
    const priorAttempts = [...f.records.values()].filter((record) => record.recordType === "experiment.attempt").length;
    await assert.rejects(f.service.submit(caller, { ...intent, retryOfAttemptId: foreign.attempt.attemptId }), /Unknown experiment attempt/);
    assert.equal([...f.records.values()].filter((record) => record.recordType === "experiment.attempt").length, priorAttempts);
    assert.equal(f.counters().spawnCalls, 0);
  });

  it("rejects invalid inline resources before admission and fails invalid frozen resources before any reservation", async () => {
    const f = await fixture();
    await assert.rejects(f.service.submit(f.caller, { ...intent, resources: { cpuCores: 1, memoryMb: -1 } }), /cannot be negative/);
    assert.equal([...f.records.values()].filter((record) => record.recordType === "experiment.attempt").length, 0);
    const spec = f.records.get("experiment.spec:seed")!;
    spec.payloadJson = JSON.stringify({ ...JSON.parse(spec.payloadJson), resources: { cpuCores: 1, memoryMb: -1 } });
    const accepted = await f.service.submit(f.caller, { requestId: "invalid-frozen-resources", specId: "seed" });
    assert.equal((await f.service.wait(f.caller, accepted.attempt.attemptId, 1000)).attempt.state, "failed");
    assert.equal(f.counters().admissionCalls, 0); assert.equal(f.counters().spawnCalls, 0); assert.equal(f.committed.size, 0);
    assert.equal(JSON.parse(f.records.get(`experiment.attempt:${accepted.attempt.attemptId}`)!.payloadJson).admissionStarted, undefined);
  });

  it("keeps durable cancellation authoritative when recovery inspect returns after a control outage", async () => {
    const f = await fixture(); f.writerActive(false);
    const accepted = await f.service.submit(f.caller, { requestId: "recover-cancel", specId: "seed" });
    await until(() => f.counters().spawnCalls === 1 && f.events.includes("read")); f.service.detachObservers();
    const entered = deferred(); const gate = deferred(); f.inspect(async () => { entered.resolve(); await gate.promise; });
    const restarted = f.makeService(); await restarted.ensureReconciled("ws"); await entered.promise;
    f.failKills(true); await restarted.cancel(f.caller, accepted.attempt.attemptId);
    await until(() => f.errors.some((error) => error.message === "temporary control outage"));
    f.failKills(false); gate.resolve();
    const result = await restarted.wait(f.caller, accepted.attempt.attemptId, 1000);
    assert.equal(result.timedOut, false); assert.equal(result.attempt.state, "cancelled");
    assert.ok(f.events.filter((event) => event === "kill").length >= 2); assert.equal(f.counters().spawnCalls, 1);
  });

  it("stops only its admitted thread set and admits future intents after the stop drains", async () => {
    const f = await fixture(); const entered = deferred(); const gate = deferred(); f.prepare(async () => { entered.resolve(); await gate.promise; });
    const first = await f.service.submit(f.caller, { requestId: "old", specId: "seed" }); await entered.promise;
    const stopping = f.service.stopForThreads("ws", [f.caller.threadId!]);
    await until(() => JSON.parse(f.records.get(`experiment.attempt:${first.attempt.attemptId}`)!.payloadJson).cancelRequested === true);
    await assert.rejects(f.service.submit(f.caller, { requestId: "during-stop", specId: "seed" }), /stopping/);
    gate.resolve(); await stopping;
    const next = await f.service.submit(f.caller, { requestId: "new", specId: "seed" }); assert.notEqual(next.attempt.attemptId, first.attempt.attemptId);
    await f.service.cancel(f.caller, next.attempt.attemptId);
  });
});
