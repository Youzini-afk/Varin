import { describe, expect, it, vi } from 'vitest';
import type { ThreadLocationDirectory } from '@varin/application-client';
import { createModelWorkLocations } from './model-work-locations.js';
import { resourceSource } from './thread-context.js';
import type { SourceToolBinding } from './protocol.generated.js';

const owner = {kind:'managed_host' as const, hostId:'original-host', connectionId:'original-peer', endpointIdentity:'private-endpoint-fingerprint'};
const local = {kind:'local' as const};
const root = {hostId:owner.hostId, rootId:'registered-root',canonicalRoot:'/logs'};
const source = {resourceOwner:owner,mode:'live_root' as const,workspaceId:'logs',executionWorkspaceId:'logs',liveRoot:root,tools:['file_read','file_write']};
const q = {runId:'run',threadId:'thread',callId:'read',origin:{kind:'model_step',request_id:'req'}};
const signal = new AbortController().signal;
const discovery = {...q,kind:'work_locations'};
const operationId = 'req:tool:read';
const selection = {...q,operationId,kind:'work_location_bind',tool:'file_read'};
function fixture() {
  const row = {id:'favorite',name:'Logs',path:'/logs',workspaceId:'logs',resourceOwner:owner};
  const workspace = {locations:[row] as ThreadLocationDirectory['locations'], projects: [] as ThreadLocationDirectory['locations']};
  const targets = [{resourceOwner:owner,label:'https://private.example/?token=secret',capabilities:['sources','work-location-read']}];
  const bound = {source:{...resourceSource(source),environment_run_id:null},physicalRoot:root,capabilities:{tools:[{name:'file_read'}],grantCapabilities:['storage.read']},
    authorityId:'read-only',resourceEpoch:'epoch',executionOwner:{kind:'external',epoch:'epoch',identity:'target-private'}};
  const client = {bind:vi.fn(async()=>bound),release:vi.fn(async()=>({phase:'retired'})),inspectScope:vi.fn(async()=>[])};
  const principalCanUseHostResources = vi.fn(async()=>true);
  const run = {id:'run',thread_id:'thread',branch_id:'branch',state:'executing',cancel_requested:false,principal_id:'principal',epoch:1};
  const thread = {parent_thread_id:null as string|null,principal_id:'principal'};
  const launch = {run_id:'run',selection:{source:{mode:'live_root'},tools:[{name:'file_read'}],extension_bindings:[]}};
  const runtime = {run:vi.fn(async()=>run),thread:vi.fn(async()=>thread),launch:vi.fn(async()=>launch),
    principalCanUseHostResources,managedSource:vi.fn(async()=>client),coordinatorHostId:'coordinator'};
  const directory = {list:vi.fn(async()=>({workspace,targets,unavailable:[]})),resolve:vi.fn(async()=>({resourceOwner:owner,path:'/logs',workspaceId:'logs'}))};
  const prepare = vi.fn(async()=>({source,path:'/logs'}));
  const kernel = {issueGrant:vi.fn(),scoped:vi.fn(),retireGrant:vi.fn()};
  const work = createModelWorkLocations({runtime,kernel,directory,prepare} as unknown as Parameters<typeof createModelWorkLocations>[0]);
  const discover = async () => (await work.query(discovery,signal) as {locations:{key?:unknown;name:string;device:string;path:string;unavailable?:string}[]}).locations[0]!;
  return {runtime,client,principalCanUseHostResources,run,thread,launch,workspace,targets,row,directory,work,discover,prepare,kernel};
}

describe('model location admission',()=>{
  it('resolves unbookmarked directories and projects on their own device before choosing the next default', async () => {
    const f = fixture();
    f.targets[0]!.label = 'Test machine';
    f.workspace.projects.push({ ...f.row, id: 'project:build', name: 'Build project' });
    const projects = await f.work.query({ ...discovery, query: 'Build project' }, signal) as { locations: Array<{ name: string; key: unknown }> };
    expect(projects.locations).toMatchObject([{ name: 'Build project' }]);
    const resolved = await f.work.query({ ...discovery, device: owner, path: '/logs' }, signal) as { locations: Array<{ key: unknown }> };
    expect(resolved.locations).toMatchObject([{ path: '/logs', device: 'Test machine', key: { workspaceId: 'logs' } }]);
    const prepared = await f.work.query({ ...selection, kind: 'work_location_switch', key: resolved.locations[0]!.key }, signal);
    expect(f.directory.resolve).toHaveBeenLastCalledWith({ resourceOwner: owner, path: '/logs' }, signal);
    expect(prepared).toMatchObject({ source: { resource_owner: owner, workspace_id: 'logs' }, device: 'Test machine' });
    expect(f.client.bind).not.toHaveBeenCalled();
    expect(f.launch.selection.source).toEqual({ mode: 'live_root' });
  });
  it('discovers safe labels and borrows exactly one target read, never the launch source',async()=>{
    const f=fixture();
    const row=await f.discover();
    expect(row.device).toBe('Managed Host');
    expect(row.name).toBe('Logs');
    expect(f.client.bind).not.toHaveBeenCalled();
    const binding=await f.work.query({...selection,key:row.key},signal) as SourceToolBinding;
    expect(binding.enabledTools).toEqual(['file_read']);
    expect(binding.resourceOwner).toEqual(owner);
    expect(f.client.bind).toHaveBeenCalledWith({coordinatorHostId:'coordinator',scope:{kind:'run',threadId:'thread',runId:'run',epoch:1},
      operationId,retention:'caller',purpose:'work_location_read',source:{...source,tools:['file_read']}});
    expect(f.kernel.issueGrant).not.toHaveBeenCalled();
    await expect(f.work.query({...q,operationId,kind:'work_location_release',binding:{...binding,grantId:'primary'}},signal)).rejects.toMatchObject({code:'source_authority_denied'});
    await f.work.query({...q,operationId,kind:'work_location_release',binding},signal);
    expect(f.client.release).toHaveBeenCalledWith({coordinatorHostId:'coordinator',authorityId:'read-only',resourceEpoch:'epoch',mode:'retire'});
    await f.work.releaseRun('run'); expect(f.client.release).toHaveBeenCalledTimes(1);
    expect(f.launch.selection.source).toEqual({mode:'live_root'});
  });
  it('rejects changed, removed, offline and newly same-named targets; never resolves a path on the coordinator',async()=>{
    const f=fixture(); const {key}=await f.discover();
    f.row.resourceOwner={...owner,endpointIdentity:'replacement'};
    await expect(f.work.query({...selection,key},signal)).rejects.toMatchObject({code:'source_changed'});
    f.row.resourceOwner=owner; f.targets.length=0;
    await expect(f.work.query({...selection,key},signal)).rejects.toMatchObject({code:'source_unavailable'});
    expect(await f.discover()).not.toHaveProperty('key');
    f.workspace.locations=[];
    await expect(f.work.query({...selection,key},signal)).rejects.toMatchObject({code:'source_changed'});
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.runtime.managedSource).not.toHaveBeenCalled();
  });
  it('denies guests, child tasks, non-model calls, isolated launches and disallowed tools before any discovery',async()=>{
    const f=fixture();
    for(const origin of [{kind:'driver'},{kind:'nested_call'},{kind:'policy_action'}]) {
      await expect(f.work.query({...discovery,origin},signal)).rejects.toMatchObject({code:'source_authority_denied'});
    }
    f.principalCanUseHostResources.mockResolvedValueOnce(false);
    await expect(f.discover()).rejects.toMatchObject({code:'source_authority_denied'});
    f.thread.parent_thread_id='parent';
    await expect(f.discover()).rejects.toMatchObject({code:'source_authority_denied'});
    f.thread.parent_thread_id=null; f.launch.selection.source.mode='materialized';
    await expect(f.discover()).rejects.toMatchObject({code:'source_authority_denied'});
    f.launch.selection.source.mode='live_root'; f.launch.selection.tools=[];
    await expect(f.discover()).rejects.toMatchObject({code:'source_authority_denied'});
    expect(f.directory.list).not.toHaveBeenCalled();
  });
  it('fails closed on old nodes, forged locators, and stale registrations',async()=>{
    const f=fixture(); const {key}=await f.discover();
    f.targets[0]!.capabilities=['sources'];
    expect(await f.discover()).toMatchObject({unavailable:'Original Host requires an update'});
    await expect(f.work.query({...selection,key},signal)).rejects.toMatchObject({code:'source_unavailable'});
    f.targets[0]!.capabilities.push('work-location-read');
    for (const bad of [{...selection,tool:'file_write',key},{...selection,operationId:'other',key},
      {...selection,key:{...f.row,resourceOwner:local}},{...selection,key:{...f.row,path:'/other'}}]) await expect(f.work.query(bad,signal)).rejects.toThrow();
    f.directory.resolve.mockResolvedValueOnce({resourceOwner:owner,path:'/logs',workspaceId:'changed'});
    await expect(f.work.query({...selection,key},signal)).rejects.toMatchObject({code:'source_changed'});
    expect(f.client.bind).not.toHaveBeenCalled();
  });
  it('retires the exact authority when cancellation overtakes remote bind',async()=>{
    const f=fixture();const {key}=await f.discover();
    const bound=await f.client.bind(); f.client.bind.mockImplementationOnce(async()=>{f.run.cancel_requested=true;return bound;});
    await expect(f.work.query({...selection,key},signal)).rejects.toMatchObject({code:'source_authority_denied'});
    expect(f.client.release).toHaveBeenCalledWith({coordinatorHostId:'coordinator',authorityId:'read-only',resourceEpoch:'epoch',mode:'retire'});
  });
});
