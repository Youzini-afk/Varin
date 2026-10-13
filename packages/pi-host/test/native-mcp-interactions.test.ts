import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamableHttpTransport } from '@earendil-works/pi-mcp';
import { McpAuthority, McpAuthorityError, decodeElicitationRequest, validateElicitationResponse, type McpInteractionRequest, type McpErrorInteraction } from '../src/mcp-authority.js';
import type { McpElicitationResponse } from '@varin/protocol';
const signal = new AbortController().signal;
const form = {message:'Review values',requestedSchema:{type:'object',properties:{flag:{type:'boolean',default:false},count:{type:'integer',minimum:0,default:0},text:{type:'string',pattern:'^x?$',default:''},tags:{type:'array',items:{anyOf:[{const:'a',title:'First'}]},default:[]}},required:['flag','count','text','tags']}};
const urlError = {code:-32042,message:'Review external requirements',data:{elicitations:[{mode:'url',message:'First requirement',elicitationId:'first-error-url',url:'https://flow.invalid/full?one=opaque'},{mode:'url',message:'Second requirement',elicitationId:'second-error-url',url:'https://other.invalid/full?two=opaque'}]},extension:{original:['保留',false,0]}};
const answer = {action:'accept' as const,content:{flag:false,count:0,text:'',tags:['a']}};
test('the sole decoder preserves primitive/enum-array values, pattern and valid defaults without coercion', () => {
  const decoded=decodeElicitationRequest(form); assert.equal(decoded.presentation.mode,'form');
  if(decoded.presentation.mode==='form')assert.deepEqual(decoded.presentation.fields.map(f=>f.default),[false,0,'',[]]);
  assert.deepEqual(validateElicitationResponse(form,answer),answer);
  assert.throws(()=>validateElicitationResponse(form,{action:'accept',content:{...answer.content,flag:'false'}}),{code:'mcp_interaction_response_invalid'});
  assert.throws(()=>validateElicitationResponse(form,{action:'accept',content:{...answer.content,text:'bad'}}),{code:'mcp_interaction_response_invalid'});
  for(const value of [null,{},'false']){
    const invalid={...form,requestedSchema:{...form.requestedSchema,properties:{...form.requestedSchema.properties,flag:{...form.requestedSchema.properties.flag,default:value}}}};
    assert.throws(()=>decodeElicitationRequest(invalid),{code:'mcp_interaction_request_invalid'});
  }
  const invalid=structuredClone(form);invalid.requestedSchema.properties.count.default=-1;
  assert.throws(()=>decodeElicitationRequest(invalid),{code:'mcp_interaction_request_invalid'});
});
type Message={jsonrpc?:'2.0';id?:string|number;method?:string;params?:Record<string,unknown>;result?:unknown;error?:unknown};
async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'varin-mcp-interactions-')),url='https://fixture.invalid/mcp';
  writeFileSync(join(root,'mcp.json'),JSON.stringify({mcpServers:{peer:{url,exposure:'direct'}}}));
  const sent:Message[]=[],streams=new Map<string,{id:string|number;controller:ReadableStreamDefaultController<Uint8Array>}>();
  const inputs:Array<{input:McpInteractionRequest;respond:(v:McpElicitationResponse)=>void;settled:string[]}>=[];
  const errors:Array<{input:McpErrorInteraction;completed:string[];unavailable:string[]}>=[];
  let transports=0,failResponse=false,get:ReadableStreamDefaultController<Uint8Array>|undefined;
  const encode=(message:Message)=>new TextEncoder().encode(`data: ${JSON.stringify({jsonrpc:'2.0',...message})}\n\n`);
  const json=(id:string|number,result:unknown)=>new Response(JSON.stringify({jsonrpc:'2.0',id,result}),{headers:{'content-type':'application/json','mcp-session-id':'original-client'}});
  const fetch=async(_input:string|URL,init?:RequestInit):Promise<Response>=>{
    if(init?.method==='GET')return new Response(new ReadableStream<Uint8Array>({start(c){get=c;}}),{headers:{'content-type':'text/event-stream'}});
    if(init?.method==='DELETE')return new Response(null,{status:202});
    const message=JSON.parse(String(init?.body)) as Message;sent.push(message);
    if(!message.method){if(failResponse)throw new Error('Response transport ACK lost');return new Response(null,{status:202});}
    if(message.id===undefined)return new Response(null,{status:202});
    if(message.method==='initialize')return json(message.id,{protocolVersion:'2025-11-25',capabilities:{tools:{},tasks:{requests:{tools:{call:{}}}}},serverInfo:{name:'peer',version:'1'}});
    if(message.method==='tools/list')return json(message.id,{tools:[{name:'work',inputSchema:{type:'object'},execution:{taskSupport:'optional'}}]});
    if(message.method==='tools/call'){
      const args=message.params?.arguments as Record<string,unknown>;
      if(args.expired)return new Response('expired',{status:404});
      if(args.error==='url'||args.error==='unsafe'){
        const error=structuredClone(urlError);
        if(args.error==='unsafe')error.data.elicitations[0]!.url='javascript:alert(1)';
        if(args.complete)return new Response(new ReadableStream<Uint8Array>({start(controller){
          const frames=[{id:message.id!,error},{method:'notifications/elicitation/complete',params:{elicitationId:'first-error-url'}}];
          const bytes=frames.map(frame=>new TextDecoder().decode(encode(frame))).join('');
          controller.enqueue(new TextEncoder().encode(bytes));controller.close();
        }}),{headers:{'content-type':'text/event-stream'}});
        return new Response(JSON.stringify({jsonrpc:'2.0',id:message.id,error}),{headers:{'content-type':'application/json'}});
      }
      if(args.error)return new Response(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32042,message:'External action required',data:{elicitations:[{url:'https://flow.invalid/full?token=opaque'}]}}}),{headers:{'content-type':'application/json'}});
      return new Response(new ReadableStream<Uint8Array>({start(controller){streams.set(String(args.name),{id:message.id!,controller});}}),{headers:{'content-type':'text/event-stream'}});
    }
    throw new Error(`Unexpected ${message.method}`);
  };
  const authority=new McpAuthority({interactionErrors:input=>{const entry={input,completed:[] as string[],unavailable:[] as string[]};errors.push(entry);for(const item of input.items)item.onComplete(()=>entry.completed.push(item.presentation.elicitationId),()=>entry.unavailable.push(item.presentation.elicitationId));},createTransport:()=>{transports++;return new StreamableHttpTransport({url,fetch});},interactions:input=>new Promise(respond=>{
    const settled:string[]=[];input.onResponseSettled(state=>settled.push(state));inputs.push({input,respond,settled});
  })});
  const scope={agentDir:root,configCwd:root,executionCwd:root,environmentId:'host:global',resourceOwner: { kind: 'local' as const }, executionScope:'global' as const,projectTrusted:false,sessionId:'pi'};
  const emit=(name:string,message:Message)=>streams.get(name)!.controller.enqueue(encode(message));
  return {authority,scope,sent,streams,inputs,errors,transports:()=>transports,failResponse:()=>{failResponse=true;},emit,get:(message:Message)=>get!.enqueue(encode(message)),
    finish(name:string){const stream=streams.get(name)!;emit(name,{id:stream.id,result:{content:[]}});stream.controller.close();},
    async close(){await authority.close();rmSync(root,{recursive:true,force:true});}};
}
async function until(check:()=>boolean){const end=Date.now()+3000;while(!check()){assert.ok(Date.now()<end,'expected original protocol fact');await new Promise(r=>setTimeout(r,1));}}
const origin=(id:string)=>({operationId:id,executionOwner:{kind:'external' as const,identity:'host',epoch:'original'}});
test('Pi-first shared HTTP client associates exact concurrent callers; Task metadata takes precedence and unknown Tasks never fall back',async()=>{
  const f=await fixture();try{
    const pi=f.authority.open(f.scope);await f.authority.connect(pi.scope,pi.config.servers[0]!);
    const a=await f.authority.acquire({...f.scope,sessionId:'thread-a'},{servers:['peer']});
    const b=await f.authority.acquire({...f.scope,sessionId:'thread-b'},{servers:['peer']});
    assert.equal(f.transports(),1);assert.deepEqual((f.sent.find(m=>m.method==='initialize')!.params?.capabilities as {elicitation?:unknown}).elicitation,{form:{},url:{}});
    const tool=a.binding.tools[0]!;
    const callA=a.callTool(tool.name,{name:'a'},{schemaVersion:tool.schemaVersion,signal,interaction:origin('op-a')});
    const callB=b.callTool(tool.name,{name:'b'},{schemaVersion:tool.schemaVersion,signal,interaction:origin('op-b')});
    await until(()=>f.streams.size===2);
    f.emit('a',{id:1.5,method:'elicitation/create',params:form});f.emit('b',{id:'1',method:'elicitation/create',params:form});
    await until(()=>f.inputs.length===2);
    assert.equal(f.inputs[0]!.input.binding.operationId,'op-a');assert.ok(f.inputs[0]!.input.binding.source.kind==='server_request');assert.equal(f.inputs[0]!.input.binding.source.requestId,1.5);
    assert.equal(f.inputs[1]!.input.binding.operationId,'op-b');assert.ok(f.inputs[1]!.input.binding.source.kind==='server_request');assert.equal(f.inputs[1]!.input.binding.source.requestId,'1');
    for(const input of f.inputs)input.respond(answer);
    await until(()=>f.inputs.every(i=>i.settled[0]==='sent'));
    const task=await b.taskOwner('peer',undefined,signal);const unbind=task.bindInteraction!('known-task',origin('accepted-task-b'));
    f.emit('a',{id:'task-b',method:'elicitation/create',params:{...form,_meta:{'io.modelcontextprotocol/related-task':{taskId:'known-task'}}}});
    await until(()=>f.inputs.length===3);assert.equal(f.inputs[2]!.input.binding.operationId,'accepted-task-b');
    f.inputs[2]!.respond({action:'decline'});await until(()=>f.inputs[2]!.settled[0]==='sent');
    f.emit('a',{id:'unknown-task',method:'elicitation/create',params:{...form,_meta:{'io.modelcontextprotocol/related-task':{taskId:'unknown'}}}});
    f.get({id:'unrelated-get',method:'elicitation/create',params:form});
    await until(()=>f.sent.some(m=>m.id==='unknown-task'&&m.error)&&f.sent.some(m=>m.id==='unrelated-get'&&m.error));
    assert.equal(f.inputs.length,3);f.finish('a');f.finish('b');await Promise.all([callA,callB]);
    assert.equal(f.inputs[0]!.input.signal.aborted,true);
    unbind();task.release();a.release();b.release();f.authority.closeScope(pi.scope);
  }finally{await f.close();}
});
test('a failed response send is observed once as unknown, with no second error response; actual remote error stays intact',async()=>{
  const f=await fixture();try{
    const lease=await f.authority.acquire(f.scope,{servers:['peer']}),tool=lease.binding.tools[0]!;
    await assert.rejects(lease.callTool(tool.name,{error:true},{schemaVersion:tool.schemaVersion,signal,interaction:origin('error-op')}),error=>{
      assert.ok(error instanceof McpAuthorityError);assert.equal(error.settlement,'rpc_response');assert.equal(error.protocolError?.code,-32042);assert.deepEqual(error.protocolError?.data,{elicitations:[{url:'https://flow.invalid/full?token=opaque'}]});return true;
    });
    const call=lease.callTool(tool.name,{name:'lost'},{schemaVersion:tool.schemaVersion,signal,interaction:origin('op-lost')});
    await until(()=>f.streams.has('lost'));f.emit('lost',{id:'lost-response',method:'elicitation/create',params:form});await until(()=>f.inputs.length===1);
    f.failResponse();f.inputs[0]!.respond(answer);await until(()=>f.inputs[0]!.settled.length===1);
    assert.deepEqual(f.inputs[0]!.settled,['unknown']);assert.equal(f.sent.filter(m=>m.id==='lost-response').length,1);
    f.finish('lost');await call;
    const beforeCalls=f.sent.filter(m=>m.method==='tools/call').length,beforeInit=f.sent.filter(m=>m.method==='initialize').length;
    await assert.rejects(lease.callTool(tool.name,{expired:true},{schemaVersion:tool.schemaVersion,signal,interaction:origin('expired-op')}),error=>error instanceof McpAuthorityError&&error.settlement==='session_expired');
    assert.equal(f.sent.filter(m=>m.method==='tools/call').length,beforeCalls+1,'HTTP 404 never replays this original finite call');
    assert.equal(f.sent.filter(m=>m.method==='initialize').length,beforeInit,'no hidden reinitialization for the entered call');
    lease.release();
  }finally{await f.close();}
});
test('an accepted URL keeps its original completion watcher after RPC close and releases it when that actual client closes',async()=>{
  const f=await fixture();try{
    const lease=await f.authority.acquire(f.scope,{servers:['peer']}),tool=lease.binding.tools[0]!;
    const call=lease.callTool(tool.name,{name:'url-close'},{schemaVersion:tool.schemaVersion,signal,interaction:origin('url-operation')});
    await until(()=>f.streams.has('url-close'));
    f.emit('url-close',{id:'url-question',method:'elicitation/create',params:{mode:'url',message:'Review full URL',url:'https://flow.invalid/full?state=opaque',elicitationId:'original-external'}});
    await until(()=>f.inputs.length===1);
    let completed=0,unavailable=0;
    const dispose=f.inputs[0]!.input.onComplete(()=>{completed++;},()=>{unavailable++;});
    f.inputs[0]!.respond({action:'accept'});await until(()=>f.inputs[0]!.settled[0]==='sent');
    f.finish('url-close');await call;
    assert.equal(f.inputs[0]!.input.signal.reason,'rpc_closed');assert.equal(unavailable,0);
    await f.authority.close();assert.equal(unavailable,1);assert.equal(completed,0);
    assert.equal(f.sent.filter(m=>m.id==='url-question').length,1);dispose();lease.release();
  }finally{await f.close();}
});

test('real outbound errors register every URL before same-chunk completion and never create protocol replies',async()=>{
  const f=await fixture();try{
    const lease=await f.authority.acquire(f.scope,{servers:['peer']}),tool=lease.binding.tools[0]!;
    await assert.rejects(lease.callTool(tool.name,{error:'url',complete:true},{schemaVersion:tool.schemaVersion,signal,interaction:origin('error-only')}),error=>{
      assert.ok(error instanceof McpAuthorityError);assert.equal(error.settlement,'rpc_response');assert.deepEqual(error.protocolError,urlError);return true;
    });
    await until(()=>f.errors[0]?.completed.length===1);
    assert.equal(f.errors.length,1);assert.equal(f.errors[0]!.input.items.length,2);
    const call=f.sent.find(m=>m.method==='tools/call')!;
    for(const item of f.errors[0]!.input.items)assert.deepEqual(item.binding.source,{kind:'rpc_error',outgoingRequestId:call.id,method:'tools/call',elicitationId:item.presentation.elicitationId});
    assert.deepEqual(f.errors[0]!.completed,['first-error-url']);assert.equal(f.inputs.length,0);
    assert.equal(f.sent.filter(m=>!m.method).length,0);assert.equal(f.sent.filter(m=>m.method==='tools/call').length,1);
    lease.release();
  }finally{await f.close();}
});
test('unsafe error URLs and reused active IDs retain original errors and a local diagnostic without cross-caller cards',async()=>{
  const f=await fixture();try{
    const lease=await f.authority.acquire(f.scope,{servers:['peer']}),tool=lease.binding.tools[0]!;
    const invoke=(value:string,id:string)=>lease.callTool(tool.name,{error:value},{schemaVersion:tool.schemaVersion,signal,interaction:origin(id)});
    await assert.rejects(invoke('unsafe','unsafe'),error=>{
      assert.ok(error instanceof McpAuthorityError);assert.equal(error.interactionProblem,'mcp_url_elicitation_invalid');
      assert.deepEqual(error.protocolError?.extension,urlError.extension);return true;
    });
    assert.equal(f.errors.length,0);
    await assert.rejects(invoke('url','first'));assert.equal(f.errors.length,1);
    await assert.rejects(invoke('url','second'),error=>{
      assert.ok(error instanceof McpAuthorityError);assert.equal(error.interactionProblem,'mcp_elicitation_identity_conflict');assert.deepEqual(error.protocolError,urlError);return true;
    });
    await assert.rejects(invoke('url','third'),error=>{
      assert.ok(error instanceof McpAuthorityError);assert.equal(error.interactionProblem,'mcp_elicitation_identity_conflict');assert.deepEqual(error.protocolError,urlError);return true;
    });
    assert.equal(f.errors.length,1);assert.equal(f.errors[0]!.input.items[0]!.binding.operationId,'first');
    assert.deepEqual(f.errors[0]!.unavailable,['first-error-url','second-error-url']);
    f.get({method:'notifications/elicitation/complete',params:{elicitationId:'first-error-url'}});
    await new Promise(resolve=>setTimeout(resolve,5));assert.deepEqual(f.errors[0]!.completed,[]);lease.release();
  }finally{await f.close();}
});
