import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createKernelClient } from './kernel-client.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { ContextService } from './context-service.js';
import { readContextPolicy, type ContextPolicySnapshot } from './context-settings.js';
import type { ContextPreparer } from './thread-context.js';
import { waitWithSignal } from '../cancellation.js';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../../..');
const kernelPath=process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository,'kernel/target/release',process.platform==='win32'?'varin-kernel.exe':'varin-kernel');
const buildVersion=(JSON.parse(await fs.readFile(path.join(repository,'package.json'),'utf8')) as {version:string}).version;
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse()) await cleanup();});
function answer(response:ServerResponse,text:string):void {
  response.writeHead(200,{'content-type':'text/event-stream'});
  response.end(`data: ${JSON.stringify({type:'response.completed',response:{output:[{id:crypto.randomUUID(),type:'message',content:[{type:'output_text',text}]}],usage:{input_tokens:12,output_tokens:8}}})}\n\n`);
}
it.each([
  {cancel:false,block:false,fail:false},
  {cancel:true,block:false,fail:false},
  {cancel:false,block:true,fail:false},
  {cancel:true,block:true,fail:false},
  {cancel:false,block:true,fail:true},
  {cancel:false,block:true,fail:false,restart:'completed'},
  {cancel:false,block:true,fail:false,restart:'dispatched'},
])('automatic context preserves ownership and continuation ($cancel, $block, $fail, $restart)',async({cancel,block,fail,restart})=>{
  await fs.access(kernelPath);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-automatic-context-'));
  cleanups.push(()=>fs.rm(root,{recursive:true,force:true}));
  const agentDir=path.join(root,'agent');await fs.mkdir(agentDir);
  await fs.writeFile(path.join(agentDir,'settings.json'),JSON.stringify({compaction:{enabled:true,reserveTokens:4096,keepRecentTokens:1000,
    modelOverrides:{'fixture/fixture-model':{reserveTokens:128,keepRecentTokens:96}}},harness:{context:{backgroundPreparation:true,preparationWaterline:0.5}}}));
  const projectRoot=path.join(root,'untrusted-project');await fs.mkdir(path.join(projectRoot,'.pi'),{recursive:true});
  await fs.writeFile(path.join(projectRoot,'.pi','settings.json'),'untrusted invalid configuration must not be read');
  const main:Array<{body:Record<string,unknown>;response:ServerResponse}>=[];
  const summaries:Array<ServerResponse>=[];
  const summaryBodies:Array<Record<string,unknown>>=[];
  const server=createServer((request,response)=>{
    const chunks:Buffer[]=[];
    request.on('data',(bytes:Buffer)=>chunks.push(bytes));
    request.on('end',()=>{
      const body=JSON.parse(Buffer.concat(chunks).toString()) as Record<string,unknown>;
      if(JSON.stringify(body.input).includes('Produce a faithful continuation summary')) {summaries.push(response);summaryBodies.push(body);}
      else {main.push({body,response});if(main.length===1) answer(response,'ACK: old source read');}
    });
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();if(!address || typeof address==='string') throw new Error('fixture listener missing');
  cleanups.push(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
  const options={hostId:'automatic-context',storageRoot:path.join(root,'kernel'),buildVersion,kernelPath,allowCargoDevRunner:false};
  let child!:ChildProcessWithoutNullStreams;
  let kernel=createKernelClient({...options,spawnProcess:((command,args,input)=>{child=spawn(command,args??[],input??{}) as ChildProcessWithoutNullStreams;return child;}) as typeof spawn});
  cleanups.push(()=>kernel.close());
  let runtime=new AgentRuntimeClient(kernel);
  const context={effectiveSystemPrompt:'BASE_SYSTEM_V1',instructionSources:['fixture:base'],memoryCheckpoint:null};
  const prepare=Object.assign(async()=>context,{main:async()=>context}) as ContextPreparer;
  const policies:ContextPolicySnapshot[]=[];
  const installOwner=()=>{
    const service=new ContextService(runtime,prepare,async()=>{
    const policy=await readContextPolicy({agentDir,projectRoot,projectTrusted:false,modelId:'fixture-model',providerId:'fixture'});
    policies.push(policy);return policy;
    },async runId=>{await runtime.startRun(runId);});
    kernel.setContextOwner(service);return service;
  };
  installOwner();
  let publicationEntered=false;
  if(restart==='completed') {
    runtime.publishContextJob=async(_runId,signal)=>{
      publicationEntered=true;
      await waitWithSignal(new Promise<never>(()=>undefined),signal);
      throw new Error('the old Host publication must not survive its epoch');
    };
  }
  const configuration={providerId:'fixture',providerFamily:'openai-responses',model:'fixture-model',endpoint:`http://127.0.0.1:${address.port}/responses`,allowAnonymous:true,
    credentialEnvironment:null,configurationGeneration:1,maxOutputTokens:256,contextWindowTokens:block?12000:24000};
  const threadId='thread:automatic-context',branchId='branch:automatic-context';
  await runtime.createThread(threadId,branchId);
  const originalText='OLD_EVIDENCE '.repeat(4200);
  const first=await runtime.submit({key:'first',threadId,branchId,expectedHead:null,input:{text:originalText},configuration,initialContext:context});
  await runtime.startRun(first.run_id);
  await expect.poll(async()=>(await runtime.run(first.run_id)).state).toBe('completed');
  expect(policies[0]).toMatchObject({enabled:true,reserveTokens:128,keepRecentTokens:96});
  const original=await runtime.history(branchId);
  const before=await runtime.context(branchId);
  const second=await runtime.submit({key:'second',threadId,branchId,expectedHead:original.at(-1)!.id,input:{text:'Continue the work'},configuration});
  await runtime.startRun(second.run_id);
  await expect.poll(()=>[summaries.length,main.length]).toEqual([1,block?1:2]);
  if(block) {
    await expect.poll(async()=>(await runtime.run(second.run_id)).state).toBe('waiting');
    expect((await runtime.run(second.run_id)).waiting_on).toMatch(/^context-wait:/);
  }
  expect((await runtime.context(branchId))?.id).toBe(before?.id);
  const jobs=await runtime.contextJobs(branchId);expect(jobs).toHaveLength(1);
  expect(jobs[0]!.request.owner_run_id).toBe(second.run_id);
  if(restart) {
    await runtime.enqueue({key:'tail-before-restart',threadId,branchId,mode:'boundary',input:{text:'NEW_TAIL before the Host restart'}});
    answer(summaries[0]!,'PARTIAL_SUMMARY from the first source part');
    await expect.poll(()=>summaries.length).toBe(2);
    expect(JSON.stringify(summaryBodies[1]!.input)).toContain('PARTIAL_SUMMARY');
    expect(JSON.stringify(summaryBodies[1]!.input)).toContain('OLD_EVIDENCE');
    expect((await runtime.context(branchId))?.id).toBe(before?.id);
    if(restart==='completed') {
      answer(summaries[1]!,'COMPACT_SUMMARY from the durable pre-crash output');
      await expect.poll(async()=>(await runtime.run(jobs[0]!.receipt.run_id)).state).toBe('completed');
      await expect.poll(()=>publicationEntered).toBe(true);
    }
    const exited=once(child,'exit');expect(child.kill('SIGKILL')).toBe(true);await exited;
    await kernel.close();
    kernel=createKernelClient(options);runtime=new AgentRuntimeClient(kernel);
    const service=installOwner();await service.recover();
    if(restart==='completed') {
      await expect.poll(()=>main.length).toBe(2);
      expect(JSON.stringify(main[1]!.body.input)).toContain('COMPACT_SUMMARY');
      expect(JSON.stringify(main[1]!.body.input)).toContain('NEW_TAIL');
      expect(JSON.stringify(main[1]!.body.input)).not.toContain(originalText);
      answer(main[1]!.response,'Completed after restart');
      await expect.poll(async()=>(await runtime.run(second.run_id)).state).toBe('completed');
    } else {
      expect((await runtime.run(second.run_id)).state).toBe('waiting');
      expect((await runtime.run(jobs[0]!.receipt.run_id)).state).toBe('waiting');
      expect(JSON.stringify(await runtime.history(jobs[0]!.receipt.branch_id))).toContain('PARTIAL_SUMMARY');
      await runtime.createThread('thread:independent','branch:independent');
      const independent=await runtime.submit({key:'independent',threadId:'thread:independent',branchId:'branch:independent',expectedHead:null,input:{text:'Independent work'},configuration});
      await runtime.startRun(independent.run_id);await expect.poll(()=>main.length).toBe(2);
      answer(main[1]!.response,'Independent Run completed');
      await expect.poll(async()=>(await runtime.run(independent.run_id)).state).toBe('completed');
      expect((await runtime.run(second.run_id)).state).toBe('waiting');
      expect((await runtime.context(branchId))?.id).toBe(before?.id);
    }
    expect(summaries).toHaveLength(2);
  } else if(cancel) {
    if(block) {
      answer(summaries[0]!,'PARTIAL_SUMMARY before cancellation');
      await expect.poll(()=>summaries.length).toBe(2);
    }
    await runtime.cancelRun(second.run_id);
    await expect.poll(async()=>(await runtime.run(second.run_id)).state).toBe('cancelled');
    await expect.poll(async()=>(await runtime.run(jobs[0]!.receipt.run_id)).state).toBe('cancelled');
    expect((await runtime.context(branchId))?.id).toBe(before?.id);
  } else if(block) {
    if(fail) {
      answer(summaries[0]!,'PARTIAL_SUMMARY before the failed final source part');
      await expect.poll(()=>summaries.length).toBe(2);
      summaries[1]!.writeHead(500,{'content-type':'application/json'});
      summaries[1]!.end(JSON.stringify({error:{message:'summary fixture failed'}}));
      await expect.poll(async()=>(await runtime.run(second.run_id)).state).toBe('failed');
      expect(main).toHaveLength(1);
      expect(summaries).toHaveLength(2);
      expect(JSON.stringify(await runtime.history(jobs[0]!.receipt.branch_id))).toContain('PARTIAL_SUMMARY');
      expect((await runtime.context(branchId))?.id).toBe(before?.id);
    } else {
      await runtime.enqueue({key:'tail-during-wait',threadId,branchId,mode:'boundary',input:{text:'NEW_TAIL during the durable context wait'}});
      answer(summaries[0]!,'PARTIAL_SUMMARY from the first source part');
      await expect.poll(()=>summaries.length).toBe(2);
      expect((await runtime.context(branchId))?.id).toBe(before?.id);
      expect(JSON.stringify(summaryBodies[1]!.input)).toContain('PARTIAL_SUMMARY');
      expect(JSON.stringify(summaryBodies[1]!.input)).toContain('OLD_EVIDENCE');
      answer(summaries[1]!,'COMPACT_SUMMARY for the parked continuation');
      await expect.poll(()=>main.length).toBe(2);
      expect(JSON.stringify(main[1]!.body.input)).toContain('COMPACT_SUMMARY');
      expect(JSON.stringify(main[1]!.body.input)).toContain('NEW_TAIL');
      expect(JSON.stringify(main[1]!.body.input)).not.toContain(originalText);
      answer(main[1]!.response,'Done after the durable wait');
      await expect.poll(async()=>(await runtime.run(second.run_id)).state).toBe('completed');
      expect((await runtime.context(branchId))?.revision).toBe(before!.revision+1);
      expect(summaries).toHaveLength(2);
    }
  } else {
    await runtime.enqueue({key:'new-tail',threadId,branchId,mode:'boundary',input:{text:'NEW_TAIL must survive the background summary'}});
    answer(main[1]!.response,'Second response');
    await expect.poll(()=>main.length).toBe(3);
    expect(summaries).toHaveLength(1);
    expect(JSON.stringify(main[2]!.body.input)).toContain('NEW_TAIL');
    answer(summaries[0]!,'COMPACT_SUMMARY: old evidence was read; continue the pending work.');
    await expect.poll(async()=>(await runtime.context(branchId))?.revision).toBe(before!.revision+1);
    answer(main[2]!.response,'Third response');
    await expect.poll(async()=>(await runtime.run(second.run_id)).state).toBe('completed');
    const history=await runtime.history(branchId);
    const next=await runtime.submit({key:'after-compaction',threadId,branchId,expectedHead:history.at(-1)!.id,input:{text:'Finish using the summary'},configuration});
    await runtime.startRun(next.run_id);
    await expect.poll(()=>main.length).toBe(4);
    expect(JSON.stringify(main[3]!.body.input)).toContain('COMPACT_SUMMARY');
    expect(JSON.stringify(main[3]!.body.input)).toContain('NEW_TAIL');
    expect(JSON.stringify(main[3]!.body.input)).not.toContain(originalText);
    expect(JSON.stringify(main[3]!.body.input)).toContain('BASE_SYSTEM_V1');
    answer(main[3]!.response,'Done');
    await expect.poll(async()=>(await runtime.run(next.run_id)).state).toBe('completed');
  }
  expect((await runtime.history(branchId)).find(item=>item.id===first.input_id)?.content).toEqual({text:originalText});
},30_000);
