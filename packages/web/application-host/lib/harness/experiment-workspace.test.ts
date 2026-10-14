import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import { KernelClientError, type KernelClient, type KernelScopedClient } from "../kernel/kernel-client.js";
import { createLocalExperimentBackend, ExperimentPreparationError } from "./experiment-backend.js";
import { materializeExperimentAttempt, reconcileExperimentPreparation, openExperimentInputTransfer, prepareExperimentInput, ExperimentInputCaptureError, type ExperimentInputSnapshot, type ExperimentWorkspaceCaller } from "./experiment-workspace.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-preparation-proof-")); roots.push(root);
  const caller: ExperimentWorkspaceCaller = { workspaceId: "ws", executionWorkspaceId: "exec",
    owner: { runtime: "agent", threadId: "preparation-thread", runId: "preparation-run", operationId: "preparation-operation" } };
  const input: ExperimentInputSnapshot = {
    schemaVersion: 2, source: {kind:"physical-capture"}, branchId: "original-input", root: "sha256-original", sourceRoot: root,
    workspaceId: "ws", executionWorkspaceId: "exec", captureScopes: [], capturedPathCount: 0, inventoryFingerprint: "empty",
    captureSemantics: { excludedDirectories: [".git", ".varin"], gitignore: "not-applied", ignoredFilesIncluded: true },
  };
  let receipt: Record<string, unknown> | null = { state: "committed", result: { root: input.root, status: "materialized" } };
  let leaseStatus = "busy";
  let materializationError: Error | undefined = new Error("transport disconnected");
  const calls: Array<{ operation: string; value?: unknown }> = [];
  const scoped = {
    async getOperation(operation: string) { calls.push({ operation: "get", value: operation }); return receipt; },
    async readBranch() { return { workspaceId: caller.workspaceId, root: input.root, currentRoot: input.root }; },
    async fileRootRegister() { return { rootId: "original-storage-root" }; },
    async fileLeaseAcquire(value: unknown) { calls.push({ operation: "lease", value }); return { status: leaseStatus }; },
    async fileLeaseRelease(value: unknown) { calls.push({ operation: "release", value }); return { released: true }; },
    async fileMaterialize(value: unknown) { calls.push({ operation: "materialize", value }); if(materializationError)throw materializationError;await fs.mkdir(path.join(root,(value as {path:string}).path),{recursive:true});return {status:"materialized",root:input.root}; },
    async processRelease(){calls.push({operation:"process-release"});return {};},
  } as unknown as KernelScopedClient;
  const client = { handshake: { storageRoot: root }, start: async () => ({}), issueGrant: async (grant:object) => grant, retireGrant: async (id:string) => {calls.push({operation:"retire",value:id});return {};}, scoped: () => scoped } as unknown as KernelClient;
  return { caller, input, client, scoped, calls, setReceipt: (value: typeof receipt) => { receipt = value; }, setLease: (value: string) => { leaseStatus = value; }, failMaterialization: (error: Error | undefined) => { materializationError = error; } };
}

describe("local preparation drain proof with explicit kernel authority fixtures", () => {
  it("requires both the original committed root and an acquired physical subtree lease", async () => {
    const f = await fixture();
    assert.equal(await reconcileExperimentPreparation(f.client, f.caller, "attempt", f.input), "unknown");
    assert.equal(f.calls.filter((call) => call.operation === "release").length, 0);
    f.setLease("acquired");
    assert.equal(await reconcileExperimentPreparation(f.client, f.caller, "attempt", f.input), "drained");
    assert.equal(f.calls.filter((call) => call.operation === "materialize").length, 0);
    const acquired = f.calls.filter((call) => call.operation === "lease").at(-1)!.value as { rootId: string; leaseId: string; resources: Array<{ path: string; scope: string }> };
    const released = f.calls.find((call) => call.operation === "release")!.value as { rootId: string; leaseId: string };
    assert.equal(released.leaseId, acquired.leaseId); assert.equal(released.rootId, acquired.rootId);
    assert.equal(acquired.resources[0]!.scope, "subtree"); assert.match(acquired.resources[0]!.path, /^managed\/experiments\//);
  });

  it("keeps missing, started, and different-root receipts unknown without probing a substitute target", async () => {
    const f = await fixture(); f.setLease("acquired");
    for (const receipt of [null, { state: "started", result: { root: f.input.root } }, { state: "committed", result: { root: "sha256-other" } }]) {
      f.setReceipt(receipt); assert.equal(await reconcileExperimentPreparation(f.client, f.caller, "attempt", f.input), "unknown");
    }
    assert.equal(f.calls.filter((call) => call.operation === "lease" || call.operation === "materialize").length, 0);
  });

  it("distinguishes a real cancellation acknowledgement from loss of the materialization connection", async () => {
    const f = await fixture();
    await assert.rejects(materializeExperimentAttempt(f.client, f.caller, "attempt", f.input), (error: unknown) => error instanceof ExperimentPreparationError && !error.drained);
    assert.equal(f.calls.filter(c=>c.operation==="retire").length,0,"unknown physical writer retains its original grant for reconciliation");
    f.failMaterialization(new KernelClientError({ code: "cancelled", message: "native worker acknowledged cancellation" }));
    await assert.rejects(materializeExperimentAttempt(f.client, f.caller, "attempt", f.input), (error: unknown) => error instanceof ExperimentPreparationError && error.drained);
    assert.equal(f.calls.filter((call) => call.operation === "materialize").length, 2);
    assert.equal(f.calls.filter(c=>c.operation==="retire").length,1,"acknowledged cancellation retires only its own completed helper grant");
  });
});

it('materialization hands its grant to the original backend until real readers and process bookkeeping release finish',async()=>{
 const f=await fixture();f.failMaterialization(undefined);
 const materialized=await materializeExperimentAttempt(f.client,f.caller,'successful',f.input);
 assert.equal(f.calls.filter(c=>c.operation==='retire').length,0);
 let finish:()=>void=()=>{};let entered:()=>void=()=>{};const gate=new Promise<void>(r=>{finish=r;}),started=new Promise<void>(r=>{entered=r;});
 Object.assign(f.scoped,{processRead:async()=>{entered();await gate;return {chunks:[],nextCursor:0,endCursor:0,process:{status:'exited',writerActive:false}};}});
 const backend=createLocalExperimentBackend(materialized.scoped,materialized.releaseAuthority);
 const site={workspaceId:'ws',rootId:materialized.rootId,canonicalRoot:materialized.canonicalRoot,transport:materialized.scoped};
 const reading=backend.read(site,'original',0);await started;
 const releasing=backend.release(site,'original');await new Promise(r=>setImmediate(r));assert.equal(f.calls.filter(c=>c.operation==='retire').length,0);
 finish();await reading;await releasing;await backend.release(site,'original');
 assert.equal(f.calls.filter(c=>c.operation==='process-release').length,1);assert.equal(f.calls.filter(c=>c.operation==='retire').length,1);
});
it('transfer close waits for the actual content iterator and retires once without cancelling its reader',async()=>{
 const f=await fixture();let finish:()=>void=()=>{};let entered:()=>void=()=>{};const gate=new Promise<void>(r=>{finish=r;}),started=new Promise<void>(r=>{entered=r;});
 Object.assign(f.scoped,{readBranch:async()=>({workspaceId:'ws',root:f.input.root,currentRoot:f.input.root,entries:[{path:'input',state:{kind:'regular-file',objectHash:'sha256-bytes',byteLength:3,mode:420}}],nextCursor:null}),getBlob:async()=>{entered();await gate;return {bytesBase64:Buffer.from('abc').toString('base64'),nextOffset:3};}});
 const transfer=await openExperimentInputTransfer(f.client,f.caller,f.input);
 const reader=transfer.readObject('sha256-bytes',3)[Symbol.asyncIterator]();const first=reader.next();await started;
 let closed=false;const closing=transfer.close().then(()=>{closed=true;});await new Promise(r=>setImmediate(r));assert.equal(closed,false);
 finish();assert.equal(Buffer.from((await first).value!).toString(),'abc');assert.equal(closed,false);await reader.return?.();await closing;await transfer.close();
 assert.equal(f.calls.filter(c=>c.operation==='retire').length,1);
 await assert.rejects(async()=>{for await(const _ of transfer.readObject('sha256-bytes',3))void _;},/closed/);
});


it.each([1, 2])('keeps the original source lease and drain fact through inventory pass %s', async failingPass => {
  for (const kind of ['cancelled', 'kernel-disconnected'] as const) {
    const f = await fixture();
    f.setLease('acquired');
    let finish!: () => void;
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { finish = resolve; });
    const controller = new AbortController();
    let pass = 0;
    const scans: Array<{ leaseId: string }> = [];
    Object.assign(f.scoped, {
      fileScan: async (params: { leaseId: string }) => {
        scans.push(params);
        if (++pass === failingPass) {
          enter(); await held;
          throw new KernelClientError({ code: kind, message: kind });
        }
        return { paths: [], fingerprint: 'empty', nextCursor: null };
      },
    });
    let settled = false;
    const preparing = prepareExperimentInput(f.client, f.caller, f.input.sourceRoot!, {
      captureScopes: [], signal: controller.signal,
    }).catch(error => { settled = true; return error; });
    await entered;
    controller.abort();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'an abort is not the inventory worker stop receipt');
    assert.equal(f.calls.filter(call => call.operation === 'release' || call.operation === 'retire').length, 0);
    const acquired = f.calls.find(call => call.operation === 'lease')!.value as { leaseId: string };
    assert.ok(scans.every(scan => scan.leaseId === acquired.leaseId), 'both scans must bind the original capture lease');
    finish();
    const error = await preparing;
    assert.ok(error instanceof ExperimentInputCaptureError);
    assert.equal(error.drained, kind === 'cancelled');
    assert.equal(error.branchCreateDispatched, false);
    assert.equal(f.calls.filter(call => call.operation === 'retire').length, kind === 'cancelled' ? 1 : 0);
    assert.equal(f.calls.filter(call => call.operation === 'release').length, 1, 'lease release requests defer to the original active kernel worker');
  }
});
