import fs from "node:fs/promises";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { createKernelProcessService } from "./process-service.js";
import { createKernelProcessIdentityResolver } from "./process-identity.js";
import { createManagedRootAdmission } from "./managed-root-admission.js";
import { createThreadRegistry } from "../harness/thread-registry.js";
import { assertManagedWorktreeOwnership } from "../harness/worktree-ownership.js";
import { createDocumentAuthorityHarness } from "../documents/contract-fixtures.js";
import { createNativeProcessTestHarness, hasNativeProcessKernel } from "../process/native-process.test-helper.js";
import { createLanguageSupervisor } from "../lsp/supervisor.js";
import { VARIN_LSP_FIXTURE_SERVER_ARGS } from "../lsp/servers.js";
import { createDebugSupervisor } from "../run/debug-supervisor.js";
import { createTestSupervisor } from "../run/test-supervisor.js";
import { createWorkspaceTaskRunner } from "../run/tasks.js";
import { VARIN_DAP_FIXTURE_ADAPTER_ARGS, VARIN_TEST_FIXTURE_PROVIDER_ARGS } from "../run/servers.js";
import { createManagedRemoteExecutionService } from '../harness/managed-remote-service.js';
import type { ResourceService } from '../harness/resources.js';

if (!hasNativeProcessKernel && process.env.VARIN_REQUIRE_RELEASE_KERNEL === "1") throw new Error("Native consumer acceptance requires the release kernel");
const wait = (ms=10) => new Promise<void>((resolve) => setTimeout(resolve,ms));
async function until(probe: () => boolean | Promise<boolean>) {
  for(let i=0;i<1200;i++){if(await probe())return;await wait();}
  throw new Error("Native consumer did not reach its expected state");
}
async function fixture() {
  const docs = await createDocumentAuthorityHarness();
  const native = createNativeProcessTestHarness(docs.authority);
  const { service, client } = await native.get();
  return { docs, service, client, cleanup: async () => { await native.dispose(); await docs.cleanup(); } };
}

describe.skipIf(!hasNativeProcessKernel)("production consumers over Rust process pipes",()=>{
  it('Bot sleep stops only its own remote process trees and persists remote admission across restart', async () => {
    const f = await fixture();
    const client = f.client;
    const options = { client, hostId: 'remote-sleep-test', resources: {} as ResourceService };
    const remote = createManagedRemoteExecutionService(options);
    let otherProcess: string | undefined;
    try {
      const directory = path.join(f.docs.workspaceRoot, 'remote bot & work');
      await fs.mkdir(directory);
      const script = path.join(directory, 'remote-bot-work.cjs');
      await fs.writeFile(script, 'process.stdout.write("ready\\n");setInterval(() => {}, 1000)');
      const input = { coordinatorHostId: 'coordinator', command: `"${process.execPath}" "${script}"`, cwd: f.docs.workspaceRoot, waitMs: 0 };
      const first = await remote.shellExec('principal', { ...input, toolCallId: 'a', ownerScopeId: 'bot:a' });
      const second = await remote.shellExec('principal', { ...input, toolCallId: 'b', ownerScopeId: 'bot:b' });
      expect(first.kind).toBe('background'); expect(second.kind).toBe('background');
      if (first.kind !== 'background' || second.kind !== 'background') throw new Error('Expected running workers');
      otherProcess = second.id;
      // A published native handle can precede a shell startup failure. Prove
      // both commands reached user code before testing scope cancellation.
      for (const id of [first.id, second.id]) {
        await until(async () => {
          const state = await remote.shellRead('principal', 'coordinator', id, 0, 4096);
          if (!state.running) throw new Error(`Remote worker exited before readiness: ${JSON.stringify(state)}`);
          return state.text.includes('ready\n');
        });
      }
      await remote.setShellScopeSleeping('principal', 'coordinator', 'bot:a', true);
      expect((await remote.shellRead('principal', 'coordinator', first.id, 0, 0)).running).toBe(false);
      expect((await remote.shellRead('principal', 'coordinator', second.id, 0, 0)).running).toBe(true);
      const reopened = createManagedRemoteExecutionService(options);
      await expect(reopened.shellExec('principal', { ...input, toolCallId: 'c', ownerScopeId: 'bot:a' })).rejects.toThrow(/asleep/);
      await reopened.setShellScopeSleeping('principal', 'coordinator', 'bot:a', false);
    } finally {
      if (otherProcess) await remote.shellKill('principal', 'coordinator', otherProcess);
      await f.cleanup();
    }
  });
  it("LSP initializes, completes and closes its native language server",async()=>{
    const f=await fixture();
    const language=createLanguageSupervisor({ documents:f.docs.authority, spawn:f.service.spawn,isTrusted:async()=>true });
    try {
      language.registerProvider({ providerId:"native-lsp",command:process.execPath,args:VARIN_LSP_FIXTURE_SERVER_ARGS,languageIds:["typescript"],source:"host" });
      const resource=f.docs.resource("note.ts");
      expect(await language.syncDocument({resource,languageId:"typescript",documentVersion:1,reason:"open",content:"const value=1;\n"})).toMatchObject({status:"synced"});
      expect(await language.completion({resource,languageId:"typescript",documentVersion:1,position:{line:0,character:0}})).toMatchObject({status:"ready",value:[expect.objectContaining({label:"fixtureItem"})]});
      expect((await f.service.list(f.docs.workspaceRoot)).some(p=>p.writerActive)).toBe(true);
      await language.disposeWorkspace(f.docs.identity.workspaceId);
      expect((await f.service.list(f.docs.workspaceRoot)).every(p=>!p.writerActive)).toBe(true);
    } finally { await language.dispose(); await f.cleanup(); }
  },30000);

  it("DAP uses native protocol pipes and confirms adapter exit on stop",async()=>{
    const f=await fixture();
    const debug=createDebugSupervisor({ documents:f.docs.authority,spawn:f.service.spawn,isTrusted:async()=>true });
    try {
      await fs.writeFile(path.join(f.docs.workspaceRoot,"app.js"),"const value=1;\n");
      debug.registerAdapter({adapterId:"native-dap",command:process.execPath,args:VARIN_DAP_FIXTURE_ADAPTER_ARGS,languageIds:["javascript"],source:"host"});
      await debug.start({workspaceId:f.docs.identity.workspaceId,program:"app.js",languageId:"javascript"});
      await until(()=>debug.getStatus(f.docs.identity.workspaceId).status==="paused");
      expect(await debug.getThreads({workspaceId:f.docs.identity.workspaceId})).toMatchObject({status:"ready",value:[{id:1,name:"fixture"}]});
      await debug.stop({workspaceId:f.docs.identity.workspaceId});
      expect((await f.service.list(f.docs.workspaceRoot)).every(p=>!p.writerActive)).toBe(true);
    } finally { await debug.dispose(); await f.cleanup(); }
  },30000);

  it("task output and nonzero exit flow through the same native handle",async()=>{
    const f=await fixture();
    const tasks=createWorkspaceTaskRunner({documents:f.docs.authority,spawn:f.service.spawn,isTrusted:async()=>true});
    try {
      await fs.writeFile(path.join(f.docs.workspaceRoot,"task.js"),"process.stdout.write('native-task 中文');process.exitCode=7;");
      await fs.writeFile(path.join(f.docs.workspaceRoot,"varin.tasks.json"),JSON.stringify({version:1,tasks:[{id:"task",label:"Task",type:"node",script:"task.js"}]}));
      const output:string[]=[];let code:number|undefined;
      tasks.subscribe(f.docs.identity.workspaceId,e=>{if(e.kind==="output")output.push(e.text);if(e.kind==="status")code=e.snapshot.exitCode;});
      await tasks.run({workspaceId:f.docs.identity.workspaceId,taskId:"task"});
      await until(()=>code===7);
      expect(output.join("")).toBe("native-task 中文");
      expect((await f.service.list(f.docs.workspaceRoot)).every(p=>!p.writerActive)).toBe(true);
    } finally { await tasks.dispose(); await f.cleanup(); }
  },30000);

  it("test adapters and builtin Node tests both use native pipes",async()=>{
    const f=await fixture();
    const tests=createTestSupervisor({documents:f.docs.authority,spawn:f.service.spawn,isTrusted:async()=>true});
    try {
      await fs.writeFile(path.join(f.docs.workspaceRoot,"hello.test.js"),"require('node:test')('native',()=>require('node:assert/strict').equal(2,2));");
      tests.registerProvider({providerId:"node",kind:"node-test",source:"builtin"});
      expect(await tests.discover({workspaceId:f.docs.identity.workspaceId})).toMatchObject({status:"ready"});
      let passed=false;tests.subscribe(f.docs.identity.workspaceId,e=>{if(e.kind==="test"&&e.test.status==="passed")passed=true;});
      await tests.run({workspaceId:f.docs.identity.workspaceId});
      expect(passed).toBe(true);
      tests.registerProvider({providerId:"adapter",command:process.execPath,args:VARIN_TEST_FIXTURE_PROVIDER_ARGS,source:"host"});
      expect(await tests.discover({workspaceId:f.docs.identity.workspaceId,providerId:"adapter"})).toMatchObject({status:"ready"});
      await tests.disposeWorkspace(f.docs.identity.workspaceId);
      expect((await f.service.list(f.docs.workspaceRoot)).every(p=>!p.writerActive)).toBe(true);
    } finally { await tests.dispose(); await f.cleanup(); }
  },30000);

  it("task cancellation during asynchronous spawn cannot publish a late running child",async()=>{
    const f=await fixture();let resume!:()=>void;let entering!:()=>void;
    const blocked=new Promise<void>(r=>{resume=r;});const entered=new Promise<void>(r=>{entering=r;});
    const tasks=createWorkspaceTaskRunner({documents:f.docs.authority,isTrusted:async()=>true,spawn:async(...args)=>{entering();await blocked;return f.service.spawn(...args);}});
    try {
      await fs.writeFile(path.join(f.docs.workspaceRoot,"task.js"),"setInterval(()=>{},1000)");
      await fs.writeFile(path.join(f.docs.workspaceRoot,"varin.tasks.json"),JSON.stringify({version:1,tasks:[{id:"task",label:"Task",type:"node",script:"task.js"}]}));
      let runId:string|undefined;tasks.subscribe(f.docs.identity.workspaceId,e=>{if(e.kind==="status")runId=e.snapshot.runId;});
      const starting=tasks.run({workspaceId:f.docs.identity.workspaceId,taskId:"task"});
      await entered;
      tasks.cancel({workspaceId:f.docs.identity.workspaceId,runId});resume();
      expect((await starting).status).not.toBe("running");
      await until(async()=> (await f.service.list(f.docs.workspaceRoot)).every(p=>!p.writerActive));
    } finally {resume();await tasks.dispose();await f.cleanup();}
  },30000);
});


describe.skipIf(!hasNativeProcessKernel)("production native process root admission",()=>{
  it.each(["pending", "enrolled"] as const)("keeps retained Thread process ownership with %s Documents enrollment",async(enrollment)=>{
    const docs=await createDocumentAuthorityHarness();
    const native=createNativeProcessTestHarness(docs.authority);
    const { client }=await native.get();
    const registry=createThreadRegistry({dataDir:docs.dataDir,hostId:"process-identity"});
    const managedRoot=path.join(enrollment === "pending" ? docs.root : docs.workspaceRoot,"managed");
    const live=path.join(managedRoot,"thread");
    const sibling=path.join(managedRoot,"unrecorded");
    await fs.mkdir(live,{recursive:true});await fs.mkdir(sibling);
    const execution = enrollment === "enrolled" ? (await docs.authority.resolveWorkspace({ path: live })).workspaceId : null;
    if (execution) expect(execution).not.toBe(docs.identity.workspaceId);
    const thread=await registry.createThread({scopeId:docs.identity.workspaceId,parent:{kind:"session",id:"parent"},brief:"Native admission",preset:"hard-implement",kind:"implementation",createdBy:"user",concurrency:1,autoRun:false,worktree:"isolated",scope:[],tools:[],permissions:{}});
    await registry.setWorktree(docs.identity.workspaceId,thread.id,{path:live,managedRoot,base:"zero-commit",materialized:true,viewMode:"materialized"});
    const admission=createManagedRootAdmission({
      listWorktrees:async(workspaceId)=>(await registry.listWorkspaceThreads(workspaceId)).flatMap(t=>t.worktree?[t.worktree]:[]),
      assertOwnership:(worktree,operation,candidates)=>assertManagedWorktreeOwnership(worktree,operation,candidates,{authorizeManagedRoot:candidate=>candidate===managedRoot}),
    });
    const resolveIdentity=createKernelProcessIdentityResolver({documents:docs.authority,registry,admitManaged:admission.materialization});
    const processes=createKernelProcessService({client,resolveIdentity});
    try {
      expect(await docs.authority.resolveScopeId(live)).toBe(execution);
      expect(await resolveIdentity(live)).toMatchObject({ workspaceId: docs.identity.workspaceId, executionWorkspaceId: execution ?? docs.identity.workspaceId });
      const child=await processes.spawn(process.execPath,["-e","process.stdout.write('retained-thread')"],{cwd:live,env:process.env});
      let output="";child.stdout.setEncoding("utf8");child.stdout.on("data",(text:string)=>{output+=text;});child.stderr.resume();
      await child.completion;expect(child.exitCode).toBe(0);expect(output).toBe("retained-thread");
      if (enrollment === "pending") await expect(processes.spawn(process.execPath,["-e","process.exit(0)"],{cwd:sibling})).rejects.toThrow(/admitted|retained/);
      expect(await docs.authority.resolveScopeId(live)).toBe(execution);
    } finally {await processes.dispose();await registry.dispose();await native.dispose();await docs.cleanup();}
  },30000);
});
