import assert from 'node:assert/strict';
import { it, vi } from 'vitest';
import { createResearchArtifactObserver } from './research-artifact-followups.js';
import type { FollowupResearchWork, FollowupLogObserveParams, FollowupLogState } from './protocol.generated.js';
import type { KernelClient } from './kernel-client.js';
import type { ExperimentService } from '../harness/experiments.js';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture(bytes: Buffer, literal='aba', maxBytes=65536) {
  const source = {workspace_id:'workspace',execution_workspace_id:'execution',mode:'fixed_branch' as const,branch_id:'fixed',revision:1,live_root:null};
  const binding = {operationId:'accepted',executionOwner:{kind:'external' as const,identity:'research.experiment',epoch:'original'},domain:'research.experiment',domainVersion:1,subject:{kind:'workspace' as const,workspaceId:'workspace',subjectId:'attempt'}};
  let cursor:FollowupLogState={offset:0,matched_prefix:0,ended:false,failure_code:null},revision=1,active=true;
  let reads=0,details=0,loseAck=false;
  let held:Promise<void>|undefined;let entered=()=>{};
  const errors:unknown[]=[],facts:FollowupLogObserveParams[]=[];
  let wake=()=>{};
  const work=():FollowupResearchWork=>({key:{followupId:'log',generation:1,sourceIndex:0,definitionRevision:revision,ownerEpoch:1},binding,observer:{rootThreadId:'root',threadId:'child',branchId:'branch',sourceRunId:'run',source,canSubmit:true,readThreadIds:['root','child'],controlThreadIds:['child']},source:{kind:'log_literal',operation_id:binding.operationId,stream:'stdout',from_offset:0,literal_bytes:Buffer.byteLength(literal)},log:{...cursor}});
  const kernel={agentRuntimeRequest:async(method:string,input:unknown)=>{
    if(method==='runtime.followup.research')return {works:active&&!cursor.ended&&!cursor.failure_code?[work()]:[],nextCursor:null};
    if(method==='runtime.followup.get'){details++;return {followup:{generation:1,trigger:work().source},instruction:'inspect',registration_trigger:{kind:'log_literal',operationId:binding.operationId,stream:'stdout',literal}};}
    if(method==='runtime.followup.log.observe'){
      const p=input as FollowupLogObserveParams;
      if(!active||p.key.definitionRevision!==revision||JSON.stringify(p.expected)!==JSON.stringify(cursor))return {accepted:false};
      cursor={...p.next};if(p.evidence)facts.push(p);wake();
      if(loseAck&&p.evidence){loseAck=false;throw new Error('committed acknowledgement lost');}
      return {accepted:true};
    }
    throw new Error(method);
  }} as unknown as KernelClient;
  const experiments={readLogObservation:async(caller: {access:unknown},_binding:unknown,input:{offset:number},signal:AbortSignal)=>{
    assert.deepEqual(caller.access,{kind:'family',readThreadIds:['root','child'],controlThreadIds:[]});
    reads++;entered();if(held)await held;signal.throwIfAborted();
    const next=Math.min(bytes.length,input.offset+maxBytes);
    return {bytes:bytes.subarray(input.offset,next),offset:input.offset,nextOffset:next,publishedBytes:bytes.length,eof:next===bytes.length,jobRevision:3,attemptRevision:4};
  }} as unknown as ExperimentService;
  const observer=createResearchArtifactObserver({kernel,experiments,onError:e=>errors.push(e),onAccepted:async()=>{}});
  wake=()=>{void observer.reconcile().catch(e=>errors.push(e));};
  return {observer,facts,errors,get cursor(){return cursor;},get reads(){return reads;},get details(){return details;},lose(){loseAck=true;},pause(){active=false;revision++;wake();},resume(){active=true;revision++;wake();},hold(p:Promise<void>,fn:()=>void){held=p;entered=fn;}};
}
it('drains all original pages and overlapping matches, retaining committed progress across a lost acknowledgement',async()=>{
  const f=fixture(Buffer.from('x'.repeat(65535)+'ababa'));
  f.lose();try {await f.observer.reconcile();await vi.waitFor(()=>assert.equal(f.cursor.ended,true));
    assert.deepEqual(f.facts.map(p=>p.evidence&&p.evidence.kind==='log_literal'?p.evidence.start_offset:null),[65535,65537]);
    assert.equal(f.cursor.offset,65540);assert.ok(f.reads>=3);assert.equal(f.details,2); // Revalidate the original intent after the lost cursor acknowledgement.
    assert.equal(f.errors.length,1);
  }finally{await f.observer.dispose();}
});
it('rejects a held page after pause and resumes from the unconsumed original byte cursor',async()=>{
  const f=fixture(Buffer.from('ababa'));const entered=deferred(),release=deferred();f.hold(release.promise,entered.resolve);
  try {const pending=f.observer.reconcile();await entered.promise;f.pause();release.resolve();await pending;
    assert.equal(f.cursor.offset,0);assert.equal(f.facts.length,0);const reads=f.reads;
    f.resume();await f.observer.reconcile();assert.equal(f.facts.length,2);assert.ok(f.reads>reads);assert.equal(f.cursor.ended,true);
  }finally{release.resolve();await f.observer.dispose();}
});
it('keeps literal EOF without match as exhaustion progress rather than an invented match',async()=>{
  const f=fixture(Buffer.concat([Buffer.from([0xff]),Buffer.from('other')]),'\ufffd',1);
  try {await f.observer.reconcile();assert.equal(f.cursor.ended,true);assert.equal(f.cursor.offset,6);assert.equal(f.facts.length,0);assert.deepEqual(f.errors,[]);}
  finally{await f.observer.dispose();}
});
