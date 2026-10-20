import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpAuthority } from '../mcp/authority.js';
import { createMcpLease } from './mcp-owner.js';
import { permissionService } from './permission-service.js';
import { MCP_CAPABILITIES, type HostToolCall } from './protocol.generated.js';
import type { KernelClient } from './kernel-client.js';
import type { McpTaskRuntime } from './mcp-task-runtime.js';
import { KernelRequestError } from './kernel-error.js';

describe('Task management tools use original permission admission',()=>{
  for(const action of ['get','wait','cancel'] as const)it(`${action} obeys explicit deny, one-shot ask and policy changes`,async()=>{
    const root=await mkdtemp(join(tmpdir(),'varin-task-permission-')),authority=new McpAuthority();
    const schema=MCP_CAPABILITIES.find(entry=>entry.route.kind==='task_control'&&entry.route.action===action)!;
    let decision:'deny'|'ask'='deny',controls=0,opened=0,consumed=0,missing=false;
    const decisions:Promise<unknown>[]=[];
    const kernel={subscribeExit(){return()=>{};},async agentRuntimeRequest(method:string,params:Record<string,unknown>){
      if(method==='runtime.host_job.access'){
        if(missing)throw new KernelRequestError({code:'not-found',message:'not found: missing-job'},method,'response');
        return{id:'original-job'};
      }
      if(method==='runtime.permission.open'){
        opened++;
        queueMicrotask(()=>{decisions.push(permissionService(kernel).decide(String(params.operationId),String(params.permissionId),'allow_once'));});
        return{};
      }
      if(method==='runtime.permission.decide')return{id:params.operationId};
      if(method==='runtime.permission.consume'){consumed++;return{};}
      throw new Error(`Unexpected method ${method}`);
    }} as unknown as KernelClient;
    const tasks={async control(){controls++;return{executor_stopped:true,completion:{kind:'result',outcome:'succeeded',effect:'none',content:{data:{},parts:[]}}};}} as unknown as McpTaskRuntime;
    const lease=createMcpLease({lease:await authority.acquire({resourceOwner:{kind:'local'},agentDir:root,configCwd:root,executionCwd:root,executionScope:'global',environmentId:'host:global',projectTrusted:false,sessionId:'agent:reader'},{servers:[]}),
      kernel,tasks,currentPolicy:async()=>({mode:'normal',rules:[{tool:schema.name,decision}]})});
    const call:HostToolCall={runId:'reader-run',origin:{kind:'model_step',request_id:'reader-step'},operationId:'reader-call',callId:'reader-call',name:schema.name,schemaVersion:schema.version,arguments:{operationId:'original-job'}};
    const signal=new AbortController().signal,owner={kind:'external' as const,identity:'original-host',epoch:'owner'};
    try{
      await expect(lease.authorize(call,signal)).rejects.toThrow('mcp_permission_denied');
      expect(controls).toBe(0);expect(opened).toBe(0);
      decision='ask';await lease.authorize(call,signal);await lease.authorize(call,signal);
      expect(opened).toBe(1);expect(consumed).toBe(1);
      decision='deny';expect((await lease.execute(call,signal,owner)).completion.kind).toBe('not_dispatched');expect(controls).toBe(0);
      decision='ask';const next={...call,operationId:'second-call',callId:'second-call'};
      await lease.authorize(next,signal);await lease.execute(next,signal,owner);
      expect(opened).toBe(2);expect(consumed).toBe(2);expect(controls).toBe(1);
      missing=true;
      await expect(lease.authorize({...call,operationId:'missing-call',callId:'missing-call',arguments:{operationId:'missing-job'}},signal))
        .rejects.toMatchObject({code:'mcp_task_not_found',message:'No MCP task exists for operationId missing-job.'});
      expect(opened).toBe(2);expect(controls).toBe(1);
      await Promise.all(decisions);
    }finally{lease.release();await authority.close();await rm(root,{recursive:true,force:true});}
  });
});
