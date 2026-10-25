import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, it } from 'vitest';
import { createResearchSourceAuthority } from './research-source.js';
import type { KernelClient } from './kernel-client.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ExperimentCaller } from '../harness/research-identity.js';
import type { LaunchSource, KernelGrantIssueParams } from './protocol.generated.js';
const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function fixture(mode:LaunchSource['mode']='fixed_branch'){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'research-source-')));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const key=createHash('sha256').update(JSON.stringify(['ws','run'])).digest('hex');const materialized=path.join(root,'managed/runs',key);await mkdir(materialized,{recursive:true});
 const source:LaunchSource={resource_owner: { kind: 'local' as const }, workspace_id:'ws',execution_workspace_id:'exec',mode,branch_id:mode==='live_root'?null:'source',revision:mode==='live_root'?null:7,live_root:mode==='live_root'?{hostId:'host',rootId:'live-root',canonicalRoot:root}:null};
 const issued:KernelGrantIssueParams[]=[],retired:string[]=[],pins=new Set<string>(),operations=new Map<string,unknown>();
 let losePin=false,pendingPin=false,cancelRequested=false,trusted=true,activeCapture:Promise<void>|undefined;let finishCapture:()=>void=()=>{};
 const branch={workspaceId:'ws',branchId:'source',revision:7,view:'revision',root:'sha256-exact',entries:[]};
 const api={
  async readBranch(){return structuredClone(branch);},
  // This source has not prepared a mutable execution view.
  async executionViewInspect(){return null;},
  async pinBranch(p:{operationId:string;pinId:string;branchId:string}){const result={pinId:p.pinId,branchId:p.branchId,workspaceId:'ws',revision:7,view:'revision',root:branch.root};pins.add(p.pinId);operations.set(p.operationId,{operationId:p.operationId,kind:'branch.pin',state:pendingPin?'pending':'committed',result});if(losePin){losePin=false;throw new Error('Pin ACK lost');}return result;},
  async unpinBranch(p:{pinId:string}){pins.delete(p.pinId);return {};},
  async getOperation(id:string){return operations.get(id)??null;},
  async createBranch(p:{branchId:string;baseRef:string}){assert.equal(p.baseRef,'pin:research-input:op');assert.ok(pins.has('research-input:op'));await activeCapture;return {branchId:p.branchId,root:branch.root};},
  async fileMaterialize(p:{operationId:string;path:string;sourceRoot:string}){
   assert.equal(path.resolve(root,p.path),materialized);assert.equal(p.sourceRoot,branch.root);
   const result={status:'materialized'};operations.set(p.operationId,{state:'committed',result});return result;
  },
  async fileRootRegister(p:{canonicalRoot:string}){return {canonicalRoot:p.canonicalRoot,rootId:p.canonicalRoot===root?'live-root':'materialized-root'};},
 };
 const kernel={retireOperationGrants:async()=>({}),handshake:{storageRoot:root},issueGrant:async(p:KernelGrantIssueParams)=>{issued.push(p);return p;},retireGrant:async(id:string)=>{retired.push(id);},scoped:()=>api} as unknown as KernelClient;
 const runtime={executionEnvironment:async()=>({platform:'linux',defaultShell:null,shells:[]}),admitSourceRegistration:async (selected:{workspaceId:string;executionWorkspaceId:string})=>{assert.equal(selected.workspaceId,'ws');assert.equal(selected.executionWorkspaceId,'exec');if(!trusted)throw new Error('Current source trust withdrawn');},run:async()=>({id:'run',thread_id:'thread',branch_id:'branch',state:'completed'}),launch:async()=>({selection:{source,tools:[],extension_bindings:[]}}),operation:async()=>({id:'op',run_id:'run',lifetime:'thread',execution_owner:{kind:'external',identity:'tool',epoch:'host'},phase:'terminal',cancel_requested:cancelRequested})} as unknown as AgentRuntimeClient;
 const caller:ExperimentCaller={workspaceId:'ws',executionWorkspaceId:'exec',workspaceScope:[''],owner:{runtime:'agent',rootThreadId:'thread',threadId:'thread',branchId:'branch',runId:'run',operationId:'op',executionOwner:{kind:'external',identity:'tool',epoch:'host'},source,actor:{kind:'user',key:'request'}},access:{kind:'family',readThreadIds:['thread'],controlThreadIds:['thread']}};
 let validates=0;const authority=createResearchSourceAuthority({kernel,runtime:()=>runtime,resolveLiveSource:async selected=>{validates++;assert.deepEqual(selected.liveRoot,source.live_root);}});
 return {authority,caller,issued,retired,pins,root,materialized,source,revokeTrust:()=>{trusted=false;},validates:()=>validates,losePin:()=>{losePin=true;},pendingPin:(v:boolean)=>{pendingPin=v;},cancel:()=>{cancelRequested=true;},hold:()=>{activeCapture=new Promise<void>(resolve=>{finishCapture=resolve;});},finish:()=>finishCapture()};
}
it('fixed input uses its exact pin and original operation grant after source Run retirement, and cleanup remains authorized',async()=>{
 const f=await fixture();const admitted=await f.authority.admit(f.caller,'');assert.equal(admitted.kind,'fixed');assert.equal(f.pins.size,1);
 f.hold();let candidate=false;const capture=f.authority.capture(f.caller,admitted,{branchId:'candidate',beforeBranchCreate:async()=>{candidate=true;}});
 for(let i=0;i<20&&!candidate;i++)await new Promise(resolve=>setImmediate(resolve));assert.ok(candidate);
 assert.equal(f.issued.length,2);assert.equal(f.retired.length,1,'capture grant is held until its actual branch create drains');
 f.finish();const snapshot=await capture;assert.equal(snapshot.root,'sha256-exact');assert.equal(snapshot.sourceRoot,null);assert.equal(snapshot.inventoryFingerprint,null);assert.equal(snapshot.source.kind,'fixed-branch');
 f.cancel();f.revokeTrust();await f.authority.release(f.caller,admitted);assert.equal(f.pins.size,0);assert.equal(f.issued.length,f.retired.length);
 assert.ok(f.issued.every(g=>g.operationId==='op'&&g.runId==='run'&&g.threadId==='thread'));
 assert.deepEqual(f.issued.at(-1)!.capabilities,['storage.read','storage.maintenance']);
 await assert.rejects(f.authority.capture(f.caller,admitted,{branchId:'never-created'}),/no longer admits capture/);
});
it('invalid fixed cwd is rejected before a pin; a lost pin ACK is reconciled by the original operation only',async()=>{
 const f=await fixture();for(const cwd of ['../escape','/absolute','C:\\escape'])await assert.rejects(f.authority.admit(f.caller,cwd));assert.equal(f.pins.size,0);
 f.losePin();await assert.rejects(f.authority.admit(f.caller,''),/ACK lost/);assert.equal(f.pins.size,1);f.cancel();f.revokeTrust();assert.equal(await f.authority.reconcileUnaccepted(f.caller),true);assert.equal(f.pins.size,0);
 const pending=await fixture();pending.pendingPin(true);pending.losePin();await assert.rejects(pending.authority.admit(pending.caller,''));assert.equal(await pending.authority.reconcileUnaccepted(pending.caller),false);assert.equal(pending.pins.size,1,'pending original pin is not proof of no effect');
});
it('live and materialized sources use original physical identities, never process cwd or a default workspace',async()=>{
 for(const mode of ['live_root','materialized'] as const){const f=await fixture(mode);const admitted=await f.authority.admit(f.caller,'');assert.equal(admitted.kind,'physical');if(admitted.kind==='physical')assert.equal(admitted.canonicalRoot,mode==='live_root'?f.root:f.materialized);assert.equal(f.validates(),mode==='live_root'?1:0);assert.ok(f.issued.every(g=>g.operationId==='op'));assert.equal(f.issued.length,f.retired.length);}
});
it('the actual Host KernelClient Run retirement keeps operation-owned pending readers until explicit grant retirement',async()=>{
 const {KernelClient}=await import('./kernel-client.js');
 const client=new KernelClient({hostId:'pure-client',storageRoot:'/tmp/research-pure-client',buildVersion:'0.9.25',spawnProcess:()=>{throw new Error('No process transport in this unit test');}});
 const cancelled:string[]=[];let refuseOperationRetirement=false;
 // Only the private transport return is controlled. Issuance, identity projection,
 // local pending cancellation and retirement run through the production client.
 Object.defineProperty(client,'handshakeResult',{value:{storageRoot:'/tmp/research-pure-client'}});
 Object.defineProperty(client,'requestRaw',{value:async(method:string,p:Record<string,unknown>)=>{if(method==='authority.grant.retire'&&refuseOperationRetirement)throw new Error('Original process is not stopped');return method==='authority.grant.issue'?{grant_id:p.grantId,kernel_epoch:'epoch',thread_id:p.threadId,run_id:p.runId,operation_id:p.operationId,capabilities:p.capabilities,path_scopes:p.pathScopes}:{retired:true};}});
 const run=await client.issueGrant({grantId:'run-source',threadId:'child',runId:'child-run',capabilities:['storage.read'],pathScopes:['']});
 const job=await client.issueGrant({grantId:'job-source',threadId:'child',runId:'child-run',operationId:'job-op',capabilities:['storage.read'],pathScopes:['']});
 assert.equal(job.operationId,'job-op');assert.equal(job.runId,'child-run');
 const pending=Reflect.get(client,'pending') as Map<string,unknown>;
 pending.set('run-read',{grantId:run.grantId,cancel:()=>cancelled.push('run')});pending.set('capture',{grantId:job.grantId,cancel:()=>cancelled.push('job')});
 await client.retireRunGrants('child-run');assert.deepEqual(cancelled,['run']);
 refuseOperationRetirement=true;await assert.rejects(client.retireOperationGrants(job.operationId!),/not stopped/);assert.deepEqual(cancelled,['run']);refuseOperationRetirement=false;
 await client.retireOperationGrants('different-operation');assert.deepEqual(cancelled,['run']);
 await client.retireOperationGrants(job.operationId!);assert.deepEqual(cancelled,['run','job']);
});
