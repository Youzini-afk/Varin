import { expect, it, vi } from 'vitest';
import type { McpInteractionRequest } from '@varin/pi-host/mcp-authority';
import type { KernelClient } from './kernel-client.js';
import type { McpInteractionBinding, McpInteractionRecord, McpInteractionView, McpElicitationResponse, KernelMethodParams } from './protocol.generated.js';
import { createMcpInteractionRuntime } from './mcp-interaction-runtime.js';
const binding=(operationId:string):McpInteractionBinding=>({operationId,executionOwner:{kind:'external',identity:'host',epoch:'one'},endpoint:{server:'original',resourceKey:'resource',configurationVersion:'config',credentialVersion:'grant'},connectionId:'actual-client',source:{kind:'server_request',requestId:operationId,relation:{kind:'rpc_response_stream',outgoingRequestId:operationId}}});
function fixture(){
  const records=new Map<string,McpInteractionView>(), attempts:string[]=[];
  let heldOpen:(()=>Promise<void>)|undefined;
  let openReplyLost=false,settleFailures=0,heldChoice:(()=>Promise<void>)|undefined;
  type Method = 'runtime.mcp.interaction.error.open' | 'runtime.mcp.interaction.open' | 'runtime.mcp.interaction.read' | 'runtime.mcp.interaction.pending'
    | 'runtime.mcp.interaction.respond' | 'runtime.mcp.interaction.response.begin' | 'runtime.mcp.interaction.response.settle'
    | 'runtime.mcp.interaction.close' | 'runtime.mcp.interaction.complete';
  type Request = {[M in Method]: [method:M, params:KernelMethodParams[M]]}[Method];
  const request=vi.fn(async(...[method,p]:Request)=>{
    attempts.push(method);const view=records.get('interactionId' in p ? p.interactionId : '');
    switch(method){
      case'runtime.mcp.interaction.open':{
        const record:McpInteractionRecord={id:p.id,revision:1,binding:p.binding,runId:'run',threadId:p.binding.operationId,branchId:'branch',mode:p.mode,availability:'live',choice:null,delivery:'not_started',completionReported:false,problem:null};
        records.set(p.id,{record,request:p.request,presentation:p.presentation,response:null});if(openReplyLost){openReplyLost=false;throw new Error('Open committed; response lost');}return structuredClone(record);
      }
      case'runtime.mcp.interaction.error.open':{
        await heldOpen?.();
        const result=p.items.map(item=>{
          const record:McpInteractionRecord={id:item.id,revision:1,binding:item.binding,runId:'finished-run',threadId:item.binding.operationId,branchId:'branch',mode:'url',availability:'live',choice:null,delivery:null,completionReported:false,problem:null};
          records.set(item.id,{record,request:p.request,presentation:item.presentation,response:null});return structuredClone(record);
        });return result;
      }
      case'runtime.mcp.interaction.read':if(!view)throw new Error('Missing');return structuredClone(view);
      case'runtime.mcp.interaction.pending':return [...records.values()].filter(v=>v.record.availability==='live').map(v=>structuredClone(v.record));
      case'runtime.mcp.interaction.respond':await heldChoice?.();if(!view||view.record.binding.source.kind==='server_request'&&view.record.availability!=='live')throw new Error('Closed');view.record.choice=p.response.action;view.response=p.response;view.record.revision++;return structuredClone(view.record);
      case'runtime.mcp.interaction.response.begin':if(!view||view.record.availability!=='live')throw new Error('Closed');view.record.delivery='sending';view.record.revision++;return structuredClone(view.record);
      case'runtime.mcp.interaction.response.settle':view!.record.delivery=p.delivery;view!.record.revision++;if(settleFailures-->0)throw new Error('Settlement committed; response lost');return structuredClone(view!.record);
      case'runtime.mcp.interaction.close':view!.record.availability=p.availability;view!.record.revision++;return structuredClone(view!.record);
      case'runtime.mcp.interaction.complete':view!.record.completionReported=true;view!.record.revision++;return structuredClone(view!.record);
      default:throw new Error(`Unexpected ${method}`);
    }
  });
  const errors:Error[]=[];
  const runtime=createMcpInteractionRuntime({kernel:{agentRuntimeRequest:request} as unknown as KernelClient,runtime:{onReady:()=>()=>{},onEvent:()=>()=>{}},onError:e=>errors.push(e)});
  const receive=(id:string,mode:'form'|'url'='form')=>{
    const controller=new AbortController(), before:Array<()=>void|Promise<void>>=[], settled:Array<(state:'sent'|'unknown'|'not_sent')=>void>=[];
    let complete:(()=>void)|undefined,unavailable:(()=>void)|undefined;
    const input:McpInteractionRequest={binding:binding(id),request:mode==='form'?{message:'Review',requestedSchema:{type:'object',properties:{flag:{type:'boolean'}},required:['flag']}}:{mode:'url',message:'Review',url:'https://flow.invalid/full?state=opaque',elicitationId:id},signal:controller.signal,assertLive:async()=>{controller.signal.throwIfAborted();},beforeResponse:fn=>{before.push(fn);},onResponseSettled:fn=>{settled.push(fn);},onComplete:(fn,lost)=>{complete=fn;unavailable=lost;return()=>{};}};
    const response=runtime.receiver(input);void response.catch(()=>{});
    return {controller,response,before,settled,complete:()=>complete!(),unavailable:()=>unavailable!(),view:()=>[...records.values()].find(v=>v.record.binding.operationId===id)!};
  };
  return {runtime,receive,request,attempts,records,errors,loseOpen(){openReplyLost=true;},failSettle(n:number){settleFailures=n;},holdChoice(fn:()=>Promise<void>){heldChoice=fn;},holdOpen(fn:()=>Promise<void>){heldOpen=fn;}};
}
it('reconciles an open reply loss and retries only the known settlement after ACK loss, with no repeated answer',async()=>{
  const f=fixture();f.loseOpen();f.failSettle(1);const peer=f.receive('original');
  try{
    await vi.waitFor(()=>expect(peer.view()).toBeDefined());
    const view=peer.view(),response:McpElicitationResponse={action:'accept',content:{flag:false}};
    await f.runtime.respond({operationId:'original',interactionId:view.record.id,expectedRevision:1,response});expect(await peer.response).toEqual(response);
    for(const fn of peer.before)await fn();for(const fn of peer.settled)fn('sent');
    await vi.waitFor(()=>expect(f.attempts.filter(m=>m==='runtime.mcp.interaction.response.settle')).toHaveLength(2),{timeout:2000});expect(f.errors).toHaveLength(1);
    const repeated=await f.runtime.respond({operationId:'original',interactionId:view.record.id,expectedRevision:1,response});expect(repeated.record.delivery).toBe('sent');
    expect(f.attempts.filter(m=>m==='runtime.mcp.interaction.respond')).toHaveLength(1);expect(f.attempts.filter(m=>m==='runtime.mcp.interaction.open')).toHaveLength(1);
  }finally{await f.runtime.dispose();}
});
it('a UI disconnect after durable admission does not retract the original answer',async()=>{
  const f=fixture(),peer=f.receive('original'),ui=new AbortController();let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});f.holdChoice(()=>held);
  try{
    await vi.waitFor(()=>expect(peer.view()).toBeDefined());const view=peer.view();
    const submission=f.runtime.respond({operationId:'original',interactionId:view.record.id,expectedRevision:1,response:{action:'decline'}},ui.signal);
    await vi.waitFor(()=>expect(f.attempts).toContain('runtime.mcp.interaction.respond'));ui.abort();release();
    await submission;expect(await peer.response).toEqual({action:'decline'});expect(peer.controller.signal.aborted).toBe(false);
  }finally{release();await f.runtime.dispose();}
});
it('early URL completion is independent and leaves the original user response live',async()=>{
  const f=fixture(),peer=f.receive('url','url');
  try{
    await vi.waitFor(()=>expect(peer.view()).toBeDefined());await Promise.resolve();peer.complete();
    await vi.waitFor(()=>expect(peer.view().record.completionReported).toBe(true));expect(peer.view().record.choice).toBeNull();
    await f.runtime.respond({operationId:'url',interactionId:peer.view().record.id,expectedRevision:peer.view().record.revision,response:{action:'accept'}});
    expect(await peer.response).toEqual({action:'accept'});for(const fn of peer.before)await fn();for(const fn of peer.settled)fn('sent');
    await vi.waitFor(()=>expect(peer.view().record.delivery).toBe('sent'));
  }finally{await f.runtime.dispose();}
});

it('loss of the actual URL client after rpc_closed only closes completion availability',async()=>{
  const f=fixture(),peer=f.receive('url-loss','url');
  try{
    await vi.waitFor(()=>expect(peer.view()).toBeDefined());
    await f.runtime.respond({operationId:'url-loss',interactionId:peer.view().record.id,expectedRevision:1,response:{action:'accept'}});
    expect(await peer.response).toEqual({action:'accept'});
    for(const fn of peer.before)await fn();for(const fn of peer.settled)fn('sent');
    await vi.waitFor(()=>expect(peer.view().record.delivery).toBe('sent'));
    peer.controller.abort('rpc_closed');
    await vi.waitFor(()=>expect(peer.view().record.availability).toBe('rpc_closed'));
    peer.unavailable();
    await vi.waitFor(()=>expect(peer.view().record.availability).toBe('connection_lost'));
    expect(peer.view().record).toMatchObject({choice:'accept',delivery:'sent',completionReported:false});
    expect(f.attempts.filter(m=>m==='runtime.mcp.interaction.respond')).toHaveLength(1);
  }finally{await f.runtime.dispose();}
});

it('error-source uses one asynchronous body publication, preserves early completion, and records historical local choice with no SDK sender',async()=>{
  const f=fixture();let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});f.holdOpen(()=>held);
  const error={code:-32042,message:'Original error',data:{elicitations:[] as unknown[]},unrelated:{large:'完整'.repeat(1000)}};
  const completions:Array<()=>void>=[],invalidations:Array<()=>void>=[],released:number[]=[];
  const items=[0,1].map(index=>{
    const presentation={mode:'url' as const,message:`Website ${index}`,url:`https://flow.invalid/full?id=${index}`,elicitationId:`error-${index}`};error.data.elicitations.push(presentation);
    return{binding:{...binding('original'),source:{kind:'rpc_error' as const,outgoingRequestId:17,method:'tools/call',elicitationId:presentation.elicitationId}},presentation,
      signal:new AbortController().signal,assertLive:vi.fn(async()=>{throw new Error('Must not ask an old RPC to become live');}),
      onComplete(complete:()=>void,unavailable?:()=>void){completions.push(complete);invalidations.push(unavailable!);return()=>{released.push(index);};}};
  });
  try{
    f.runtime.errorReceiver({request:error,items});expect(completions).toHaveLength(2);expect(f.records.size).toBe(0);
    completions[0]!();invalidations[1]!();release();
    await vi.waitFor(()=>expect([...f.records.values()].map(v=>[v.record.completionReported,v.record.availability])).toEqual([[true,'live'],[false,'connection_lost']]));
    expect(f.attempts.filter(x=>x==='runtime.mcp.interaction.error.open')).toHaveLength(1);
    const closed=[...f.records.values()][1]!;
    const response=await f.runtime.respond({operationId:'original',interactionId:closed.record.id,expectedRevision:closed.record.revision,response:{action:'accept'}});
    expect(response.record.delivery).toBeNull();expect(response.response).toEqual({action:'accept'});expect(response.request).toEqual(error);
    expect(f.attempts.some(x=>x==='runtime.mcp.interaction.response.begin'||x==='runtime.mcp.interaction.response.settle')).toBe(false);
    for(const item of items)expect(item.assertLive).not.toHaveBeenCalled();expect(released).toContain(1);
  }finally{release();await f.runtime.dispose();}
});
