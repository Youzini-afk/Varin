import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpAuthority, McpAuthorityError, McpTaskRequestError, type McpAuthorityOptions } from '../src/mcp-authority.js';
const signal=new AbortController().signal;
function fixture(support=true){
  const root=mkdtempSync(join(tmpdir(),'varin-mcp-tasks-'));
  writeFileSync(join(root,'mcp.json'),JSON.stringify({mcpServers:{peer:{url:'https://fixture.invalid/mcp',exposure:'direct',auth:{provider:'fixture'}}}}));
  let grant=1, description='original',invalidCreate=false, toolError=false,closed=0;
  const sent:Array<Record<string,unknown>>=[];
  type Factory=NonNullable<McpAuthorityOptions['createTransport']>;
  let receive:Parameters<ReturnType<Factory>['onMessage']>[0]=()=>{};
  const createTransport:Factory=()=>{
    type Transport=ReturnType<Factory>;
    const listeners=new Set<Parameters<Transport['onMessage']>[0]>();
    receive=value=>{for(const listener of listeners)listener(value);};
    return {async start(){},async close(){closed++;},onMessage(listener){listeners.add(listener);return()=>{listeners.delete(listener);};},onError(){return()=>{};},onClose(){return()=>{};},
      async send(message){
        sent.push(message as unknown as Record<string,unknown>);
        if(!('method'in message)||!('id'in message))return;
        const params=message.params as Record<string,unknown>;
        const reply=(result:unknown)=>receive({jsonrpc:'2.0',id:message.id,result});
        const task=(status='working')=>({taskId:'original-task',status,createdAt:'2026-10-11T00:00:00.000Z',lastUpdatedAt:'2026-10-11T00:00:01.000Z',ttl:null,pollInterval:10});
        switch(message.method){
          case'initialize':return reply({protocolVersion:'2025-11-25',capabilities:{tools:{listChanged:true},...(support?{tasks:{requests:{tools:{call:{}}}}}:{})},serverInfo:{name:'peer',version:'1'}});
          case'tools/list':return reply({tools:['required','optional','forbidden'].map(name=>({name,description,inputSchema:{type:'object'},execution:{taskSupport:name}}))});
          case'tools/call':
            if(toolError){receive({jsonrpc:'2.0',id:message.id,error:{code:-32000,message:'Remote application error',data:{dispatched:false,code:'mcp_permission_denied'}}});return;}
            return reply(params.task?{task:task(invalidCreate?'completed':'working')}:{content:[{type:'text',text:'ordinary'}]});
          case'tasks/get':return reply(task());
          case'tasks/result':return reply({content:[{type:'text',text:'retained result'}],isError:true,_meta:{'io.modelcontextprotocol/related-task':{taskId:params.taskId}}});
          default:throw new Error(`Unexpected method ${message.method}`);
        }
      }};
  };
  const authority=new McpAuthority({createTransport,providerToken:async()=>`token-${grant}`,credentialScope:async()=>({reference:`grant-${grant}`,generation:1})});
  const scope={agentDir:root,configCwd:root,executionCwd:root,environmentId:'host:global',resourceOwner: { kind: 'local' as const }, executionScope:'global' as const,projectTrusted:false,sessionId:'agent:thread'};
  return {authority,scope,sent,closed:()=>closed,changeTool(){description='changed';receive({jsonrpc:'2.0',method:'notifications/tools/list_changed'});},changeGrant(){grant++;},invalidCreate(){invalidCreate=true;},toolError(){toolError=true;},serverRequest(id:string,method:string,params:Record<string,unknown>){receive({jsonrpc:'2.0',id,method,params});},
    async close(){await authority.close();rmSync(root,{recursive:true,force:true});}};
}
test('negotiated Tasks use the original client, preserve real identities and survive the calling lease release',async()=>{
  const f=fixture();try{
    const lease=await f.authority.acquire(f.scope,{servers:['peer']});
    const tools=lease.binding.tools,required=tools.find(tool=>tool.tool==='required')!,optional=tools.find(tool=>tool.tool==='optional')!,forbidden=tools.find(tool=>tool.tool==='forbidden')!;
    const initialization=f.sent.find(value=>value.method==='initialize')!;
    assert.deepEqual((initialization.params as {capabilities:unknown}).capabilities,{tasks:{},roots:{}});
    assert.equal(required.taskSupport,'required');assert.equal(required.taskCapable,true);
    await assert.rejects(lease.callTool(required.name,{}, {schemaVersion:required.schemaVersion,signal}),/mcp-task-required-use-mcp-start-task/);
    assert.equal(f.sent.filter(value=>value.method==='tools/call').length,0);
    await lease.callTool(optional.name,{}, {schemaVersion:optional.schemaVersion,signal});
    assert.equal((f.sent.find(value=>value.method==='tools/call')!.params as Record<string,unknown>).task,undefined);
    const task=await lease.taskOwner('peer',undefined,signal);
    await assert.rejects(task.start(forbidden.tool,{}, {schemaVersion:forbidden.schemaVersion,signal}),/mcp-task-forbidden/);
    const accepted=await task.start(required.tool,{}, {schemaVersion:required.schemaVersion,signal,ttl:1234});
    assert.equal(accepted.task.taskId,'original-task');
    const related={'io.modelcontextprotocol/related-task':{taskId:accepted.task.taskId}};
    f.serverRequest('roots-for-task','roots/list',{_meta:{...related,unrelated:'do not copy'}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual((f.sent.find(value=>value.id==='roots-for-task')!.result as Record<string,unknown>)._meta,related);
    assert.deepEqual((f.sent.filter(value=>value.method==='tools/call').at(-1)!.params as Record<string,unknown>).task,{ttl:1234});
    lease.release();assert.equal(f.closed(),0);
    assert.equal((await task.get('original-task',signal)).task.taskId,'original-task');
    const result=await task.result('original-task',signal);assert.equal(result.isError,true);
    await assert.rejects(task.cancel('original-task',signal),error=>error instanceof McpTaskRequestError&&!error.dispatched&&error.kind==='unsupported');
    assert.equal(f.sent.some(value=>value.method==='tasks/cancel'),false);
    task.release();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.closed(),1);
  }finally{await f.close();}
});
test('tool declaration replacement blocks new calls without stranding an accepted endpoint; a replacement grant never rebinds it',async()=>{
  const f=fixture();try{
    const lease=await f.authority.acquire(f.scope,{servers:['peer']}),tool=lease.binding.tools.find(tool=>tool.tool==='required')!;
    const task=await lease.taskOwner('peer',undefined,signal);
    await task.start(tool.tool,{}, {schemaVersion:tool.schemaVersion,signal});
    f.changeTool();await new Promise(resolve=>setTimeout(resolve,20));
    await assert.rejects(task.start(tool.tool,{}, {schemaVersion:tool.schemaVersion,signal}),/mcp-schema-generation-mismatch/);
    assert.equal((await task.get('original-task',signal)).task.taskId,'original-task');
    const before=f.sent.length;f.changeGrant();
    await assert.rejects(task.get('original-task',signal),error=>error instanceof McpAuthorityError&&!error.dispatched);
    assert.equal(f.sent.length,before);
    task.release();lease.release();
  }finally{await f.close();}
});
test('missing negotiated Tasks, malformed acceptance and remote errors never become empty success or replay',async()=>{
  const no=fixture(false);try{
    const lease=await no.authority.acquire(no.scope,{servers:['peer']}),tool=lease.binding.tools.find(tool=>tool.tool==='optional')!;
    const task=await lease.taskOwner('peer',undefined,signal);
    assert.equal(tool.taskCapable,false);
    await assert.rejects(task.start(tool.tool,{}, {schemaVersion:tool.schemaVersion,signal}),error=>error instanceof McpTaskRequestError&&!error.dispatched);
    assert.equal(no.sent.some(value=>value.method==='tools/call'),false);
    const required=lease.binding.tools.find(tool=>tool.tool==='required')!;
    await lease.callTool(required.name,{}, {schemaVersion:required.schemaVersion,signal});
    assert.equal((no.sent.filter(value=>value.method==='tools/call').at(-1)!.params as Record<string,unknown>).task,undefined);
    task.release();lease.release();
  }finally{await no.close();}
  const f=fixture();try{
    const lease=await f.authority.acquire(f.scope,{servers:['peer']}),tool=lease.binding.tools.find(tool=>tool.tool==='required')!;
    const task=await lease.taskOwner('peer',undefined,signal);f.invalidCreate();
    await assert.rejects(task.start(tool.tool,{}, {schemaVersion:tool.schemaVersion,signal}),error=>error instanceof McpTaskRequestError&&error.dispatched&&error.kind==='protocol');
    assert.equal(f.sent.filter(value=>value.method==='tools/call').length,1);
    f.toolError();await assert.rejects(task.start(tool.tool,{}, {schemaVersion:tool.schemaVersion,signal}),error=>error instanceof McpTaskRequestError&&error.dispatched&&error.rpcCode===-32000);
    assert.equal(f.sent.filter(value=>value.method==='tools/call').length,2);assert.equal(f.sent.some(value=>value.method==='tasks/list'),false);
    task.release();lease.release();
  }finally{await f.close();}
});
