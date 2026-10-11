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
