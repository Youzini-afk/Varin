import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import type { KernelClient, KernelScopedClient } from "../kernel/kernel-client.js";
import type { KernelRecordResult } from "../kernel/protocol.generated.js";
import { createExperimentService, type ExperimentCaller } from "./experiments.js";
import type { ExperimentBackend, ResolvedExperimentBackend } from "./experiment-backend.js";
import type { ResourceService } from "./resources.js";
import { piResearchCaller } from './research-caller.fixture.js';
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
  const blobs = new Map<string, Buffer>();
  const operations = new Map<string, Record<string, unknown>>();
  const branches = new Map<string, { root: string; paths: string[] }>();
  const events: string[] = [];
  const errors: Error[] = [];
  const caller: ExperimentCaller = piResearchCaller({ workspaceId: "ws", executionWorkspaceId: "exec", sessionId: "session", threadId: "thread", runId: "run", rootSessionId: "root", workspaceScope: [] });
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
  let releasedPreparations = 0;
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
    async experimentArtifacts(input: { workspaceId: string; attemptId: string; after?: string; pageSize?: number }) {
      const all = [...records.values()].filter(record => record.workspaceId === input.workspaceId && record.recordType === "experiment.artifact" && JSON.parse(record.payloadJson).attemptId === input.attemptId && JSON.parse(record.payloadJson).internalLogChunk !== true && record.recordId > (input.after ?? "")).sort((a,b) => a.recordId.localeCompare(b.recordId));
      const size = input.pageSize ?? 128, page = all.slice(0,size);
      return { records: structuredClone(page), nextCursor: all.length > size ? page.at(-1)!.recordId : null };
    },
    async experimentLogChunks(input: { workspaceId: string; attemptId: string; stream: string; offset: number; endOffset: number }) {
      const chunks = [...records.values()].filter(record => {
        const p = JSON.parse(record.payloadJson);
        return record.workspaceId === input.workspaceId && record.recordType === "experiment.artifact" && p.internalLogChunk === true && p.attemptId === input.attemptId && p.stream === input.stream && p.streamOffset + p.byteLength > input.offset && p.streamOffset < input.endOffset;
      }).sort((a,b) => JSON.parse(a.payloadJson).streamOffset - JSON.parse(b.payloadJson).streamOffset);
      return { records: structuredClone(chunks), nextOffset: null };
    },
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
    async putBlob(bytes: Buffer) { const hash = `sha256-${createHash("sha256").update(bytes).digest("hex")}`; blobs.set(hash, Buffer.from(bytes)); return { hash, ownerId: `fixture-blob-owner-${++sequence}` }; },
    async getBlob(hash: string, _source: unknown, options: { offset?: number; length?: number; signal?: AbortSignal } = {}) {
      options.signal?.throwIfAborted(); const bytes = blobs.get(hash); if (!bytes) throw new Error("Original blob unavailable");
      const offset = options.offset ?? 0, end = Math.min(bytes.length, offset + (options.length ?? bytes.length));
      return { bytesBase64: bytes.subarray(offset,end).toString("base64"), nextOffset: end, eof: end >= bytes.length };
    },
    async releaseBlob() {},
  } as unknown as KernelScopedClient;
  const client = { start: async () => ({}), issueGrant: async (grant:object) => grant, retireGrant: async () => ({}), retireOperationGrants: async (operationId:string) => {events.push(`authority-retired:${operationId}`);return {};}, scoped: () => scoped } as unknown as KernelClient;
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
    async prepare({ signal, input }) { prepareCalls++; await beforePrepare(signal); return { site: this.site, cwd: "", inputRoot: preparedRoot ?? input.root, releaseAuthority:async()=>{releasedPreparations++;} }; },
  };
  const sources = createSourceService({ client });
  const makeService = (sourceAuthority?: import("../kernel/research-source.js").ResearchSourceAuthority, kernelClient = client) => {
    const service = createExperimentService({ ...(sourceAuthority ? {sourceAuthority}:{}), client: kernelClient, resources, sources, resolveWorkspaceRoot: async () => { resolveCalls++; return currentRoot; }, resolveBackend: () => backendAvailable ? resolved : null, onError: (error) => errors.push(error) });
    cleanup.push(() => service.dispose()); return service;
  };
  const service = makeService();
  const snapshot = { schemaVersion: 2, source: {kind:"physical-capture"}, branchId: "seed-branch", root: "sha256-seed", sourceRoot: root, workspaceId: "ws", executionWorkspaceId: "exec", captureScopes: [], capturedPathCount: 0, inventoryFingerprint: "seed", captureSemantics: { excludedDirectories: [".git", ".varin"], gitignore: "not-applied", ignoredFilesIncluded: true } };
  records.set("experiment.spec:seed", { recordId: "experiment.spec:seed", workspaceId: "ws", recordType: "experiment.spec", state: "active", recordRevision: 1, payloadJson: JSON.stringify({ researchOwner: {runtime:"pi",rootSessionId:"root",sessionId:"session"},executionWorkspaceId:"exec", id: "seed", command: "fixture-command", args: [], inputs: [], outputPaths: [], inputSnapshot: snapshot, resources: { cpuCores: 1 } }), references: [], createdAt: 1, updatedAt: 1 });
  return { root, caller, client, resources, scoped, backend, records, branches, operations, events, errors, service, makeService, committed, activeLeases, sources,
    backendAvailable: (value: boolean) => { backendAvailable = value; },
    readBranch: (fn: typeof beforeReadBranch) => { beforeReadBranch = fn; },
    createAck: (fn: typeof beforeCreateAck) => { beforeCreateAck = fn; },
    loseDelete: () => { loseDeleteReply = true; },
    inspect: (fn: typeof beforeInspect) => { beforeInspect = fn; },
    failKills: (value: boolean) => { failKills = value; },
    counters: () => ({ spawnCalls, releasedPreparations, resolveCalls, scanCalls, prepareCalls, recoveryCalls, captureCalls, admissionCalls }),
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
  await vi.waitFor(() => assert.ok(check(), "Expected the controlled owner transition to complete"), { timeout: 5000, interval: 10 });
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
    assert.ok(f.events.filter((event) => event === "kill").length >= 2); assert.equal(f.counters().spawnCalls, 1); await until(() => f.committed.size === 0);
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
    assert.equal((await waiting).attempt.state, "cancelled"); assert.equal(f.counters().spawnCalls, 1); await until(() => f.committed.size === 0);
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
    assert.equal(f.counters().releasedPreparations,1);
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
    const resumed = piResearchCaller({ ...f.caller, runId: "new-run", executionWorkspaceId: "new-execution", allowedThreadIds: ["thread"] });
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
    const second = await f.service.submit(piResearchCaller({ ...f.caller, runId: "later-run" }), { ...intent, requestId: "duplicate-candidate" });
    await until(() => f.counters().spawnCalls === 2);
    const a = await f.service.get(f.caller, first.attempt.attemptId); const b = await f.service.get(f.caller, second.attempt.attemptId);
    assert.equal(a.attempt.specId, b.attempt.specId); assert.equal(f.branches.size, 1);
    await f.service.cancel(f.caller, first.attempt.attemptId); await f.service.cancel(f.caller, second.attempt.attemptId);
    await f.service.wait(f.caller, first.attempt.attemptId, 1000); await f.service.wait(f.caller, second.attempt.attemptId, 1000);
    assert.equal(f.branches.size, 1, "the published spec remains reusable");
  });

  it("keeps identical inline specs within each original creator's read boundary", async () => {
    const f = await fixture();
    const firstCaller = piResearchCaller({ ...f.caller, threadId: "first-thread", allowedThreadIds: ["first-thread"] });
    const secondCaller = piResearchCaller({ ...f.caller, threadId: "second-thread", allowedThreadIds: ["second-thread"] });
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
    const f = await fixture(); const caller = piResearchCaller({ ...f.caller, allowedThreadIds: ["thread"] });
    const source = await f.sources.register("ws", { kind: "dataset", path: "input.txt" }, piResearchCaller({workspaceId:"ws",executionWorkspaceId:"exec",sessionId: "foreign-session", threadId: "foreign-thread", runId: "foreign-run", workspaceScope: [] }));
    await assert.rejects(f.service.submit(caller, { ...intent, inputs: [{ sourceId: source.sourceId }] }), /outside the caller/);
    assert.equal([...f.records.values()].filter((record) => record.recordType === "experiment.attempt").length, 0);
    const foreignCaller = piResearchCaller({...f.caller,threadId:"foreign-thread"});
    const foreign = await f.service.submit(foreignCaller, { requestId: "foreign-attempt", specId: "seed" });
    await f.service.cancel(foreignCaller, foreign.attempt.attemptId); await f.service.wait(foreignCaller, foreign.attempt.attemptId, 1000);
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

it('installed ordinary research tools hand original model and policy invocations to the real experiment owner and recover a lost bind ACK', async () => {
  const { createRequire } = await import('node:module');
  const { fileURLToPath } = await import('node:url');
  const { ApplicationExtensionRuntime } = await import('@varin/extension-host');
  const { parseVarinExtensionManifest } = await import('@varin/extension-contract');
  const { retainExtensionTool } = await import('../kernel/extension-tool-owner.js');
  const { ToolBridge } = await import('../kernel/tool-bridge.js');
  const { createResearchRuntime, RESEARCH_CAPABILITY } = await import('../kernel/research-runtime.js');
  const { prepareExperimentInput } = await import('./experiment-workspace.js');
  type Pending = import('../kernel/protocol.generated.js').HostJobPending;
  type Call = import('../kernel/protocol.generated.js').HostToolCall;
  const f=await fixture();
  const source={workspace_id:'ws',execution_workspace_id:'exec',mode:'live_root' as const,branch_id:null,revision:null,live_root:{hostId:'fixture-host',canonicalRoot:f.root,rootId:'source-root'}};
  const sourceAuthority:import("../kernel/research-source.js").ResearchSourceAuthority={
    async admit(_caller,cwd){return {kind:'physical',selection:source,canonicalRoot:f.root,cwd:cwd??''};},
    async capture(caller,admitted,options){assert.equal(admitted.kind,'physical');return prepareExperimentInput(f.client,caller,f.root,options);},
    async release(){}, async reconcileUnaccepted(){return true;},
  };
  let experiments=f.makeService(sourceAuthority);
  // Explicit management metadata seam: actual Catalog transactions are exercised in
  // host_job_review.rs. This is the real installed SDK/ToolBridge/domain-service chain,
  // with controlled Storage/backend ports, not a substitute claim of Host Unix IPC.
  const ops=new Map<string,{call:Call;owner:import('../kernel/protocol.generated.js').ExecutorOwner;link?:Pending;accepted?:unknown}>();
  let activeCall:Call|undefined;
  let loseBindAck=false;
  let bound=0;
  const hints=new Set<()=>void>();
  const notify=()=>{for(const hint of hints)hint();};
  const kernel={agentRuntimeRequest:async(method:string,params:Record<string,unknown>)=>{
    if (method === "runtime.followup.research") return { works: [], nextCursor: null };
    if(method==='runtime.run.inspect')return {id:'run',thread_id:'thread',branch_id:'branch',cancel_requested:false,state:'executing'};
    if(method==='runtime.launch.inspect')return {run_id:'run',selection:{source}};
    if(method==='runtime.research.scopes')return [{rootThreadId:'thread',threadId:'thread',branchId:'branch',sourceRunId:'run',source,readThreadIds:['thread'],controlThreadIds:['thread'],canSubmit:true}];
    if(method==='runtime.operation.inspect'){
      const saved=ops.get(String(params.operationId))!;assert.ok(saved);
      return {id:saved.call.operationId,run_id:'run',phase:saved.link?.phase??'running',cancel_requested:saved.link?.cancelRequested??false,execution_owner:saved.owner,lifetime:'thread',
        intent:{kind:'tool',origin:saved.call.origin,call:{call_id:saved.call.callId,name:saved.call.name,schema_version:saved.call.schemaVersion,arguments:saved.call.arguments},contract:{completion:'job',lifetime:'thread'}},host_job:saved.link?{binding:saved.link.binding,acceptanceRef:saved.link.accepted?'stored':null}:undefined};
    }
    if(method==='runtime.host_job.begin'){
      const binding=params.binding as Pending['binding'],saved=ops.get(binding.operationId)!;
      const original=[...ops.values()].find(op=>op.link?.binding.subjectId===binding.subjectId);
      if(original)return structuredClone(original.link);
      saved.link={binding,runId:'run',accepted:false,cancelRequested:false,phase:'running',executorStopped:false,origin:{kind:'tool',origin:saved.call.origin,call_id:saved.call.callId,tool_name:saved.call.name,schema_version:saved.call.schemaVersion}};return structuredClone(saved.link);
    }
    if(method==='runtime.host_job.accept'){
      const saved=ops.get((params.binding as Pending['binding']).operationId)!;assert.deepEqual(saved.link!.binding,params.binding);
      if(saved.accepted)assert.deepEqual(saved.accepted,params.content);else{saved.accepted=structuredClone(params.content);saved.link!.accepted=true;bound++;}
      notify();if(loseBindAck){loseBindAck=false;throw new Error('Original bind ACK lost');}return structuredClone(saved.link);
    }
    if(method==='runtime.host_job.pending')return [...ops.values()].flatMap(op=>op.link&&!op.link.executorStopped?[structuredClone(op.link)]:[]);
    if(method==='runtime.host_job.terminal'){
      const saved=ops.get((params.binding as Pending['binding']).operationId)!;assert.equal(params.executorStopped,true);saved.link!.phase='terminal';saved.link!.executorStopped=true;notify();return structuredClone(saved.link);
    }
    throw new Error(`Unexpected research management seam ${method}`);
  }} as unknown as KernelClient;
  const runtime={
    run:async()=>({id:'run',thread_id:'thread',branch_id:'branch'}),
    launch:async()=>({run_id:'run',selection:{source}}),
    onEvent:(fn:()=>void)=>{hints.add(fn);return()=>hints.delete(fn);},onReady:()=>()=>{},
    cancelOperation:async(id:string)=>{ops.get(id)!.link!.cancelRequested=true;notify();},reconcileObservations:async()=>[],
  } as unknown as import('../kernel/agent-runtime-client.js').AgentRuntimeClient;
  let research=createResearchRuntime({kernel,runtime,experiments,sources:f.sources,resources:f.resources,onError:error=>f.errors.push(error)});
  cleanup.push(()=>research.dispose());
  research.start();
  const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../../..');
  const installed=path.join(f.root,'installed');await fs.mkdir(installed);
  const example=path.join(repo,'examples/extensions/research-tools');
  for(const file of ['package.json','varin.extension.json'])await fs.copyFile(path.join(example,file),path.join(installed,file));
  const manifest=parseVarinExtensionManifest(JSON.parse(await fs.readFile(path.join(installed,'varin.extension.json'),'utf8')));
  const {build}=createRequire(path.join(repo,'packages/extension-builtins/package.json'))('esbuild');
  await build({entryPoints:[path.join(example,'host.ts')],bundle:true,platform:'node',format:'cjs',outfile:path.join(installed,'host.cjs'),alias:{'@varin/extension-sdk':path.join(repo,'packages/extension-sdk/dist/index.js')}});
  const extension=await ApplicationExtensionRuntime.create({dataDir:path.join(f.root,'extension-state'),varinVersion:'0.9.25',brokerScript:path.join(repo,'packages/extension-host/broker/broker-child.mjs')});
  cleanup.push(()=>extension.stop());
  extension.capabilities.register(RESEARCH_CAPABILITY,research.capability);await extension.start();
  await extension.installOrStage({source:{kind:'local',display:'Research tools',specifier:installed},expectedRevision:(await extension.catalog.snapshot()).revision});
  await extension.reviewCapabilities({extensionId:manifest.id,expectedRevision:(await extension.catalog.snapshot()).revision,decisions:[{capability:RESEARCH_CAPABILITY,realm:'host',granted:true}]});
  await extension.setEnabled(manifest.id,true,(await extension.catalog.snapshot()).revision);
  const descriptor=manifest.provides!.services!.find(s=>s.id==='example.research.submit')!;
  const selected=await extension.prepareService({serviceId:descriptor.id,version:descriptor.version,method:'execute',args:[],routing:{sessionId:'thread'}});
  const retained=await retainExtensionTool({runtime:extension,kernel,currentPolicy:async()=>({mode:'normal',rules:[{tool:descriptor.tool!.name,decision:'allow'}]})},selected);
  const frames:import('../kernel/tool-bridge.js').PrivateToolFrame[]=[];
  const bridge=new ToolBridge(()=> 'epoch',async frame=>{frames.push(frame);if(frame.kind==='host-tool-receipt')queueMicrotask(()=>bridge.consume({v:1,kind:'host-tool-receipt-ack',kernelEpoch:'epoch',id:frame.id,accepted:true}));},()=>assert.fail('Tool transport failed'));
  const waitFrame=async(id:string)=>{await vi.waitFor(()=>assert.ok(frames.some(frame=>frame.kind==='host-tool-response'&&frame.id===id)),{timeout:4000,interval:10});};
  const live=bridge.register('run',retained.lease);
  bridge.consume({v:1,kind:'host-tool-binding-retain',kernelEpoch:'epoch',runId:'run',ownerId:live.ownerId,holderId:'holder'});
  for(const policy of [false,true]){
    const tag=policy?'policy':'model';
    const origin=policy?{kind:'policy_action' as const,action_id:'action',node_id:'node'}:{kind:'model_step' as const,request_id:'request'};
    activeCall={runId:'run',operationId:policy?'action:node:node':'request:tool:call',origin,callId:policy?'node':'call',name:descriptor.tool!.name,schemaVersion:retained.binding.tool.version,arguments:{requestId:tag,command:'fixture-command'}};
    const owner={kind:'external' as const,identity:retained.binding.providerKey,epoch:live.ownerId};ops.set(activeCall.operationId,{call:activeCall,owner});
    const send=(phase:string)=>bridge.consume({v:1,kind:'host-tool-request',id:`${tag}:${phase}`,kernelEpoch:'epoch',phase,binding:{ownerId:live.ownerId,reference:retained.binding.providerKey,generation:retained.generation,holderId:'holder'},call:activeCall});
    send('authorize');await waitFrame(`${tag}:authorize`);
    loseBindAck=policy;send('execute');await waitFrame(`${tag}:execute`);
    const frame=frames.find(frame=>frame.kind==='host-tool-response'&&frame.id===`${tag}:execute`)!;
    assert.equal(frame.kind,'host-tool-response');if(frame.kind!=='host-tool-response')throw new Error('response missing');
    assert.equal(frame.completion?.kind,policy?'result':'job_accepted');assert.equal(frame.executor_stopped,false);
    const saved=ops.get(activeCall.operationId)!;assert.ok(saved.link!.accepted);
    const domain=await experiments.nativeReceipt('ws',saved.link!.binding.subjectId);assert.ok(domain);assert.deepEqual(domain.owner.actor,{kind:'tool',origin,callId:activeCall.callId,toolName:activeCall.name,schemaVersion:activeCall.schemaVersion});assert.deepEqual(domain.accepted,saved.accepted);
  }
  const before=f.counters().spawnCalls;await research.reconcile();assert.equal(bound,2);assert.equal(f.counters().resolveCalls,0,'native source never consults cwd/Pi root fallback');
  await vi.waitFor(()=>assert.equal(f.counters().spawnCalls,2,JSON.stringify({errors:f.errors.map(e=>e.message),events:f.events})),{timeout:4000,interval:10});assert.ok(before<=2);
  // Detach both observers while the domain backend still runs. The next real service
  // instance reconnects those original attempts; it may never dispatch replacement work.
  await research.dispose();experiments.detachObservers();experiments=f.makeService(sourceAuthority);
  research=createResearchRuntime({kernel,runtime,experiments,sources:f.sources,resources:f.resources,onError:error=>f.errors.push(error)});
  research.start();
  await research.reconcile();
  const selection={runtime:'agent' as const,threadId:'thread',branchId:'branch',sourceRunId:'run'};
  const rows=await research.user.list(selection);assert.equal(rows.attempts.length,2);assert.ok(rows.attempts.every(attempt=>attempt.permissions?.control));
  const sibling:ExperimentCaller={workspaceId:'ws',executionWorkspaceId:'exec',threadId:'sibling',runId:'sibling-run',owner:{runtime:'agent',actor:{kind:'reader'},rootThreadId:'thread',threadId:'sibling',branchId:'sibling-branch',runId:'sibling-run',source},access:{kind:'family',readThreadIds:['thread','sibling'],controlThreadIds:['sibling']}};
  const visible=await experiments.get(sibling,rows.attempts[0]!.attemptId);assert.equal(visible.attempt.permissions!.control,false);
  await assert.rejects(experiments.cancel(sibling,rows.attempts[0]!.attemptId),/not authorized|not allowed|not accessible|denied|control/i);
  if(sibling.owner.runtime!=='agent')throw new Error('native fixture identity');
  assert.equal((await experiments.list({...sibling,owner:{...sibling.owner,rootThreadId:'other'}},{})).attempts.length,0);
  for(const attempt of rows.attempts)await research.user.cancel(selection,attempt.attemptId);
  await research.reconcile();assert.ok([...ops.values()].every(op=>op.link!.cancelRequested));
  await vi.waitFor(()=>{assert.ok([...f.records.values()].filter(record=>record.recordType==='experiment.attempt').every(record=>record.state==='cancelled'),JSON.stringify({errors:f.errors.map(e=>e.message),events:f.events}));assert.ok([...ops.values()].every(op=>op.link!.executorStopped),'original attempt/runtime subscriptions must reconcile stopped Jobs without manual polling');},{timeout:4000,interval:10});
  assert.ok([...ops.values()].every(op=>op.link!.executorStopped));assert.equal(f.counters().spawnCalls,2);
  assert.equal(f.committed.size,0);
  await vi.waitFor(()=>assert.ok([...ops.keys()].every(id=>f.events.includes(`authority-retired:${id}`))),{timeout:4000,interval:10});
});


it("publishes drained execution before slow collection and preserves its reader through reentrant observer replacement", async () => {
  const f = await fixture();
  // This case installs only the native owner below. Retire the unused fixture
  // service so its resumer cannot survive the later simulated process restart.
  f.service.detachObservers();
  const { prepareExperimentInput } = await import("./experiment-workspace.js");
  const source = {
    workspace_id: "ws", execution_workspace_id: "exec", mode: "live_root" as const,
    branch_id: null, revision: null,
    live_root: { hostId: "fixture-host", canonicalRoot: f.root, rootId: "source-root" },
  };
  const caller: ExperimentCaller = {
    workspaceId: "ws", executionWorkspaceId: "exec", threadId: "thread", runId: "run", workspaceScope: [],
    owner: { runtime: "agent", actor: { kind: "user", key: "slow-collection" }, rootThreadId: "thread",
      threadId: "thread", branchId: "branch", runId: "run", operationId: "slow-collection-op",
      executionOwner: { kind: "external", identity: "research.experiment", epoch: "original" }, source },
    access: { kind: "family", readThreadIds: ["thread"], controlThreadIds: ["thread"] },
  };
  const sourceAuthority: import("../kernel/research-source.js").ResearchSourceAuthority = {
    async admit(_caller, cwd) { return { kind: "physical", selection: source, canonicalRoot: f.root, cwd: cwd ?? "" }; },
    async capture(owner, _source, options) { return prepareExperimentInput(f.client, owner, f.root, options); },
    async release() {}, async reconcileUnaccepted() { return true; },
  };
  let service = f.makeService(sourceAuthority);
  const gate = deferred(); const entered = deferred(); let reads = 0;
  cleanup.push(() => gate.resolve());
  f.backend.collectFile = async () => {
    reads++; entered.resolve(); await gate.promise;
    throw new Error("controlled output collection failure");
  };
  const joins: Promise<import("@varin/protocol").ExperimentCollectResult>[] = [];
  let replaced = false;
  const unsubscribe = service.subscribeAttempts((_workspace, attemptId, view) => {
    if (view?.collection !== "pending" || replaced) return;
    replaced = true;
    service.detachObservers();
    service = f.makeService(sourceAuthority);
    // Synchronous terminal notification: this can enter before the automatic
    // collector has reached its first backend read, but must join that holder.
    joins.push(service.collect(caller, attemptId), service.collect(caller, attemptId));
  });
  cleanup.push(unsubscribe);
  const accepted = await service.submit(caller, {
    requestId: "slow-collection", command: "fixture-command", resources: { cpuCores: 1 }, outputPaths: ["result.bin"],
  });
  await until(() => f.counters().spawnCalls === 1);
  f.observe("cancelled");
  await entered.promise;
  const id = accepted.attempt.attemptId;
  assert.equal(replaced, true);
  assert.equal((await service.nativeReceipt("ws", id))!.executorStopped, true);
  assert.equal((await service.wait(caller, id, 0)).attempt.collection, "pending");
  assert.equal((await service.cancel(caller, id)).state, "cancelled");
  assert.equal(f.committed.size, 0);
  assert.equal(reads, 1);
  assert.equal(f.events.includes("backend-release"), false);
  assert.equal(f.events.includes("authority-retired:slow-collection-op"), false);
  assert.equal((await service.logs(caller, { attemptId: id })).eof, true);
  gate.resolve();
  const collected = await Promise.all(joins);
  assert.ok(collected.every(result => result.attempt.collection === "failed"));
  assert.equal(reads, 1);
  assert.equal((await service.logs(caller, { attemptId: id })).eof, true);
  assert.equal(f.events.includes("backend-release"), false);

  // A process restart loses only in-memory holders. Reconnect from the original
  // terminal job receipt and retry collection, never spawn or reacquire compute.
  service.detachObservers();
  const attemptRecord = f.records.get(`experiment.attempt:${id}`)!;
  const payload = JSON.parse(attemptRecord.payloadJson);
  await f.scoped.putRecord({ ...attemptRecord, expectedRecordRevision: attemptRecord.recordRevision,
    operationId: "fixture-collection-recovery", ownerIds: [], payloadJson: JSON.stringify({ ...payload, collection: "pending" }) });
  const retryGate = deferred(); const retryEntered = deferred();
  cleanup.push(() => retryGate.resolve());
  f.backend.collectFile = async () => { reads++; retryEntered.resolve(); await retryGate.promise; return Buffer.from("result"); };
  service = f.makeService(sourceAuthority, { ...f.client } as KernelClient);
  const retry = service.collect(caller, id);
  const duplicate = service.collect(caller, id);
  await retryEntered.promise;
  assert.equal(reads, 2);
  assert.equal(f.counters().spawnCalls, 1);
  assert.equal(f.counters().admissionCalls, 1);
  assert.equal(f.events.includes("backend-release"), false);
  retryGate.resolve();
  const retried = await Promise.all([retry, duplicate]);
  assert.ok(retried.every(result => result.attempt.collection === "done"));
  assert.equal(f.events.filter(event => event === "backend-release").length, 1);
  assert.ok(f.events.includes("authority-retired:slow-collection-op"));
  assert.equal(reads, 2);
  assert.equal((await service.collect(caller, id)).attempt.collection, "done");
  assert.equal(reads, 2, "completed collection reuses durable artifacts");
});

it("does not report collection done when both output capture and its failure record fail", async () => {
  const f = await fixture();
  const originalPut = f.scoped.putRecord.bind(f.scoped);
  let failRecord = true;
  f.scoped.putRecord = async (input, signal) => {
    if (failRecord && input.recordType === "experiment.artifact" && input.state === "failed") {
      throw new Error("controlled failed artifact record write failure");
    }
    return originalPut(input, signal);
  };
  const service = f.makeService();
  const accepted = await service.submit(f.caller, { requestId: "double-output-failure", command: "fixture", outputPaths: ["result.bin"] });
  await until(() => f.counters().spawnCalls === 1);
  f.observe("cancelled");
  await vi.waitFor(() => assert.equal(f.records.get(`experiment.attempt:${accepted.attempt.attemptId}`)?.state, "cancelled"));
  await vi.waitFor(() => assert.notEqual(JSON.parse(f.records.get(`experiment.attempt:${accepted.attempt.attemptId}`)!.payloadJson).collection, "pending"));
  assert.equal((await service.get(f.caller, accepted.attempt.attemptId)).attempt.collection, "failed");
  assert.equal(f.events.includes("backend-release"), false);
  failRecord = false;
  f.backend.collectFile = async () => Buffer.from("recovered output");
  assert.equal((await service.collect(f.caller, accepted.attempt.attemptId)).attempt.collection, "done");
  assert.equal(f.counters().spawnCalls, 1);
});

async function nativeArtifactFixture() {
  const f = await fixture();
  const { prepareExperimentInput } = await import('./experiment-workspace.js');
  const source = { workspace_id: 'ws', execution_workspace_id: 'exec', mode: 'live_root' as const,
    branch_id: null, revision: null, live_root: { hostId: 'fixture-host', canonicalRoot: f.root, rootId: 'source-root' } };
  const caller: ExperimentCaller = { workspaceId: 'ws', executionWorkspaceId: 'exec', threadId: 'thread', runId: 'run', workspaceScope: [],
    owner: { runtime: 'agent', actor: { kind: 'user', key: 'artifacts' }, rootThreadId: 'thread', threadId: 'thread', branchId: 'branch', runId: 'run', operationId: 'artifact-job', executionOwner: { kind: 'external', identity: 'research.experiment', epoch: 'original' }, source },
    access: { kind: 'family', readThreadIds: ['thread'], controlThreadIds: ['thread'] } };
  const service = f.makeService({ async admit(_caller, cwd) { return { kind: 'physical', selection: source, canonicalRoot: f.root, cwd: cwd ?? '' }; },
    async capture(owner, _source, options) { return prepareExperimentInput(f.client, owner, f.root, options); }, async release() {}, async reconcileUnaccepted() { return true; } });
  const binding = (subjectId: string): import('../kernel/protocol.generated.js').HostJobBinding => ({ operationId: 'artifact-job', executionOwner: { kind: 'external', identity: 'research.experiment', epoch: 'original' }, domain: 'research.experiment', domainVersion: 1, workspaceId: 'ws', subjectId });
  return { ...f, service, caller, binding, source };
}

it('observes durable artifact readiness during collection, stable completion revisions and actual family read permissions', async () => {
  const f = await nativeArtifactFixture();
  const held = deferred(), entered = deferred(); cleanup.push(() => held.resolve());
  const hints: Array<string> = [];
  cleanup.push(f.service.subscribeAttempts((_workspace, id, view) => { if (view === null) hints.push(id); }));
  cleanup.push(f.service.subscribeAttempts((_workspace, _id, view) => { if (view === null) throw new Error('observer failure after durable commit'); }));
  f.backend.collectFile = async (_site, name) => { if (name === 'b') { entered.resolve(); await held.promise; } return Buffer.from(name); };
  const accepted = await f.service.submit(f.caller, { requestId: 'artifacts', command: 'fixture', outputPaths: ['a', 'b'] });
  await until(() => f.counters().spawnCalls === 1); f.observe('cancelled'); await entered.promise;
  const target = f.binding(accepted.attempt.attemptId);
  const first = await f.service.readArtifactObservation(f.caller, target, { name: 'a' });
  assert.equal(first.artifacts[0]!.state, 'available'); assert.equal(first.artifacts[0]!.recordRevision, 1);
  assert.equal(first.completion, null); assert.ok(hints.includes(target.subjectId));
  assert.equal((await f.service.nativeReceipt('ws', target.subjectId))!.executorStopped, true);
  const sibling: ExperimentCaller = { ...f.caller, threadId: 'sibling', runId: 'sibling-run', owner: { runtime: 'agent', actor: { kind: 'reader' }, rootThreadId: 'thread', threadId: 'sibling', branchId: 'sibling-branch', runId: 'sibling-run', source: f.source }, access: { kind: 'family', readThreadIds: ['thread', 'sibling'], controlThreadIds: ['sibling'] } };
  assert.equal((await f.service.readArtifactObservation(sibling, target, { name: 'a' })).artifacts.length, 1);
  await assert.rejects(f.service.collect(sibling, target.subjectId), /control/i);
  await assert.rejects(f.service.readArtifactObservation({ ...sibling, access: { kind: 'maintenance' } }, target, {}), /family reader/i);
  await assert.rejects(f.service.readArtifactObservation({ ...sibling, access: { kind: 'family', readThreadIds: ['sibling'], controlThreadIds: [] } }, target, {}), /Unknown/);
  held.resolve(); await vi.waitFor(async () => assert.equal((await f.service.get(f.caller, target.subjectId)).attempt.collection, 'done'));
  const done = await f.service.readArtifactObservation(f.caller, target, {}); assert.equal(done.completion!.outcome, 'done');
  assert.equal(done.counts.failed, 0, 'listener failure cannot rewrite a committed available artifact');
  const record = f.records.get(`experiment.attempt:${target.subjectId}`)!;
  await f.scoped.putRecord({ ...record, expectedRecordRevision: record.recordRevision, operationId: 'unrelated-metadata', ownerIds: [], payloadJson: JSON.stringify({ ...JSON.parse(record.payloadJson), harmlessMetadata: true }) });
  assert.deepEqual((await f.service.readArtifactObservation(f.caller, target, {})).completion, done.completion);
  assert.equal((await f.service.readArtifactObservation(f.caller, target, { name: 'absent' })).artifacts.length, 0);
  assert.equal((await f.service.collect(f.caller, target.subjectId)).attempt.collectionCompletion!.recordRevision, done.completion!.recordRevision);
});

it('does not combine an old completed collection with a newly pending retry when reading absence', async () => {
  const f = await nativeArtifactFixture();
  const accepted = await f.service.submit(f.caller, { requestId: 'artifacts', command: 'fixture', outputPaths: ['result'] });
  await until(() => f.counters().spawnCalls === 1); f.observe('cancelled');
  const target = f.binding(accepted.attempt.attemptId);
  await vi.waitFor(async () => assert.equal((await f.service.get(f.caller, target.subjectId)).attempt.collection, 'failed'));
  const old = await f.service.readArtifactObservation(f.caller, target, {}); assert.equal(old.completion!.outcome, 'failed');
  const pageGate = deferred(), pageEntered = deferred(), collectGate = deferred(), collectEntered = deferred();
  cleanup.push(() => { pageGate.resolve(); collectGate.resolve(); });
  const getRecord = f.scoped.getRecord.bind(f.scoped); let gateRead = true;
  f.scoped.getRecord = async (workspace, id, signal) => {
    const result = await getRecord(workspace, id, signal);
    if (gateRead && id.startsWith('experiment.artifact:') && !result) { gateRead = false; pageEntered.resolve(); await pageGate.promise; }
    return result;
  };
  const reading = f.service.readArtifactObservation(f.caller, target, { name: 'absent' }); await pageEntered.promise;
  f.backend.collectFile = async () => { collectEntered.resolve(); await collectGate.promise; return Buffer.from('recovered'); };
  const retry = f.service.collect(f.caller, target.subjectId); await collectEntered.promise; pageGate.resolve();
  assert.equal((await reading).completion, null, 'pending retry invalidates prior terminal absence snapshot');
  collectGate.resolve(); await retry;
  const recovered = await f.service.readArtifactObservation(f.caller, target, {});
  assert.equal(recovered.completion!.outcome, 'done'); assert.ok(recovered.completion!.recordRevision > old.completion!.recordRevision);
  const artifact = recovered.artifacts.find(value => value.name === 'result')!; assert.equal(artifact.state, 'available'); assert.equal(artifact.recordRevision, 2);
  assert.equal(f.counters().spawnCalls, 1);
});

it('records not_started only after original unspawned cancellation drains its capture', async () => {
  const f = await nativeArtifactFixture(); const gate = deferred(), entered = deferred(); cleanup.push(() => gate.resolve());
  f.scan(async () => { entered.resolve(); await gate.promise; });
  const accepted = await f.service.submit(f.caller, { requestId: 'artifacts', command: 'fixture', outputPaths: ['result'] }); await entered.promise;
  const target = f.binding(accepted.attempt.attemptId);
  await f.service.cancel(f.caller, target.subjectId);
  assert.equal((await f.service.readArtifactObservation(f.caller, target, {})).completion, null);
  gate.resolve();
  await vi.waitFor(async () => assert.equal((await f.service.readArtifactObservation(f.caller, target, {})).completion?.outcome, 'not_started'));
  assert.equal(f.counters().spawnCalls, 0);
});

it('reads only the original published log byte boundary, including raw UTF-8 splits, EOF and family authority', async () => {
  const { prepareExperimentInput } = await import('./experiment-workspace.js');
  const f = await fixture();
  const source = { workspace_id: 'ws', execution_workspace_id: 'exec', mode: 'live_root' as const, branch_id: null, revision: null, live_root: { hostId: 'fixture-host', canonicalRoot: f.root, rootId: 'source-root' } };
  const caller: ExperimentCaller = { workspaceId: 'ws', executionWorkspaceId: 'exec', threadId: 'thread', runId: 'run', workspaceScope: [],
    owner: { runtime: 'agent', actor: { kind: 'user', key: 'log-owner' }, rootThreadId: 'thread', threadId: 'thread', branchId: 'branch', runId: 'run', operationId: 'log-operation', executionOwner: { kind: 'external', identity: 'research.experiment', epoch: 'log-owner' }, source },
    access: { kind: 'family', readThreadIds: ['thread'], controlThreadIds: ['thread'] } };
  const service = f.makeService({ async admit() { return { kind: 'physical', selection: source, canonicalRoot: f.root, cwd: '' }; },
    async capture(owner, _source, options) { return prepareExperimentInput(f.client, owner, f.root, options); }, async release() {}, async reconcileUnaccepted() { return true; } });
  const entered = deferred(), release = deferred(); cleanup.push(() => release.resolve());
  const bytes = Buffer.concat([Buffer.from('中ababa'), Buffer.from([0xff]), Buffer.from('tail')]);
  const put = f.scoped.putRecord.bind(f.scoped); let gated = false;
  f.scoped.putRecord = async input => {
    const payload = JSON.parse(input.payloadJson);
    if (input.recordType === 'experiment.job' && payload.stdoutBytes === bytes.length && !gated) { gated = true; entered.resolve(); await release.promise; }
    return put(input);
  };
  const read = f.backend.read.bind(f.backend);
  f.backend.read = async (site, job, cursor) => cursor === 0 ? { chunks: [{ channel: 'stdout', bytesBase64: bytes.toString('base64') }], nextCursor: bytes.length, endCursor: bytes.length, observation: { status: 'running', writerActive: true } } : read(site, job, cursor);
  const accepted = await service.submit(caller, { requestId: 'log-owner', command: 'fixture-command' });
  const binding = { operationId: 'log-operation', executionOwner: { kind: 'external' as const, identity: 'research.experiment', epoch: 'log-owner' }, domain: 'research.experiment', domainVersion: 1, workspaceId: 'ws', subjectId: accepted.attempt.attemptId };
  await entered.promise;
  const unpublished = await service.readLogObservation(caller, binding, { stream: 'stdout', offset: 0 });
  assert.equal(unpublished.publishedBytes, 0); assert.equal(unpublished.bytes.length, 0); assert.equal(unpublished.eof, false);
  release.resolve(); await until(() => [...f.records.values()].some(r => r.recordType === 'experiment.job' && JSON.parse(r.payloadJson).stdoutBytes === bytes.length));
  const one = await service.readLogObservation(caller, binding, { stream: 'stdout', offset: 0, maxBytes: 1 });
  assert.deepEqual(one.bytes, bytes.subarray(0,1)); assert.equal(one.nextOffset,1);
  const rest = await service.readLogObservation(caller, binding, { stream: 'stdout', offset:1 });
  assert.deepEqual(Buffer.concat([one.bytes,rest.bytes]),bytes); assert.equal(rest.eof,false);
  const beyond = await service.readLogObservation(caller,binding,{stream:'stdout',offset:100});
  assert.equal(beyond.nextOffset,100);assert.equal(beyond.eof,false);
  await assert.rejects(service.readLogObservation({ ...caller, access: {kind:'family',readThreadIds:[],controlThreadIds:[]} },binding,{stream:'stdout',offset:0}), /Unknown experiment attempt/);
  await service.cancel(caller,binding.subjectId); await service.wait(caller,binding.subjectId,2000);
  const final = await service.readLogObservation(caller,binding,{stream:'stdout',offset:100});
  assert.equal(final.nextOffset,100);assert.equal(final.eof,true);
  assert.equal((await service.readLogObservation(caller,binding,{stream:'stderr',offset:0})).eof,true);
  const chunk = [...f.records.entries()].find(([,r]) => r.recordType === 'experiment.artifact' && JSON.parse(r.payloadJson).internalLogChunk === true)!;
  f.records.delete(chunk[0]);
  await assert.rejects(service.readLogObservation(caller,binding,{stream:'stdout',offset:0}),/missing durable page/);
});
