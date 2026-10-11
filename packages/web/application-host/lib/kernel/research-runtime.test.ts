import assert from 'node:assert/strict';
import { it } from 'vitest';
import { createResearchRuntime } from './research-runtime.js';
import { decodeResearchParams } from './research-params.js';
import type { HostJobPending, ResearchScope } from './protocol.generated.js';
import type { KernelClient } from './kernel-client.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ExperimentService } from '../harness/experiments.js';
import type { SourceService } from '../harness/sources.js';
import type { ResourceService } from '../harness/resources.js';

it('research ingress preserves legal empty values and limit zero, and rejects malformed query shape once',()=>{
 assert.equal(decodeResearchParams('list',{limit:0}).limit,0);
 assert.deepEqual(decodeResearchParams('submit',{command:'run',cwd:'',title:'',inputs:[{path:'',role:''}]}),{command:'run',cwd:'',title:'',inputs:[{path:'',role:''}]});
 for(const value of [{limit:-1},{limit:1.5},{limit:'2'},{state:'imaginary'},{caller:{}}])assert.throws(()=>decodeResearchParams('list',value));
 assert.throws(()=>decodeResearchParams('sources',{kind:'imaginary'}));assert.throws(()=>decodeResearchParams('cancel',{attemptId:''}));
});
it('a User admission shields only its own original subject while its Catalog response is in flight',async()=>{
 const source={workspace_id:'ws',execution_workspace_id:'exec',mode:'fixed_branch' as const,branch_id:'source',revision:1,live_root:null};
 const scope:ResearchScope={rootThreadId:'thread',threadId:'thread',branchId:'branch',sourceRunId:'run',source,canSubmit:true,readThreadIds:['thread'],controlThreadIds:['thread']};
 const pending=(id:string):HostJobPending=>({binding:{operationId:id,executionOwner:{kind:'external',identity:'research.experiment',epoch:id},domain:'research.experiment',domainVersion:1,workspaceId:'ws',subjectId:id},runId:'run',accepted:false,cancelRequested:false,phase:'running',executorStopped:false,origin:{kind:'user',key:id}});
 const operations=new Map<string,HostJobPending>([['orphan',pending('orphan')]]),checked:string[]=[];
 let admitted=false;let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
 let receipt:Awaited<ReturnType<ExperimentService['nativeReceipt']>>=null;
 const kernel={agentRuntimeRequest:async(method:string,params:Record<string,unknown>)=>{
    if (method === "runtime.followup.research") return { works: [], nextCursor: null };
  if(method==='runtime.research.scopes')return [scope];
  if(method==='runtime.host_job.user'){operations.set('user',pending('user'));admitted=true;await gate;return pending('user');}
  if(method==='runtime.host_job.begin')return operations.get('user');
  if(method==='runtime.host_job.pending')return [...operations.values()].filter(p=>!p.executorStopped);
  const binding=params.binding as HostJobPending['binding'];const op=operations.get(binding.operationId)!;
  if(method==='runtime.host_job.accept'){op.accepted=true;return structuredClone(op);}
  if(method==='runtime.host_job.terminal'){op.executorStopped=true;op.phase='terminal';return structuredClone(op);}
  throw new Error(method);
 }} as unknown as KernelClient;
 const runtime={run:async()=>({id:'run',thread_id:'thread',branch_id:'branch'}),reconcileObservations:async()=>[]} as unknown as AgentRuntimeClient;
 const experiments={submissionId:()=> 'user',nativeReceipt:async(_ws:string,id:string)=>id==='user'?receipt:null,
  reconcileUnaccepted:async(_caller:unknown,id:string)=>{checked.push(id);return true;},
  submit:async(caller:import('../harness/research-identity.js').ExperimentCaller)=>{
   const accepted={spec:null,attempt:{attemptId:'user',state:'submitted',requestId:'key'},text:'original acceptance'};
   receipt={caller,owner:caller.owner,accepted,attempt:accepted.attempt,executorStopped:false,recordRevision:1} as NonNullable<typeof receipt>;return accepted;
  },
 } as unknown as ExperimentService;
 const errors:Error[]=[];const research=createResearchRuntime({kernel,runtime,experiments,sources:{} as SourceService,resources:{} as ResourceService,onError:e=>errors.push(e)});
 try{
  const submission=research.user.submit({runtime:'agent',threadId:'thread',branchId:'branch',sourceRunId:'run'},{requestId:'key',command:'run'});
  while(!admitted)await new Promise(resolve=>setImmediate(resolve));
  await research.reconcile();assert.deepEqual(checked,['orphan']);assert.equal(operations.get('orphan')!.executorStopped,true);assert.equal(operations.get('user')!.executorStopped,false);
  release();assert.equal((await submission).attempt.requestId,'key');assert.equal(operations.get('user')!.accepted,true);assert.deepEqual(errors,[]);
 }finally{release();await research.dispose();}
});


it.each([false, true])('original subscriptions precede recheck and preserve one accepted Job when already stopped is %s', async initiallyStopped => {
  const binding: HostJobPending['binding'] = { operationId: 'user-job:early', executionOwner: { kind: 'external', identity: 'research.experiment', epoch: 'original' }, domain: 'research.experiment', domainVersion: 1, workspaceId: 'ws', subjectId: 'attempt:early' };
  const job: HostJobPending = { binding, runId: 'completed-source-run', accepted: false, cancelRequested: false, phase: 'running', executorStopped: false, origin: { kind: 'user', key: 'early' } };
  const source = { workspace_id: 'ws', execution_workspace_id: 'exec', mode: 'fixed_branch' as const, branch_id: 'fixed', revision: 1, live_root: null };
  const actor = { runtime: 'agent' as const, actor: { kind: 'user' as const, key: 'early' }, rootThreadId: 'thread', threadId: 'thread', branchId: 'branch', runId: job.runId, operationId: binding.operationId, executionOwner: binding.executionOwner, source };
  const accepted = { spec: null, attempt: { attemptId: binding.subjectId, state: 'submitted' }, text: 'original acceptance' };
  let stopped = initiallyStopped;
  const calls: string[] = [];
  let attemptWake: (() => void) | undefined; let eventWake: (() => void) | undefined;
  let observations = 0; let submits = 0;
  const kernel = { agentRuntimeRequest: async (method: string, params: Record<string, unknown>) => {
    if (method === "runtime.followup.research") return { works: [], nextCursor: null };
    calls.push(method);
    if (method === 'runtime.host_job.pending') { assert.ok(attemptWake && eventWake, 'subscribe before first snapshot'); return job.executorStopped ? [] : [structuredClone(job)]; }
    assert.deepEqual(params.binding, binding);
    if (method === 'runtime.host_job.accept') { assert.deepEqual(params.content, accepted); job.accepted = true; eventWake!(); return structuredClone(job); }
    if (method === 'runtime.host_job.terminal') { assert.equal(params.executorStopped, true); assert.equal((params.content as { attempt: { collectionState: string } }).attempt.collectionState, 'pending'); job.phase = 'terminal'; job.executorStopped = true; eventWake!(); return structuredClone(job); }
    throw new Error(`Unexpected operation: ${method}`);
  } } as unknown as KernelClient;
  const runtime = { onReady: () => () => {}, onEvent: (fn: () => void) => { eventWake = fn; return () => { eventWake = undefined; }; }, reconcileObservations: async () => { observations++; return []; } } as unknown as AgentRuntimeClient;
  const experiments = { subscribeAttempts: (fn: () => void) => { attemptWake = fn; return () => { attemptWake = undefined; }; },
    nativeReceipt: async () => ({ caller: { workspaceId: 'ws' }, owner: actor, accepted, attempt: { attemptId: binding.subjectId, state: 'completed', collectionState: 'pending', cancelRequested: false }, executorStopped: stopped }),
    submit: async () => { submits++; assert.fail('reconciliation cannot resubmit'); },
  } as unknown as ExperimentService;
  const errors: Error[] = [];
  let research = createResearchRuntime({ kernel, runtime, experiments, sources: {} as SourceService, resources: {} as ResourceService, onError: error => errors.push(error) });
  try {
    research.start(); await research.reconcile();
    assert.equal(job.accepted, true); assert.equal(job.executorStopped, initiallyStopped); assert.equal(observations, initiallyStopped ? 1 : 0);
    // Domain completion is not enough. Only its actual drained executor receipt wakes the original stop consumer.
    stopped = true; attemptWake!(); await research.reconcile();
    assert.equal(job.executorStopped, true); assert.equal(observations, 1);
    assert.equal(calls.filter(method => method === 'runtime.host_job.accept').length, 1);
    assert.equal(calls.filter(method => method === 'runtime.host_job.terminal').length, 1);
    await research.dispose();
    research = createResearchRuntime({ kernel, runtime, experiments, sources: {} as SourceService, resources: {} as ResourceService, onError: error => errors.push(error) });
    research.start(); await research.reconcile();
    assert.equal(calls.filter(method => method === 'runtime.host_job.terminal').length, 1); assert.equal(submits, 0); assert.deepEqual(errors, []);
  } finally { await research.dispose(); }
});

it('retains accepted original jobs when their domain is unavailable without resubmission or fabricated stop', async () => {
  const binding: HostJobPending['binding'] = { operationId: 'original', executionOwner: { kind: 'external', identity: 'research.experiment', epoch: 'old-owner' }, domain: 'research.experiment', domainVersion: 1, workspaceId: 'ws', subjectId: 'original-attempt' };
  const op: HostJobPending = { binding, runId: 'ended-source', accepted: true, cancelRequested: false, phase: 'running', executorStopped: false, origin: { kind: 'user', key: 'original' } };
  const writes: string[] = [], errors: Error[] = []; let receiptReads = 0;
  const kernel = { agentRuntimeRequest: async (method: string) => {
    if (method === 'runtime.host_job.pending') return [op];
    if (method === 'runtime.followup.research') return { works: [], nextCursor: null };
    writes.push(method); throw new Error('no effect or stop may be manufactured');
  } } as unknown as KernelClient;
  const experiments = { nativeReceipt: async () => { receiptReads++; return null; }, submit: async () => { writes.push('submit'); }, reconcileUnaccepted: async () => { writes.push('reconcile-unaccepted'); } } as unknown as ExperimentService;
  const research = createResearchRuntime({ kernel, runtime: {} as AgentRuntimeClient, experiments, sources: {} as SourceService, resources: {} as ResourceService, onError: error => errors.push(error) });
  try {
    await research.reconcile(); await research.reconcile();
    assert.equal(receiptReads, 2); assert.deepEqual(writes, []); assert.equal(errors.length, 2);
    assert.ok(errors.every(error => /Accepted original experiment subject is unavailable/.test(error.message)));
    assert.equal(op.executorStopped, false); assert.equal(op.accepted, true);
  } finally { await research.dispose(); }
});
