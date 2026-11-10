import { describe, expect, it, vi } from 'vitest';
import { parseVarinExtensionToolDeclaration } from '@varin/extension-contract';
import { createHostModelReferences, projectHostToolData, resolveHostToolArguments, type HostModelReferences, type HostReferenceDeclaration } from './model-references.js';
import type { HostToolCall, LaunchSource, ModelReferenceKind, ModelReferenceRecord } from './protocol.generated.js';

// This fixture tests the Host's typed adaptation only. Rust owns reference
// allocation, durable replay and GC, covered in the Catalog's native tests.
function port() {
  const entries = new Map<string,ModelReferenceRecord>(), frozen = new Map<string,unknown>();
  let count = 0;
  const refs: HostModelReferences = {
    register: vi.fn(async (kind,owner,target) => { const reference = `${({observation:'obs',script:'env',process:'proc'} as Record<string,string>)[kind] ?? kind}:${++count}`;
      entries.set(reference,{reference,spaceId:'catalog-space',kind,owner,target:structuredClone(target)}); return reference; }),
    resolve: vi.fn(async (kind,reference) => { const found = entries.get(reference); if (!found || found.kind !== kind) throw new Error('Reference type or owner unavailable'); return structuredClone(found); }),
    target: vi.fn(async (operationId,purpose) => frozen.get(`${operationId}:${purpose}`) ?? null),
    freeze: vi.fn(async (operationId,purpose,_original,target) => { frozen.set(`${operationId}:${purpose}`,structuredClone(target)); return structuredClone(target); }),
    source: vi.fn(async () => source),
    thread: vi.fn(async (_run,identity) => identity === 'ABCDEF12' ? 'target-thread' : identity),
  };
  return {refs,entries,seed(kind:ModelReferenceKind,owner:string,target:Record<string,unknown>) { return refs.register(kind,owner,target,'original-holder'); }};
}
const source: LaunchSource = { mode:'live_root',resource_owner:{kind:'local'},workspace_id:'workspace',execution_workspace_id:'workspace',branch_id:null,revision:null,
  live_root:{hostId:'host',rootId:'root',canonicalRoot:'/original'} };
const declaration = (family:string):HostReferenceDeclaration => ({trustedBuiltin:true,extensionId:`varin.builtin.${family}`,serviceId:`varin.${family}.fixture`});
const call = (name:string,args:unknown,operationId = 'operation'):HostToolCall => ({operationId,runId:'run',origin:{kind:'model_step',request_id:'request'},callId:'call',name,schemaVersion:'schema',arguments:args});

describe('typed Host model references', () => {
  it('keeps the observed settings revision, raw receipt and original invocation', async () => {
    const {refs} = port();
    const raw = {state:'available',entry:{id:'harness.tools',owner:'agent-settings'},revision:'original-revision',fields:[{name:'enabled',value:true}]};
    const projected = await projectHostToolData(refs,call('settings_read',{id:'harness.tools',scope:'global'}),declaration('settings'),raw,source) as Record<string,unknown>;
    expect(raw.revision).toBe('original-revision'); expect(projected.revision).toBeUndefined();
    expect(projected.entry).toEqual(raw.entry);
    const original = call('settings_update',{id:projected.ref,set:{enabled:false}});
    const args = await resolveHostToolArguments(refs,original,declaration('settings'));
    expect(args).toEqual({id:'harness.tools',scope:'global',expectedRevision:'original-revision',set:{enabled:false}});
    expect(original.arguments).toEqual({id:projected.ref,set:{enabled:false}});
    expect(refs.source).not.toHaveBeenCalled();
    await expect(resolveHostToolArguments(refs,call('settings_update',{id:projected.ref,expectedRevision:'new-revision',set:{enabled:false}},'other'),declaration('settings'))).rejects.toThrow('expectedRevision');
  });
  it('does not apply a project settings observation to another source', async () => {
    const {refs,seed} = port();
    const id = await seed('settings','host.settings',{id:'harness.tools',scope:'project',revision:'revision',source:{...source,workspace_id:'other'}});
    await expect(resolveHostToolArguments(refs,call('settings_update',{id,set:{enabled:false}}),declaration('settings'))).rejects.toThrow('different project');
    expect(refs.freeze).not.toHaveBeenCalled();
  });
  it('resolves browser screenshot identity and reuses the frozen target without resolving again', async () => {
    const {refs,seed} = port();
    const observation = await seed('observation','host.browser',{pageId:'original-page',observationId:'original-image'});
    const invocation = call('browser_act',{pageId:observation,action:'click',point:{x:1,y:2}});
    const resolved = await resolveHostToolArguments(refs,invocation,declaration('browser'));
    expect(resolved).toEqual({pageId:'original-page',observationId:'original-image',action:'click',point:{x:1,y:2}});
    vi.mocked(refs.resolve).mockRejectedValue(new Error('original page is no longer live'));
    expect(await resolveHostToolArguments(refs,invocation,declaration('browser'))).toEqual(resolved);
    expect(refs.resolve).toHaveBeenCalledTimes(1);
  });
  it('rejects mismatched browser targets rather than silently choosing a new page', async () => {
    const {refs,seed} = port();
    const observation = await seed('observation','host.browser',{pageId:'original-page',observationId:'original-image'});
    await expect(resolveHostToolArguments(refs,call('browser_act',{pageId:'other-page',observationId:observation,action:'click',point:{x:1,y:2}}),declaration('browser'))).rejects.toThrow('different pageId');
  });
  it('binds Computer input to the observed app/window and control epoch', async () => {
    const {refs} = port();
    const raw = {observation:{id:'native-observation',desktopId:'original-desktop',machineId:'machine',automationEpoch:'original-epoch',app:{pid:12,name:'Editor'},windowHandle:21,nativeTarget:'private-target',treeLines:['1 Button'],elements:[]}};
    const output = await projectHostToolData(refs,call('computer_observe',{app:'Editor'}),declaration('computer'),raw) as typeof raw;
    expect(output.observation.nativeTarget).toBeUndefined(); expect(raw.observation.nativeTarget).toBe('private-target');
    const resolved = await resolveHostToolArguments(refs,call('computer_act',{action:{kind:'click',observationId:output.observation.id,elementIndex:1}}),declaration('computer'));
    expect(resolved).toEqual({desktopId:'original-desktop',automationEpoch:'original-epoch',action:{kind:'click',observationId:'native-observation',app:'12',window:21,elementIndex:1}});
  });
  it('uses the same native managed-process target shape for script environments', async () => {
    const {refs} = port();
    const output = await projectHostToolData(refs,call('script_open',{}),declaration('script'),{environmentId:'original-operation',cellId:'not-another-environment'},source) as Record<string,unknown>;
    expect(output.cellId).toBeUndefined();
    expect(await resolveHostToolArguments(refs,call('script_run',{environmentId:output.environmentId,script:'const id = "environmentId";'}),declaration('script')))
      .toEqual({environmentId:'original-operation',script:'const id = "environmentId";'});
    expect(refs.register).toHaveBeenCalledWith('script',JSON.stringify(source.resource_owner),{operationId:'original-operation'},'operation');
  });
  it('projects forward discovery and resolves the exact original Job', async () => {
    const {refs} = port();
    const raw = {jobs:[{operationId:'forward-operation',listenerState:'live',access:{url:'http://localhost:1234'},owner:{hostEpoch:'epoch'}}]};
    const output = await projectHostToolData(refs,call('environment_forwards',{}),declaration('environment'),raw) as typeof raw;
    expect(output.jobs[0]!.operationId).toMatch(/^forward:/); expect(raw.jobs[0]!.operationId).toBe('forward-operation');
    expect(await resolveHostToolArguments(refs,call('environment_forward_close',{operationId:output.jobs[0]!.operationId}),declaration('environment'))).toEqual({operationId:'forward-operation'});
  });
  it('projects a fixed material continuation, without consuming its cursor or changing user text', async () => {
    const {refs} = port();
    const raw = {snapshot:{snapshotId:'snapshot',contentHash:'hash'},markdown:'literal snapshot and hash',nextRead:{snapshotId:'snapshot',view:'text',position:{kind:'lines',startLine:17}}};
    const output = await projectHostToolData(refs,call('webfetch',{url:'https://example.com'}),declaration('web'),raw) as {nextRead:{tool:string;arguments:{ref:string}}};
    expect(output.nextRead.tool).toBe('webfetch');
    expect(await resolveHostToolArguments(refs,call('webfetch',output.nextRead.arguments),declaration('web'))).toEqual(raw.nextRead);
    expect(await resolveHostToolArguments(refs,call('webfetch',output.nextRead.arguments,'second'),declaration('web'))).toEqual(raw.nextRead);
    expect(raw.markdown).toBe('literal snapshot and hash');
  });
  it('allows an Office file ref to select its original writable path but rejects a different source', async () => {
    const {refs,seed} = port();
    const ref = await seed('file','source',{kind:'observation',source,path:'report.docx',readVersion:'observed-version',format:null});
    const args = {action:'edit',path:ref,edits:[{action:'set_text',objectId:'paragraph:1',text:'Updated'}]};
    expect(await resolveHostToolArguments(refs,call('office_write',args),declaration('office'))).toEqual({...args,path:'report.docx'});
    vi.mocked(refs.source).mockResolvedValue({...source,workspace_id:'other'});
    await expect(resolveHostToolArguments(refs,call('office_write',args,'other'),declaration('office'))).rejects.toThrow('different source');
  });
  it('only transforms declared extension positions, never prose or opaque payloads', async () => {
    const {refs} = port();
    const typed:HostReferenceDeclaration = {extensionId:'example',serviceId:'example.read',references:{outputs:[{path:'/items/*',kind:'job',owner:'work',reference:'jobId',fields:['jobId','revision']}],inputs:[{path:'',kind:'job',owner:'work',reference:'jobId',fields:['jobId','revision']}]}};
    const raw = {items:[{jobId:'actual-job',revision:'v1',title:'Name'}],text:'actual-job',opaque:{jobId:'external-id'}};
    const output = await projectHostToolData(refs,call('custom',{}),typed,raw) as typeof raw;
    expect(output.items[0]).toEqual({jobId:'job:1',title:'Name'}); expect(output.opaque).toEqual(raw.opaque); expect(output.text).toBe(raw.text);
    expect(await resolveHostToolArguments(refs,call('custom',{jobId:'job:1',text:'literal job:1'}),typed)).toEqual({jobId:'actual-job',revision:'v1',text:'literal job:1'});
    const opaque = {id:'job:1',body:{jobId:'job:1'}};
    expect(await resolveHostToolArguments(refs,call('third_party',opaque),{extensionId:'third-party',serviceId:'third-party.tool'})).toEqual(opaque);
    expect(refs.resolve).toHaveBeenCalledTimes(1);
    await expect(resolveHostToolArguments(refs,call('custom',{jobId:'job:1'},'foreign'),{...typed,extensionId:'other'})).rejects.toThrow('different resource owner');
  });
  it('validates extension reference metadata and rejects undeclared traversal instructions', () => {
    const base = {name:'read',description:'Read',inputSchema:{type:'object'},outputSchema:{type:'object'},operation:'read',completion:'result'};
    expect(parseVarinExtensionToolDeclaration({...base,references:{outputs:[{path:'/items/*',kind:'file',owner:'files',reference:'ref',fields:['id','version']}]}}).references?.outputs).toHaveLength(1);
    expect(() => parseVarinExtensionToolDeclaration({...base,references:{outputs:[{path:'/**',kind:'made_up',owner:'files',reference:'ref',fields:['id']}]}})).toThrow('typed tool reference');
    expect(() => parseVarinExtensionToolDeclaration({...base,references:{outputs:[{path:'/constructor',kind:'file',owner:'files',reference:'ref',fields:['id']}]}})).toThrow('typed tool reference');
  });
  it('routes registrations and freezes only through private Catalog RPC', async () => {
    const request = vi.fn(async (method:string) => method.endsWith('.register') ? {reference:'page:7'} : null);
    const refs = createHostModelReferences({agentRuntimeRequest:request as never});
    expect(await refs.register('page','host.browser',{pageId:'native'},'holder')).toBe('page:7');
    await refs.freeze('operation','host.arguments:browser',{pageId:'page:7'},{pageId:'native'});
    expect(request.mock.calls).toEqual([
      ['runtime.model_reference.register',{kind:'page',owner:'host.browser',target:{pageId:'native'},holder:'holder'}],
      ['runtime.model_reference.target',{operationId:'operation',purpose:'host.arguments:browser',original:{pageId:'page:7'},target:{pageId:'native'}},undefined],
    ]);
  });
});

it('resolves only the declared browser upload material fields and preserves observed file refs for conditional capture', async () => {
  const {refs,seed} = port();
  const material = await seed('material','host.material',{snapshotId:'native-snapshot'});
  const args = {pageId:'actual-page',action:'upload',ref:'element:2',files:[{snapshotId:material},{path:'file:11'},{path:'report.pdf'}]};
  expect(await resolveHostToolArguments(refs,call('browser_files',args),declaration('browser'))).toEqual({...args,files:[{snapshotId:'native-snapshot'},{path:'file:11'},{path:'report.pdf'}]});
  expect(args.files[0]).toEqual({snapshotId:material});
});

it('keeps project scope through rereading a reference and does not invent CAS for LWW surfaces', async () => {
  const {refs}=port();
  const raw={entry:{id:'harness.tools',owner:'agent-settings'},consistency:'compare-and-swap',revisions:{global:'G1',project:'P1'}};
  const first=await projectHostToolData(refs,call('settings_read',{id:'harness.tools',scope:'project'}),declaration('settings'),raw,source) as {ref:string};
  const reread=call('settings_read',{id:first.ref},'reread');
  const resolved=await resolveHostToolArguments(refs,reread,declaration('settings'));
  const second=await projectHostToolData(refs,reread,declaration('settings'),raw,source,resolved) as {ref:string};
  expect(await resolveHostToolArguments(refs,call('settings_update',{id:second.ref,set:{enabled:false}},'update'),declaration('settings')))
    .toEqual({id:'harness.tools',scope:'project',expectedRevision:'P1',set:{enabled:false}});
  const client=await projectHostToolData(refs,call('settings_read',{id:'client.preference'},'surface-read'),declaration('settings'),
    {entry:{id:'client.preference',owner:'client'},revision:'not-a-cas-token',consistency:'last-write-wins',referenceTarget:{surfaceId:'device',connectionId:'original-connection'}}) as {ref:string;referenceTarget?:unknown};
  expect(client.referenceTarget).toBeUndefined();
  const update=call('settings_update',{id:client.ref,set:{enabled:true}},'surface-update');
  expect(await resolveHostToolArguments(refs,update,declaration('settings'))).toEqual({id:'client.preference',set:{enabled:true}});
  expect(await refs.target(update.operationId,'host.settings.surface',update.arguments)).toEqual({surfaceId:'device',connectionId:'original-connection'});
});

it('roundtrips actual collection members and search hits through the declared singular add member', async () => {
  const {refs}=port();
  const raw={collection:{members:[{snapshotId:'snapshot-a',title:'A'}]},member:{snapshotId:'snapshot-b'},hits:[{snapshotId:'snapshot-c',excerpt:'body'}]};
  const output=await projectHostToolData(refs,call('materials',{}),declaration('web'),raw) as typeof raw;
  for (const snapshotId of [output.collection.members[0]!.snapshotId,output.member.snapshotId,output.hits[0]!.snapshotId]) expect(snapshotId).toMatch(/^material:/);
  expect(await resolveHostToolArguments(refs,call('materials',{action:'add',collectionId:'collection',member:{kind:'snapshot',snapshotId:output.member.snapshotId}}),declaration('web')))
    .toEqual({action:'add',collectionId:'collection',member:{kind:'snapshot',snapshotId:'snapshot-b'}});
  expect(raw.member.snapshotId).toBe('snapshot-b');
});

it('does not let an author-controlled builtin name select a trusted resource owner', async () => {
  const {refs}=port();
  const impersonator:HostReferenceDeclaration={extensionId:'varin.builtin.custom',serviceId:'varin.settings.custom'};
  const raw={entry:{id:'harness.tools'},revision:'raw-revision'};
  expect(await projectHostToolData(refs,call('settings_read',{}),impersonator,raw)).toEqual(raw);
  expect(await resolveHostToolArguments(refs,call('settings_update',{id:'settings:1'}),impersonator)).toEqual({id:'settings:1'});
  expect(refs.register).not.toHaveBeenCalled();expect(refs.resolve).not.toHaveBeenCalled();
});

it('projects original search source snapshots and nested continuation without copying hidden hashes', async()=>{
  const {refs}=port();
  const raw={items:[{results:[{source:{snapshot:{snapshotId:'observed',contentHash:'internal',document:{kind:'pdf',sourceSnapshotId:'original',source:{contentHash:'bytes-hash',byteLength:7}}}},nextRead:{snapshotId:'observed'}}]}]};
  const output=await projectHostToolData(refs,call('websearch',{}),declaration('web'),raw) as {items:Array<{results:Array<{source:typeof raw.items[0]['results'][0]['source'];nextRead:{tool:string;arguments:Record<string,unknown>}}>}>};
  const hit=output.items[0]!.results[0]!;expect(hit.source.snapshot.snapshotId).toMatch(/^material:/);
  expect(hit.source.snapshot.contentHash).toBeUndefined();expect(hit.source.snapshot.document.source.contentHash).toBeUndefined();
  expect(hit.source.snapshot.document.sourceSnapshotId).toMatch(/^material:/);
  expect(hit.nextRead.tool).toBe('webfetch');
  expect(await resolveHostToolArguments(refs,call('webfetch',hit.nextRead.arguments),declaration('web'))).toEqual({snapshotId:'observed'});
});

it('rejects one settings batch built from observations of two different client connections',async()=>{
  const {refs,seed}=port();
  const first=await seed('settings','host.settings',{id:'client.a',surface:{surfaceId:'a',connectionId:'one'}});
  const second=await seed('settings','host.settings',{id:'client.b',surface:{surfaceId:'b',connectionId:'two'}});
  await expect(resolveHostToolArguments(refs,call('settings_update',{items:[{id:first,set:{x:1}},{id:second,set:{x:2}}]}),declaration('settings'))).rejects.toThrow('different client connections');
});

it('keeps material collection and member identities distinct and resolves a shared recipient through its family owner',async()=>{
  const {refs}=port();
  const raw={collection:{collectionId:'collection-original',members:[{memberId:'member-original',snapshotId:'snapshot-original'}]}};
  const projected=await projectHostToolData(refs,call('materials',{}),declaration('web'),raw) as typeof raw;
  const collectionId=projected.collection.collectionId,memberId=projected.collection.members[0]!.memberId;
  expect(await resolveHostToolArguments(refs,call('materials',{action:'remove',collectionId,memberId}),declaration('web'))).toEqual({action:'remove',collectionId:'collection-original',memberId:'member-original'});
  expect(await resolveHostToolArguments(refs,call('materials',{action:'share',collectionId,targetThreadId:'ABCDEF12'},'share'),declaration('web'))).toEqual({action:'share',collectionId:'collection-original',targetThreadId:'target-thread'});
  await expect(resolveHostToolArguments(refs,call('document_read',{snapshotId:collectionId},'wrong-kind'),declaration('web'))).rejects.toThrow('does not select a snapshot');
});
