import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createDocumentAuthority } from '../documents/authority.js';
import { createAuthorityTestRuntime } from './authority.test-helper.js';
import { IntegrationCoordinator } from '../harness/working-state/integration-coordinator.js';
import { captureCodeSelection, acknowledgedCode, codeIntegration, type CodeParticipant, type ExchangeScope } from './code-exchange.js';
import type { ToolInvocationAuthority } from './tool-invocation.js';
import type { CodeSelection } from './code-exchange.js';
import type { LaunchSource } from './protocol.generated.js';
import type { DelegatedExecution } from './protocol.generated.js';
import { captureContinuationStage, prepareRefreshedContinuationSourceStore } from './child-source-store.js';

it('exchanges fixed selected changes repeatedly, preserves receiver edits, and replays the original receipt', async () => {
  // Admitted source roots use real paths; Windows TEMP may contain a short-name alias.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'varin-code-exchange-')));
  const sender = path.join(root,'sender'), receiver=path.join(root,'receiver'), dataDir=path.join(root,'data');
  await fs.mkdir(sender); await fs.mkdir(receiver);
  const original='sender=0\n\nreceiver=0\n';
  await fs.writeFile(path.join(sender,'shared.txt'),original);
  await fs.writeFile(path.join(receiver,'shared.txt'),original);
  const documents=createDocumentAuthority({hostId:'code-exchange-review',dataDir,isAllowedRoot:async()=>true,isTrusted:async()=>true});
  const owning=await documents.resolveWorkspace({path:receiver});
  const execution=await documents.resolveWorkspace({path:sender});
  const native=await createAuthorityTestRuntime({documents,hostId:'code-exchange-review',dataDir});
  const signal=new AbortController().signal;
  const coordinator=new IntegrationCoordinator({workingStates:native.workingStates});
  const source={mode:'materialized' as const,resource_owner:{kind:'local' as const},workspace_id:owning.workspaceId,
    execution_workspace_id:execution.workspaceId,branch_id:'source-baseline',revision:0,live_root:null};
  const makeMember=(threadId:string,runId:string,physicalSource:LaunchSource):CodeParticipant=>({member:{threadId,agentId:threadId,name:threadId,
    parentThreadId:null,task:null,state:'running',branches:[]},runId,branchId:`branch:${threadId}`,source:physicalSource,launch:{} as CodeParticipant['launch']});
  const from=makeMember('sender-agent','sender-run',source);
  const to=makeMember('receiver-agent','receiver-run',{...source,mode:'live_root',branch_id:null,revision:null,
    execution_workspace_id:owning.workspaceId,live_root:{hostId:'code-exchange-review',rootId:'root',canonicalRoot:receiver}});
  const capture=async(key:string,files?:CodeSelection[])=>{
    return native.workingStates.withBranchStore(owning.workspaceId,'exchange-capture',async store=>captureCodeSelection({store,
      operationId:key,workspaceId:owning.workspaceId,directory:sender,baselineBranchId:'source-baseline',baselineRevision:0,
      files:files??['shared.txt'],acknowledged:await acknowledgedCode(store,from.member.threadId,to.member.threadId),signal}),'shared',{executionWorkspace:execution.workspaceId}).catch(error=>{throw new Error(`capture ${key}`,{cause:error});});
  };
  const apply=async(key:string,result:Awaited<ReturnType<typeof capture>>)=>{
    const store=await native.workingStates.withBranchStore(owning.workspaceId,'exchange-view',store=>store);
    const scope:ExchangeScope={store,directory:receiver,documentWorkspaceId:owning.workspaceId,workingStates:native.workingStates,release:async()=>{}};
    const invocation={runId:'sender-run',threadId:from.member.threadId,operationId:key,callId:key,origin:{kind:'model_step',request_id:'exchange-request'},toolName:'submit_code'} as ToolInvocationAuthority;
    const input=codeIntegration(invocation,'branch:sender-agent',from,to,result,scope,signal);
    return coordinator.mergeResult(input).catch(error=>{throw new Error(`apply ${key}`,{cause:error});});
  };
  try {
    await native.workingStates.withBranchStore(owning.workspaceId,'exchange-baseline',async store=>{
      const base=await store.captureDirectory(receiver,['shared.txt']);
      await store.createBranch(owning.workspaceId,'source-baseline',base);
      await store.releaseCapturedStates(base);
    });
    await fs.writeFile(path.join(sender,'shared.txt'),original.replace('sender=0','sender=1'));
    await fs.writeFile(path.join(receiver,'shared.txt'),original.replace('receiver=0','receiver=1'));
    const first=await capture('exchange-one');
    await fs.writeFile(path.join(sender,'shared.txt'),original.replace('sender=0','sender=2'));
    expect((await apply('exchange-one',first)).status).toBe('applied');
    expect(await fs.readFile(path.join(receiver,'shared.txt'),'utf8')).toBe('sender=1\n\nreceiver=1\n');
    expect(await capture('exchange-one')).toMatchObject({root:first.root,resultRevision:first.resultRevision});
    await fs.writeFile(path.join(receiver,'shared.txt'),'sender=1\n\nreceiver=2\n');
    const second=await capture('exchange-two');
    expect((await apply('exchange-two',second)).status).toBe('applied');
    expect(await fs.readFile(path.join(receiver,'shared.txt'),'utf8')).toBe('sender=2\n\nreceiver=2\n');
    await fs.writeFile(path.join(sender,'shared.txt'),'sender=3\n\nreceiver=99\n');
    const fragment=await capture('exchange-fragment',[{path:'shared.txt',before:'sender=2',after:'sender=3'}]);
    expect((await apply('exchange-fragment',fragment)).status).toBe('applied');
    expect(await fs.readFile(path.join(receiver,'shared.txt'),'utf8')).toBe('sender=3\n\nreceiver=2\n');
    await fs.rm(sender,{recursive:true});
    await native.workingStates.withBranchStore(owning.workspaceId,'exchange-retained-result',async store=>{
      const retained=await captureCodeSelection({store,operationId:'exchange-retained',workspaceId:owning.workspaceId,
        baselineBranchId:'source-baseline',baselineRevision:0,fixedSource:{branchId:first.branchId,revision:first.resultRevision},signal});
      const state=retained.pathStates['shared.txt']!;
      expect(state.kind==='regular-file'?(await store.getObject(state.objectHash))?.toString():null).toBe('sender=1\n\nreceiver=0\n');
    });
    await fs.writeFile(path.join(receiver,'shared.txt'),'receiver edited after transfer\n');
    expect((await apply('exchange-one',first)).status).toBe('applied');
    expect(await fs.readFile(path.join(receiver,'shared.txt'),'utf8')).toBe('receiver edited after transfer\n');
  } finally {await native.dispose();await documents.dispose();await fs.rm(root,{recursive:true,force:true});}
});

it('refreshes a reused Agent from the selected worktree and retains its independent changes', async () => {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'varin-agent-refresh-')));
  const originalTree=path.join(root,'own-worktree'),selectedTree=path.join(root,'selected-worktree'),dataDir=path.join(root,'data');
  await fs.mkdir(originalTree);await fs.mkdir(selectedTree);
  const original='own=0\n\nteam=0\n';
  await fs.writeFile(path.join(originalTree,'state.txt'),original);
  await fs.writeFile(path.join(selectedTree,'state.txt'),original.replace('team=0','team=1'));
  const documents=createDocumentAuthority({hostId:'agent-refresh-review',dataDir,isAllowedRoot:async()=>true,isTrusted:async()=>true});
  const owning=await documents.resolveWorkspace({path:originalTree});
  const incoming=await documents.resolveWorkspace({path:selectedTree});
  const native=await createAuthorityTestRuntime({documents,hostId:'agent-refresh-review',dataDir});
  const signal=new AbortController().signal;
  try {
    await native.workingStates.withBranchStore(owning.workspaceId,'refresh-test',async store=>{
      const states=await store.captureDirectory(originalTree,['state.txt']);
      await store.createBranch(owning.workspaceId,'previous-agent-stage',states);
      await store.releaseCapturedStates(states);
      await fs.writeFile(path.join(originalTree,'state.txt'),original.replace('own=0','own=1'));
      const prior=await store.publishDirectoryResult('previous-agent-stage',originalTree,['state.txt'],{publicationId:'previous-result'});
      const source:LaunchSource={resource_owner:{kind:'local'},mode:'fixed_branch',workspace_id:owning.workspaceId,execution_workspace_id:owning.workspaceId,
        branch_id:prior.branchId,revision:prior.resultRevision,live_root:null};
      const selected:LaunchSource={...source,mode:'live_root',branch_id:null,revision:null,execution_workspace_id:incoming.workspaceId,
        live_root:{hostId:'agent-refresh-review',rootId:'selected-root',canonicalRoot:selectedTree}};
      const child={execution_id:'reused-agent',child_thread_id:'agent',trigger:{kind:'user_continuation'},selected_profile:{work_mode:'isolated_write'},
        source_basis:{kind:'refreshed',source,root:prior.root,provenance:{consistency:'fixed-root',root:prior.root},incoming:{run_id:'selected-run',source:selected},
          result:{branch_id:prior.branchId,result_revision:prior.resultRevision,root:prior.root}}} as DelegatedExecution;
      await captureContinuationStage(child,{store,capture:{documents,inspectInventory:async()=>({kind:'directory'})},physical:async()=>
        native.workingStates.withBranchStore(owning.workspaceId,'incoming-test',s=>s,'shared',{executionWorkspace:incoming.workspaceId})},selected,
        {rootId:'selected-root',canonicalRoot:selectedTree},signal);
      // The selected worktree may continue after the stage was captured.
      await fs.writeFile(path.join(selectedTree,'state.txt'),'team advanced after capture\n');
      const prepared=await prepareRefreshedContinuationSourceStore(child,store,signal);
      const file=await store.readPath(prepared.source.branch_id!,'state.txt',{revision:0});
      expect((await store.readContent(file!))?.toString()).toBe('own=1\n\nteam=1\n');
      expect(prepared.provenance).toMatchObject({consistency:'refreshed-root',conflicts:[],incoming:{run_id:'selected-run',source:selected}});
      expect((await prepareRefreshedContinuationSourceStore(child,store,signal)).pin.root).toBe(prepared.pin.root);
      expect(await fs.readFile(path.join(originalTree,'state.txt'),'utf8')).toBe('own=1\n\nteam=0\n');
    });
  } finally {await native.dispose();await documents.dispose();await fs.rm(root,{recursive:true,force:true});}
});
