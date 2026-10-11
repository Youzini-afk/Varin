import { expect, it, vi } from 'vitest';
import { McpSamplingRejectedError, type McpInteractionRequest } from '@varin/pi-host/mcp-authority';
import { createMcpInteractionRuntime, type SamplingModelSelection } from './mcp-interaction-runtime.js';
import type { KernelClient } from './kernel-client.js';
import type { McpInteractionRecord, McpInteractionView, McpSamplingGeneration } from './protocol.generated.js';

function fixture() {
  let view: McpInteractionView;
  let event = () => {};
  let loseGenerate = false, obscureRejection = false;
  const operations = new Map<string, unknown>();
  let stalePending: McpInteractionView | undefined;
  let loseChoice = false, loseRead = false, loseChoiceRead = false;
  const reads: string[] = [], release = vi.fn();
  const request = vi.fn(async (method: string, p: Record<string, unknown>) => {
    reads.push(method);
    if (method === 'runtime.mcp.interaction.open') {
      const record = {id:p.id, binding:p.binding, mode:'sampling', revision:1,runId:'run',threadId:'thread',branchId:'branch',availability:'live',choice:null,delivery:'not_started',completionReported:false,problem:null,sampling:{generationOperationId:null,review:'request'}} as McpInteractionRecord;
      view = {record,request:p.request as Record<string,unknown>,presentation:{mode:'sampling',message:'Review'},response:null};
      return structuredClone(record);
    }
    if (method === 'runtime.mcp.interaction.pending' && stalePending) return [{...structuredClone(stalePending.record),generation:structuredClone(stalePending.generation)}];
    if (method === 'runtime.mcp.interaction.pending') return view?.record.availability === 'live' ? [{...structuredClone(view.record),generation:structuredClone(view.generation)}] : [];
    if (method === 'runtime.mcp.interaction.inspect') return {...structuredClone(view.record),generation:structuredClone(view.generation)};
    if (method === 'runtime.mcp.interaction.read') {
      expect(Object.keys(p).sort()).toEqual(['interactionId','operationId']);
      if (loseRead) {loseRead=false;throw new Error('Lost reconciliation reply');}
      return structuredClone(view);
    }
    if (method === 'runtime.operation.inspect') return structuredClone(operations.get(String(p.operationId)));
    if (method === 'runtime.mcp.sampling.generate') {
      if(p.expectedRevision !== view.record.revision)throw obscureRejection ? new Error('Transport lost the rejection') : Object.assign(new Error('Native admission conflict'),{code:'operation-error'});
      view.record.sampling = {generationOperationId:`${view.record.id}:generation:${p.expectedRevision}`,review:'request'};
      operations.set(view.record.sampling.generationOperationId!,{id:view.record.sampling.generationOperationId,run_id:'run',intent:{kind:'mcp_sampling_generation_v1',interaction_id:view.record.id,parent_operation_id:p.operationId,request:p.editedRequest,configuration:{...(p.configuration as object),adapterId:null},credential_scope:p.credentialScope}});
      view.sampling={editedRequest:p.editedRequest as Record<string,unknown>,output:null,providerOutput:null,receipt:null,snapshot:null};
      view.generation = {operationId:view.record.sampling.generationOperationId!,phase:'running',outcome:null,cancelRequested:false,dispatch:'started',model:null,usage:{measurement:'missing',inputTokens:null,outputTokens:null,cachedInputTokens:null,cacheWriteTokens:null,reasoningTokens:null,pricingVersion:null},problem:null};
    } else if (method.startsWith('runtime.mcp.sampling.review_')) {
      view.record.choice=p.action as 'accept'|'decline'|'cancel'; view.record.sampling!.review='closed';
      if (loseChoice) {loseChoice=false;loseRead=loseChoiceRead;view.record.revision++;throw new Error('Choice committed, ACK lost');}
    } else if (method === 'runtime.mcp.interaction.close') view.record.availability=p.availability as McpInteractionRecord['availability'];
    else if (method === 'runtime.mcp.interaction.response.begin') view.record.delivery='sending';
    else if (method === 'runtime.mcp.interaction.response.settle') view.record.delivery=p.delivery as McpInteractionRecord['delivery'];
    else throw new Error(`Unexpected ${method}`);
    view.record.revision++;
    if(method==='runtime.mcp.sampling.generate' && loseGenerate){loseGenerate=false;throw new Error('Generation admitted, ACK lost');}
    return structuredClone(view.record);
  });
  const owner=createMcpInteractionRuntime({kernel:{agentRuntimeRequest:request,registerCredentialOwner:async()=>({reference:'reference',authority:'authority',account:'account',generation:1}),unregisterCredentialOwner:release,kernelEpoch:'epoch'} as unknown as KernelClient,runtime:{onReady:()=>()=>{},onEvent:fn=>{event=()=>fn({} as never);return()=>{};}}});
  const controller=new AbortController();
  let before:()=>Promise<void> = async()=>{};
  const input:McpInteractionRequest={binding:{operationId:'parent',executionOwner:{kind:'external',identity:'host',epoch:'one'},endpoint:{server:'server',resourceKey:'resource',configurationVersion:'configuration',credentialVersion:'grant'},connectionId:'actual-client',source:{kind:'server_request',requestId:'request',relation:{kind:'rpc_response_stream',outgoingRequestId:'parent'}}},request:{messages:[],maxTokens:32},signal:controller.signal,assertLive:async()=>controller.signal.throwIfAborted(),beforeResponse:fn=>{before=async()=>{await fn();};},onResponseSettled:()=>{},onComplete:()=>()=>{}};
  const response=owner.samplingReceiver(input);void response.catch(()=>{});
  return {owner,response,controller,request,reads,release,operations,loseGenerate:()=>{loseGenerate=true;},obscureRejection:()=>{obscureRejection=true;},event:()=>event(),stalePending:(previous:McpInteractionView)=>{stalePending=previous;},before:()=>before(),view:()=>view,loseChoice:(andRead=false)=>{loseChoice=true;loseChoiceRead=andRead;}};
}
const identity=(f:ReturnType<typeof fixture>)=>({operationId:'parent',interactionId:f.view().record.id,expectedRevision:f.view().record.revision});
function completed(f:ReturnType<typeof fixture>) {
  f.view().record.sampling={review:'output',generationOperationId:'generation'};
  f.view().generation={operationId:'generation',phase:'terminal',outcome:'succeeded',cancelRequested:false,dispatch:'completed',model:null,usage:{measurement:'actual',inputTokens:1,outputTokens:1,cachedInputTokens:null,cacheWriteTokens:null,reasoningTokens:null,pricingVersion:null},problem:null} satisfies McpSamplingGeneration;
  f.view().sampling={editedRequest:{messages:[],maxTokens:32},output:{role:'assistant',model:'chosen',content:{type:'text',text:'Original'}},providerOutput:{raw:'retained'},receipt:{usable:true},snapshot:{}};
}
it('reconciles the original sampling output choice ACK without another review or wire answer',async()=>{
  const f=fixture();
  try {
    await vi.waitFor(()=>expect(f.view()).toBeDefined());completed(f);f.loseChoice();const p={...identity(f),action:'accept' as const};
    await f.owner.reviewOutput(p);expect(await f.response).toEqual(f.view().sampling!.output);await f.before();
    await f.owner.reviewOutput(p);
    expect(f.reads.filter(m=>m==='runtime.mcp.sampling.review_output')).toHaveLength(1);
    expect(f.view().record.delivery).toBe('sending');
  } finally {await f.owner.dispose();}
});
it('a retry after both choice and reconciliation ACK loss releases only the original approved receipt',async()=>{
  const f=fixture();
  try {
    await vi.waitFor(()=>expect(f.view()).toBeDefined());completed(f);f.loseChoice(true);const p={...identity(f),action:'accept' as const};
    await expect(f.owner.reviewOutput(p)).rejects.toThrow('Lost reconciliation reply');
    await f.owner.reviewOutput(p);expect(await f.response).toEqual(f.view().sampling!.output);await f.before();
    expect(f.reads.filter(m=>m==='runtime.mcp.sampling.review_output')).toHaveLength(1);
  } finally {await f.owner.dispose();}
});
it('request decline ACK loss preserves reviewed error response admission',async()=>{
  const f=fixture();
  try {
    await vi.waitFor(()=>expect(f.view()).toBeDefined());f.loseChoice();
    await f.owner.reviewRequest({...identity(f),action:'decline'});
    await expect(f.response).rejects.toBeInstanceOf(McpSamplingRejectedError);await f.before();
    expect(f.view().record.availability).toBe('live');expect(f.view().record.delivery).toBe('sending');
  } finally {await f.owner.dispose();}
});
it('closed interactions retain a lease only until their exact generation stops, using short inspection',async()=>{
  const f=fixture();
  try {
    await vi.waitFor(()=>expect(f.view()).toBeDefined());f.owner.start();
    const model={configuration:{providerFamily:'openai-responses',model:'chosen',configurationGeneration:1},credentialOwner:{scope:async()=>({reference:'reference',authority:'authority',account:'account',generation:1})}} as unknown as SamplingModelSelection;
    await f.owner.reviewRequest({...identity(f),action:'generate',editedRequest:{messages:[],maxTokens:32}},model);
    f.controller.abort('cancelled');
    await vi.waitFor(()=>expect(f.view().record.availability).toBe('cancelled'));expect(f.release).not.toHaveBeenCalled();
    f.reads.length=0;f.view().generation!.phase='terminal';f.event();
    await vi.waitFor(()=>expect(f.release).toHaveBeenCalledOnce());
    expect(f.reads).toContain('runtime.mcp.interaction.inspect');expect(f.reads).not.toContain('runtime.mcp.interaction.read');
  } finally {await f.owner.dispose();}
});

it('a stale terminal projection cannot release a different generation credential lease',async()=>{
  const f=fixture();
  try {
    await vi.waitFor(()=>expect(f.view()).toBeDefined());f.owner.start();
    const model={configuration:{providerFamily:'openai-responses',model:'chosen',configurationGeneration:1},credentialOwner:{scope:async()=>({reference:'reference',authority:'authority',account:'account',generation:1})}} as unknown as SamplingModelSelection;
    await f.owner.reviewRequest({...identity(f),action:'generate',editedRequest:{messages:[],maxTokens:32}},model);
    f.view().generation!.phase='terminal';f.view().generation!.dispatch='not_started';f.view().record.revision++;
    const old=structuredClone(f.view());
    await f.owner.reviewRequest({...identity(f),action:'generate',editedRequest:{messages:[],maxTokens:16}},model);
    expect(f.release).toHaveBeenCalledTimes(1);
    f.stalePending(old);f.event();
    await vi.waitFor(()=>expect(f.reads.filter(m=>m==='runtime.mcp.interaction.pending').length).toBeGreaterThan(2));
    expect(f.release).toHaveBeenCalledTimes(1);
  } finally {await f.owner.dispose();}
});

it('a lost generation ACK requires the original complete configuration and credential scope',async()=>{
 const f=fixture();
 try {
  await vi.waitFor(()=>expect(f.view()).toBeDefined());
  const model={configuration:{providerFamily:'openai-responses',model:'chosen',configurationGeneration:1},credentialOwner:{scope:async()=>({reference:'reference',authority:'authority',account:'account',generation:1})}} as unknown as SamplingModelSelection;
  const p={...identity(f),action:'generate' as const,editedRequest:{messages:[],maxTokens:32}};
  f.loseGenerate();await f.owner.reviewRequest(p,model);
  expect(f.reads).toContain('runtime.operation.inspect');expect(f.operations.size).toBe(1);
  f.view().generation!.phase='terminal';f.obscureRejection();
  await expect(f.owner.reviewRequest(p,{...model,configuration:{...model.configuration,model:'other'}})).rejects.toMatchObject({code:'mcp_interaction_conflict'});
  expect(f.operations.size).toBe(1);
 } finally {await f.owner.dispose();}
});
it('a definite same-revision model conflict stays rejected after the original lease retires',async()=>{
 const f=fixture();
 try {
  await vi.waitFor(()=>expect(f.view()).toBeDefined());
  const model={configuration:{providerFamily:'openai-responses',model:'chosen',configurationGeneration:1},credentialOwner:{scope:async()=>({reference:'reference',authority:'authority',account:'account',generation:1})}} as unknown as SamplingModelSelection;
  const p={...identity(f),action:'generate' as const,editedRequest:{messages:[],maxTokens:32}};
  await f.owner.reviewRequest(p,model);f.view().generation!.phase='terminal';
  await expect(f.owner.reviewRequest(p,{...model,configuration:{...model.configuration,model:'other'}})).rejects.toMatchObject({code:'operation-error'});
  expect(f.reads).not.toContain('runtime.operation.inspect');expect(f.operations.size).toBe(1);expect(f.release).toHaveBeenCalledTimes(2);
 } finally {await f.owner.dispose();}
});
