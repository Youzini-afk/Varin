/** Original retrieval/configuration/credential owners over test stdio, never product IPC.
 * Storage authorizes actual files/compute; only inference provider bytes are controlled. */
import assert from 'node:assert/strict';
import { create as createTar } from 'tar';
import { localComponentFixture } from '../knowledge/semantic/fixtures/local-component.test-helper.js';
import { createLocalSemanticComponentManager } from '../knowledge/semantic/local-component.js';
import { resolveInstalledModelPack } from '../knowledge/semantic/model-store.js';
import { createLocalSemanticEmbedder } from '../knowledge/semantic/local-embedder.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { ModelsService } from '../models/service.js';
import type { ThreadMaterialsAPI } from '@varin/application-client';
import { createDocumentAuthority } from '../documents/authority.js';
import { revisionFromBytes } from '../documents/inspect.js';
import { createEgressRuntime } from '../harness/egress.js';
import { createSemanticInference } from '../knowledge/semantic/runtime-inference.js';
import { createSemanticInferenceLedger } from '../knowledge/semantic/inference-ledger.js';
import { createWorkspaceSemanticRuntime } from '../knowledge/semantic/workspace-runtime.js';
import { createEmbedScheduler } from '../knowledge/semantic/embed-scheduler.js';
import { createHashEmbedder } from '../knowledge/semantic/embedder.js';
import { createProjectIndexScope } from '../knowledge/index-scope.js';
import { createStructureSource } from '../structure/source.js';
import { createFsSearchRuntime } from '../fs/search.js';
import { KernelClient, type KernelGrantHandle } from './kernel-client.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { createLiveSourceOwner } from './live-source.js';
import { createRetrievalComposition } from './retrieval-composition.js';
import { createModelAuthority } from './model-authority.js';
import { createRetrievalModelStage } from './retrieval-model.js';
import { createRetrievalOwner } from './retrieval-owner.js';
import { createRetrievalSourceOwner } from './retrieval-source.js';
import { originalMaterializationLocation } from './source-launch.js';
import { createChildProfilePreparer } from './child-profiles.js';
import { createKernelComputeService } from './compute-service.js';
import { createTreeSitterStructureProvider } from '../structure/tree-sitter-provider.js';
import { withMaterialReviewClient, writeMaterialFixtureFrame as write } from './material-review-fixture.test-helper.js';
import type { ChildCapabilityDescriptor, KernelHandshakeResult, LaunchSource } from './protocol.generated.js';
const HOST='web-domain-host', GENERATION='web-domain-generation';
const pending=new Map<string,{resolve(value:unknown):void;reject(error:Error):void}>();
let sequence=0, mode='', root='', runId='', requests=0, drained=false;
let kernel:KernelClient, runtime:AgentRuntimeClient;
let documents:ReturnType<typeof createDocumentAuthority>, extensions:ApplicationExtensionRuntime;
let inference:ReturnType<typeof createSemanticInference>, grant:KernelGrantHandle;
let selectedSource:LaunchSource, sourceMode='live_root', physicalRoot:LaunchSource['live_root']=null;
let credentials:ModelsService;
let compute:ReturnType<typeof createKernelComputeService>, syntaxComputations=0;
let releaseBody:()=>void=()=>{throw new Error('No original body to release');};
const bodies:unknown[]=[];
let semantic: ReturnType<typeof createWorkspaceSemanticRuntime> | undefined;
let indexScope: ReturnType<typeof createProjectIndexScope> | undefined;
let ledger: ReturnType<typeof createSemanticInferenceLedger> | undefined;
let embeddingRequests = 0, indexRequests = 0, retrievalCalls = 0;
let documentRequests = 0, fixedUnits = 0, lexicalSearches = 0, backgroundScan = false, guardMutation = false;
let queryExpanded = false;
let guardPath: string | undefined;
let releaseLexical!: () => void;
const lexicalStarted = new Promise<void>(resolve => { releaseLexical = resolve; });
const documentInputs: string[][] = [], backgroundInputs: string[][] = [], queryFacts: unknown[] = [];
const originalDocuments: Record<string, { content: string; revision: string }> = {};
const localSemantic = () => mode.startsWith('semantic-local-');
const fixedSemantic = () => mode.startsWith('semantic-fixed-') || localSemantic();
let localModelRoot: string | undefined, localValidationCalls = 0;
let localEncoder: ReturnType<typeof createLocalSemanticEmbedder> | undefined, localBackground: Promise<number[][]> | undefined;
let localCancelScheduled = false;
async function waitForLocalForward() {
  const deadline = Date.now() + 10000;
  while (true) {
    try { await readFile(join(localModelRoot!, 'started')); return; } catch { /* The controlled forward has not entered yet. */ }
    if (Date.now() > deadline) throw new Error('Controlled local forward did not start');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const localCalls = async (): Promise<string[][]> => localModelRoot ? (await readFile(join(localModelRoot, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]) : [];
const semanticQuestions = ['quasar rendezvous', 'nebula docking'];
const semanticBody = (marker: string) => `export const capsule = "${marker}";\n`;
async function sourceDocuments() {
  if (sourceMode === 'fixed_branch') return originalDocuments;
  return Object.fromEntries(await Promise.all(['a', 'b', 'c'].map(async name => {
    const path = `allowed/${name}.ts`, bytes = await readFile(join(physicalRoot!.canonicalRoot, path));
    return [path, { content: bytes.toString('utf8'), revision: revisionFromBytes(bytes) }];
  })));
}
async function editMaterialized(path: string, content: string, suffix: string) {
  const mutation = await kernel.issueGrant({ grantId: `semantic-edit:${suffix}`, threadId: 'thread:parent', runId,
    owningWorkspace: selectedSource.workspace_id, executionWorkspace: selectedSource.execution_workspace_id,
    capabilities: ['storage.read', 'storage.write'], pathScopes: ['allowed'] });
  const actor = kernel.scoped(mutation), address = { workspaceId: selectedSource.workspace_id, rootId: physicalRoot!.rootId, path };
  try {
    const captured = await actor.fileCapture({ ...address, operationId: `semantic-capture:${suffix}`, store: false });
    const bytes = Buffer.from(content), blob = await actor.putBlob(bytes, `semantic-edit:${suffix}`);
    const applied = await actor.fileApply({ ...address, operationId: `semantic-apply:${suffix}`, expectedJson: String(captured.stateJson),
      targetJson: JSON.stringify({ kind: 'regular-file', objectHash: blob.hash, byteLength: bytes.byteLength,
        mode: (JSON.parse(String(captured.stateJson)) as { mode?: number }).mode }), ownerId: blob.ownerId });
    assert.equal(applied.status, 'applied');
    await actor.releaseBlob(blob.ownerId);
  } finally { await kernel.revokeGrant(mutation.grantId); }
}
const usesSemantic = () => mode.startsWith('semantic-');
const usesExplore = () => mode.startsWith('llm-') || mode === 'semantic-auto';
const usesDecision = () => mode.startsWith('decision-') || mode === 'llm-auto' || mode === 'semantic-auto';
async function embeddingResponse(init: RequestInit): Promise<Response> {
  const wire = JSON.parse(String(init.body)) as { model: string; input: string[] };
  const query = wire.input.length === 1 && ['retrievalNeedle', 'How does retrievalNeedle resolve its dependency?', ...semanticQuestions].includes(wire.input[0]!);
  assert.equal(wire.model, 'encoder');
  if (query) embeddingRequests++; else if (fixedSemantic() && !backgroundScan) {
    documentRequests++; documentInputs.push(wire.input);
    assert(wire.input.every(text => !text.includes('FORBIDDEN_SOURCE') && !text.includes('LIVE_ONLY') && !text.includes('WRONG_LIVE')));
  } else { indexRequests++; if(fixedSemantic()) backgroundInputs.push(wire.input); }
  if (!fixedSemantic()) assert(wire.input.every(text => !text.includes('FORBIDDEN_SOURCE')));
  if (!query && fixedSemantic() && mode === 'semantic-fixed-stop') return heldResponse(init);
  if (query && mode === 'semantic-stop') return heldResponse(init);
  return Response.json({ data: wire.input.map((text, index) => ({ index,
    embedding: fixedSemantic() ? query || /FORBIDDEN_SOURCE|LIVE_ONLY|WRONG_LIVE/.test(text) ? [1, 0] : text.includes('CAPSULE') ? [0.8, 0.6] : text.includes('AMBER') ? [0.7, 0.7] : [0.6, 0.8]
      : query && mode === 'semantic-invalid' ? [1] : text.includes('SOURCE_C') ? [1, 0] : [0.9, 0.1] })),
    ...(query && mode === 'semantic-missing' ? {} : { usage: { prompt_tokens: 7, total_tokens: 7 } }) });
}
function request(method:string,params:unknown,options:{grant?:KernelGrantHandle}={}) {
  if(method==='compute.start'&&(params as {operation?:string}).operation==='search') {
    lexicalSearches++; releaseLexical();
  }
  if(method==='compute.start'&&(params as {operation?:string}).operation==='structure') syntaxComputations++;
  if(method==='compute.start'&&(params as {operation?:string;lane?:string}).operation==='chunks'
    && (params as {lane?:string}).lane==='foreground') fixedUnits++;
  if(options.grant) kernel.assertGrantForScope(options.grant);
  const id=`rerank-review:${++sequence}`;
  const response = new Promise((resolve,reject)=>{
    pending.set(id,{resolve,reject});
    write({kind:'fixture-request',id,method,params,...(options.grant?{grantId:options.grant.grantId}:{})});
  });
  if (mode === 'semantic-local-queued' && method === 'runtime.inference.admit' && !localCancelScheduled) {
    localCancelScheduled = true;
    void response.then(() => new Promise<void>(resolve => setImmediate(resolve))).then(async () => {
      await withMaterialReviewClient(runtime, {} as ThreadMaterialsAPI, api => api.cancelRun(runId));
    }).catch(error => write({ kind: 'fixture-failed', error: String(error) }));
  }
  return response;
}
async function heldResponse(init: RequestInit): Promise<Response> {
  assert(init.signal);
  const signal=init.signal;
  const stream=new ReadableStream<Uint8Array>({start(controller){
    const cancelled=()=>{
      write({kind:'fixture-body-cancelled',drained});
      releaseBody=()=>{drained=true;controller.error(new DOMException('Original inference body stopped','AbortError'));};
    };
    signal.addEventListener('abort',cancelled,{once:true});
    if(signal.aborted) cancelled();
  }});
  // No delay threshold: hold this actual document request until the original cheap
  // path has entered native compute, then exercise the public Stop route.
  if(mode==='semantic-fixed-stop') await lexicalStarted;
  void withMaterialReviewClient(runtime,{} as ThreadMaterialsAPI,api=>api.cancelRun(runId))
    .catch(error=>write({kind:'fixture-failed',error:String(error)}));
  return new Response(stream,{headers:{'content-type':'application/json'}});
}
const egress=createEgressRuntime({env:{},resolveAll:async()=>[{address:'93.184.216.34',family:4}],
  systemFetch:async(url,init)=>{
    if(String(url)==='https://embedding.invalid/v1/embeddings') return embeddingResponse(init);
    if(usesDecision()) {
      assert.equal(String(url),'https://rerank.invalid/models/systemone');
      assert.equal(new Headers(init.headers).get('authorization'),'Bearer controlled-rerank-key');
      const body=JSON.parse(String(init.body)) as {model:string;state:{goal:string;materials:Array<{id:string;text:string;label:string}>};questions:Record<string,unknown>};
      bodies.push(body);requests++;
      assert.equal(body.model,'classifier');
      assert.equal(body.state.goal,usesExplore()?'How does retrievalNeedle resolve its dependency?':'retrievalNeedle');
      assert(body.state.materials.every(material=>!material.text.includes('FORBIDDEN_SOURCE')));
      assert.equal('messages' in body,false);
      if(mode==='decision-stop') return heldResponse(init);
      const usage=mode==='decision-unknown'?{input_tokens:7}:{input_tokens:requests*7,output_tokens:requests};
      if(mode==='decision-partial'&&body.state.materials.some(material=>material.text.includes('DISCOVERED_HELPER'))) return Response.json({answers:'invalid original second batch',usage});
      const answers: Record<string, unknown> = Object.fromEntries(Object.entries(body.questions).map(([id, value]) => {
        const choices = (value as { criteria: Record<string, string> }).criteria;
        let choice = id.startsWith('m:') ? 'keep' : choices['symbol:hiddenHelper'] ? 'symbol:hiddenHelper'
          : choices['read:allowed/helper.ts'] ? 'read:allowed/helper.ts' : Object.keys(choices).find(id => id.startsWith('wait:')) ?? 'deliver';
        if (id === 'next' && usesExplore() && !queryExpanded && choices.expand) { queryExpanded = true; choice = 'expand'; }
        return [id, { type: 'choice', choice }];
      }));
      // An unissued identifier is provider data, never source or action authority.
      answers['a:read:private/secret.ts']={type:'noul',noul:1};
      return Response.json({answers,usage});
    }
    assert.equal(String(url),'https://rerank.invalid/models/rerank');
    assert.equal(init.method,'POST');
    assert.equal(new Headers(init.headers).get('authorization'),'Bearer controlled-rerank-key');
    const body=JSON.parse(String(init.body)) as {model:string;query:string;documents:string[];return_documents:boolean};
    bodies.push(body);requests++;
    assert.equal(body.model,'ranker');assert.equal(body.return_documents,false);
    assert(body.documents.length>=2);assert(body.documents.every(text=>!text.includes('FORBIDDEN_SOURCE')));
    const c=body.documents.findIndex(text=>text.includes('SOURCE_C'));
    const a=body.documents.findIndex(text=>text.includes('SOURCE_A'));
    assert(c>=0&&a>=0,'actual authorized source snippets reached the reranker');
    if(mode==='stop-body') return heldResponse(init);
    if(mode==='empty') return Response.json({results:[],usage:{total_tokens:91}});
    if(mode==='stale') await writeFile(join(physicalRoot!.canonicalRoot,'allowed','c.ts'),'export const retrievalNeedle = "CHANGED_SOURCE_C";\n');
    return Response.json({results:[{index:c,relevance_score:0.9},{index:a,relevance_score:0}],
      usage:{total_tokens:91},meta:{fixture:'raw original usage is not input/output'}});
  }});
async function initialize(frame:Record<string,unknown>) {
  root=String(frame.root);mode=String(frame.mode);sourceMode=String(frame.sourceMode??'live_root');
  const workspace=join(root,'workspace'), agentDir=join(root,'agent');
  await mkdir(join(workspace,'allowed'),{recursive:true});await mkdir(join(workspace,'private'),{recursive:true});await mkdir(agentDir,{recursive:true});
  if(fixedSemantic()) {
    for (const [file, marker] of [['a', 'PINNED_MAGENTA_CAPSULE_紫'], ['b', 'STABLE_AMBER'], ['c', 'STABLE_CYAN']])
      await writeFile(join(workspace, 'allowed', `${file}.ts`), semanticBody(mode === 'semantic-local-partial' && file === 'c' ? 'FAIL_FORWARD' : marker!));
  } else if(usesDecision()||usesExplore()) {
    await writeFile(join(workspace,'allowed','seed.ts'),'export const retrievalNeedle = hiddenHelper();\n');
    await writeFile(join(workspace,'allowed','helper.ts'),'export function hiddenHelper() { return "DISCOVERED_HELPER"; }\n');
  } else {
    for(const [file,value] of [['a','SOURCE_A'],['b','SOURCE_B'],['c','SOURCE_C']])
      await writeFile(join(workspace,'allowed',`${file}.ts`),`export const retrievalNeedle = "${value}";\n`);
  }
  await writeFile(join(workspace,'private','secret.ts'),'export const retrievalNeedle = "FORBIDDEN_SOURCE";\n');
  if(sourceMode!=='live_root'&&!fixedSemantic()&&!mode.startsWith('llm-')&&!mode.startsWith('decision-'))
    await writeFile(join(workspace,'allowed','a.ts'),'// original source padding\n'.repeat(4000)+'export const retrievalNeedle = "SOURCE_A";\n');
  credentials=new ModelsService(agentDir,{projectTrusted:()=>false});
  await credentials.storeCredential('controlled-rerank-key','rank');
  await credentials.storeCredential('controlled-explore-key','explore');
  await credentials.storeCredential('controlled-embedding-key','embedding');
  for(const channel of [
    {id:'rank',type:'rerank',baseUrl:'https://rerank.invalid/models',reference:'rank',model:'ranker',operations:['rerank'] as const},
    {id:'decision',type:'typesafe-system-one',baseUrl:'https://rerank.invalid/models',reference:'rank',model:'classifier',operations:['decision'] as const},
    {id:'embedding',type:'openai-compatible',baseUrl:'https://embedding.invalid/v1',reference:'embedding',model:'encoder',operations:['embedding'] as const},
    {id:'explore',type:'openai',baseUrl:'https://explore.invalid/v1',reference:'explore',model:'explore-model',operations:['chat'] as const},
  ]) await credentials.save({id:channel.id,name:channel.id,type:channel.type,baseUrl:channel.baseUrl,enabled:true,
    authentication:{kind:'credential',reference:channel.reference},parameters:{},
    models:[{id:channel.model,name:channel.model,enabled:true,operations:[...channel.operations],
      ...(channel.id==='explore'?{contextWindow:32768,maxOutputTokens:2000,input:['text' as const]}:{})}]},(await credentials.read()).revision);
  await writeFile(join(agentDir,'agent-settings.json'),JSON.stringify({harness:{codeRetrieval:{decision:mode==='llm-auto'||mode==='semantic-auto'?'auto':usesExplore()||mode==='unconfigured-model'?'llm':mode.startsWith('decision-')?'fast-decision':fixedSemantic()?'source':['source','syntax','semantic','semantic-stop','semantic-invalid','semantic-missing','semantic-cold','semantic-cache','semantic-credential'].includes(mode)?'source':'rerank'},
    rerank:{protocol:'http-rerank',providerId:'rank',modelId:'ranker'},
    embedding:usesSemantic()&&!localSemantic()?{protocol:'openai-compatible',providerId:'embedding',modelId:'encoder',dimensions:2,maxTokens:2048}:undefined,
    models:usesExplore()?{explore:{providerId:'explore',modelId:'explore-model'}}:undefined,
    fastDecision:usesDecision()?{default:{protocol:'typed-classifier',providerId:'decision',modelId:'classifier'}}:undefined}}));
  kernel=new KernelClient({hostId:HOST,hostGeneration:GENERATION,storageRoot:String(frame.storageRoot),buildVersion:'0.9.25'});
  // Replace delivery/handshake only. Original grant minting/token checks, bridges and runtime events remain.
  const transport=kernel as unknown as {epoch:string;started:boolean;handshakeResult:KernelHandshakeResult;consumeFrame(value:unknown):void};
  transport.epoch=String(frame.epoch);
  transport.started=true;
  transport.handshakeResult={hostId:HOST,storageRoot:String(frame.storageRoot),kernelEpoch:String(frame.epoch)} as KernelHandshakeResult;
  Object.defineProperty(kernel,'requestRaw',{value:request});
  Object.defineProperty(kernel,'write',{value:async(value:unknown)=>{write(value);}});
  runtime=new AgentRuntimeClient(kernel, undefined, undefined, undefined, undefined, undefined, (id, signal) => documents.admitWorkspaceRegistration(id, signal));
  documents=createDocumentAuthority({hostId:HOST,dataDir:join(root,'documents'),isTrusted:async()=>true,
    isAllowedRoot:async(candidate:string)=>candidate===workspace||candidate.startsWith(workspace+'/')});
  const identity=await documents.resolveWorkspace({path:workspace});
  const live=createLiveSourceOwner({documents,kernel});
  selectedSource={resource_owner:{kind:'local'},workspace_id:identity.workspaceId,execution_workspace_id:identity.workspaceId,
    mode:'live_root',branch_id:null,revision:null,live_root:await live.prepare(identity.workspaceId,identity.workspaceId,'thread:parent')};
  physicalRoot=selectedSource.live_root;
  if(sourceMode!=='live_root') {
    const seed=await kernel.issueGrant({grantId:'source-view-fixture-seed',threadId:'thread:parent',
      owningWorkspace:identity.workspaceId,executionWorkspace:identity.workspaceId,capabilities:['storage.read','storage.write'],pathScopes:['']});
    const actor=kernel.scoped(seed), entries=[];
    for(const file of mode.startsWith('llm-')||mode.startsWith('decision-')?['allowed/seed.ts','allowed/helper.ts','private/secret.ts']:['allowed/a.ts','allowed/b.ts','allowed/c.ts','private/secret.ts']) {
      const bytes=await readFile(join(workspace,file)), blob=await actor.putBlob(bytes,`source-view:${file}`);
      if(fixedSemantic() && file.startsWith('allowed/')) originalDocuments[file] = { content: bytes.toString('utf8'), revision: revisionFromBytes(bytes) };
      entries.push({path:file,ownerId:blob.ownerId,state:{kind:'regular-file' as const,objectHash:blob.hash,byteLength:bytes.byteLength,mode:420}});
    }
    await actor.createBranch({operationId:'source-view-create',workspaceId:identity.workspaceId,branchId:'source:retrieval',captureScopes:[],draftBasePaths:[],
      entries:[{path:'allowed',state:{kind:'directory',mode:493}},{path:'private',state:{kind:'directory',mode:493}},...entries]});
    await actor.pinBranch({operationId:'source-view-pin',branchId:'source:retrieval',revision:0,pinId:'source-view-original'});
    for(const entry of entries) await actor.releaseBlob(entry.ownerId);
    selectedSource={...selectedSource,mode:sourceMode as 'fixed_branch'|'materialized',branch_id:'source:retrieval',revision:0,live_root:null};
    physicalRoot=null;
    await kernel.revokeGrant(seed.grantId);
  }
  if(usesSemantic()&&!localSemantic()) ledger=createSemanticInferenceLedger({dataDir:join(root,'semantic-data'),hostId:HOST});
  inference=createSemanticInference(credentials,undefined,{requests:{kernel,runtime,egress},...(ledger?{ledger}:{}),fetchImpl:async(_url,init)=>embeddingResponse(init!)});
  const sources=createRetrievalSourceOwner({kernel,documents,validateLiveSource:live.validate});
  compute=createKernelComputeService({client:kernel,resolveIdentity:async cwd=>{
    assert(usesSemantic(),'Fixed syntax must only consume its admitted supplied text');
    const identity=await documents.resolveWorkspace({path:cwd});
    return {workspaceId:identity.workspaceId,executionWorkspaceId:identity.workspaceId,canonicalRoot:(await documents.inspectWorkspace(identity.workspaceId)).root};
  }});
  const syntax=createTreeSitterStructureProvider({compute});
  const unitsFixed = syntax.unitsFixed!;
  syntax.unitsFixed = async request => {
    const result = await unitsFixed(request);
    if (localSemantic() && !['ready', 'empty'].includes(result.status)) console.error('local fixture source units', request.path, result.status, result.message);
    return result;
  };
  if(usesSemantic()) {
    indexScope=createProjectIndexScope([fixedSemantic() ? workspace : join(workspace,'allowed')]);
    if(mode==='semantic-fixed-warm') {
      await writeFile(join(workspace,'allowed','a.ts'),semanticBody('WRONG_LIVE_CAPSULE'));
      for(let index=0;index<5;index++) await writeFile(join(workspace,'allowed',`live-only-${index}.ts`),semanticBody(`LIVE_ONLY_${index}`));
      for(let index=0;index<5;index++) await writeFile(join(workspace,'private',`secret-${index}.ts`),semanticBody(`FORBIDDEN_SOURCE_${index}`));
    }
    let encoder = createHashEmbedder();
    if (localSemantic()) {
      const candidateRoot = join(root, 'component-fixture');
      const component = await localComponentFixture(candidateRoot, { batchSize: 2 });
      const archive = join(root, 'local-semantic.tar.gz');
      await createTar({ file: archive, cwd: candidateRoot, gzip: true }, ['manifest.json', ...Object.keys(component.manifest.files)]);
      const manager = createLocalSemanticComponentManager({ dataDir: join(root, 'semantic-data'), version: 'fixture' });
      await manager.importArchive(archive);
      assert.equal(manager.status().status, 'ready', JSON.stringify(manager.status()));
      await manager.dispose();
      localModelRoot = resolveInstalledModelPack(join(root, 'semantic-data'))!.root;
      localValidationCalls = (await localCalls()).length;
      assert.equal(localValidationCalls, 1, 'the original component validator executed the real worker protocol');
      encoder = createLocalSemanticEmbedder({ dataDir: join(root, 'semantic-data') });
      localEncoder = encoder;
      if (mode === 'semantic-local-queued') {
        await encoder.prepare();
        localBackground = encoder.embed(['HOLD_FORWARD independent-background']);
        await waitForLocalForward();
      }
    }
    const filesystem=createFsSearchRuntime({compute});
    semantic=createWorkspaceSemanticRuntime({dataDir:join(root,'semantic-data'),hostId:HOST,
      documents,structureSource:createStructureSource([syntax]),searchFilesystemFiles:filesystem.searchFilesystemFiles,
      isIndexablePath:async(id,resource,signal,options)=>filesystem.isSearchableFile((await documents.inspectWorkspace(id)).root,resource,signal,options),
      scheduler:createEmbedScheduler(),embedder:encoder,getIndexScope:indexScope.get,runtimeInference:inference,
      onError:error=>console.error('semantic fixture',error)});
    if(mode!=='semantic-cold' && (!fixedSemantic() || mode==='semantic-fixed-warm')) {
      backgroundScan=true;
      try { await semantic.scanWorkspace(identity.workspaceId);await semantic.drain(); }
      finally { backgroundScan=false; }
    }
  }
  const model=createRetrievalModelStage({models:createModelAuthority(credentials),inference,readGlobalSettings:()=>credentials.readGlobalInferenceSettings(),kernel,sources});
  extensions=await ApplicationExtensionRuntime.create({dataDir:join(root,'extensions'),varinVersion:'0.9.25',
    brokerScript:resolve('packages/extension-host/broker/broker-child.mjs')});
  await extensions.start();
  await extensions.upsertServiceRoutingRule({expectedRevision:(await extensions.routing.read()).document.revision,
    rule:{scope:{threadId:'thread:parent'},serviceId:'varin.retrieval.plan',version:1,allowFallback:false,
      providerKeys: [`varin.builtin.retrieval-${mode==='syntax'?'structured':mode==='semantic'||usesSemantic()?'semantic':'keyword'}:host:varin.retrieval.plan@1`]}});
  const composition=createRetrievalComposition(extensions,{structure:syntax,syntax,
    prepareSemantic:async(scope,signal)=>{
      if(!semantic||!scope.query||!scope.inference) throw new Error('Semantic inference is not configured');
      const query=scope.query,active=signal??new AbortController().signal;
      const roots=query.paths??kernel.sourceGrant(query).pathScopes;
      const sourceView=query.source.mode==='live_root'?undefined:await sources.semanticView(query,active);
      if(sourceView && mode==='semantic-fixed-guard-stale') {
        const validate=sourceView.validateDocuments;
        sourceView.validateDocuments=async(documents,signal)=>{
          if(documents.length && !guardMutation) {
            guardMutation=true;guardPath=documents[0]!.path;
            await editMaterialized(guardPath,semanticBody('CHANGED_BEFORE_DOCUMENT_MODEL'),'guard');
          }
          await validate(documents,signal);
        };
      }
      return semantic.acquireQuery({workspaceId:query.source.workspace_id,inference:scope.inference,roots,signal:active,
        ...(sourceView?{sourceView}:{}),
        authorize:requestSignal=>sources.validate(query,requestSignal),assertAuthorized:()=>{kernel.sourceGrant(query);}});
    },
    prepareModel:(scope,signal)=>{assert(scope.query);return model.prepare(scope.query,signal??new AbortController().signal,scope.inference);}});
  const retrieve=createRetrievalOwner({sources,kernel,inferenceRequests:inference.requests!,
    preparePipeline:async(query,signal,call)=>composition.prepare({threadId:query.threadId,workspaceId:await sources.routingWorkspace(query,signal),query,inference:call},signal)});
  kernel.setRetrievalOwner(async(query,signal)=>{
    if(mode==='semantic-fixed-chain' && retrievalCalls===2)
      await editMaterialized('allowed/a.ts',semanticBody('EDITED_MAGENTA_CAPSULE_紫'),'repeat');
    if(mode==='semantic-fixed-chain' && retrievalCalls===3)
      await credentials.storeCredential('controlled-second-account-key','embedding');
    const expected=fixedSemantic()?await sourceDocuments():undefined;
    if (mode === 'semantic-local-stop' && !localCancelScheduled) {
      localCancelScheduled = true;
      void waitForLocalForward().then(async () => {
        await withMaterialReviewClient(runtime, {} as ThreadMaterialsAPI, api => api.cancelRun(runId));
        write({ kind: 'fixture-body-cancelled', drained: false });
      }).catch(error => write({ kind: 'fixture-failed', error: String(error) }));
    }
    const result=await retrieve(query,signal);
    retrievalCalls++;
    if(fixedSemantic()) queryFacts.push({question:query.question,localCalls: (await localCalls()).length - localValidationCalls,documentRequests,indexRequests,embeddingRequests,fixedUnits,expected,
      status:result.status,stages:result.stages});
    else if (usesDecision()) queryFacts.push({ status: result.status, diagnostics: result.diagnostics, coverage: result.coverage,
      snippets: result.snippets.map(({ path, startLine, endLine }) => ({ path, startLine, endLine })) });
    if(mode==='semantic-credential'&&retrievalCalls===1) await credentials.storeCredential('controlled-second-account-key','embedding');
    if(result.status==='failed') console.error('retrieval fixture failure',sourceMode,mode,result.message,result.stages);
    return result;
  });
  write({kind:'fixture-prepared',source:selectedSource});
}
async function handle(frame:Record<string,unknown>) {
  if(frame.kind==='fixture-initialize') {await initialize(frame);return;}
  if(frame.kind==='fixture-response') {
    const waiting=pending.get(String(frame.id));assert(waiting);pending.delete(String(frame.id));
    if(frame.ok)waiting.resolve(frame.result);else waiting.reject(new Error(String(frame.error)));return;
  }
  if(frame.kind==='fixture-configure-child') {
    // A user-selected existing retrieval model, with no tool-array override.
    const settingsPath=join(root,'agent','agent-settings.json');
    const settings=JSON.parse(await readFile(settingsPath,'utf8')) as {harness:{models?:Record<string,unknown>}};
    settings.harness.models={...settings.harness.models,retrievalAgent:{providerId:'explore',modelId:'explore-model'}};
    await writeFile(settingsPath,JSON.stringify(settings));
    const models=createModelAuthority(credentials);
    const resolved=await models.resolveModel({providerId:'explore',modelId:'explore-model'});
    const parent={configuration:resolved.configuration,credential_scope:await resolved.credentialOwner.scope()};
    const prepare=createChildProfilePreparer({models,settings:()=>credentials.readGlobalInferenceSettings(),
      capabilities:async()=>frame.capabilities as ChildCapabilityDescriptor[]});
    const catalog=await prepare({parent});
    write({kind:'fixture-child-configured',parent,catalog});return;
  }
  if(frame.kind==='fixture-select'||frame.kind==='fixture-select-child') {
    runId=String(frame.runId);
    const source=frame.source as LaunchSource;
    const child=frame.kind==='fixture-select-child', threadId=child?String(frame.threadId):'thread:parent';
    if (child && localSemantic()) await extensions.upsertServiceRoutingRule({ expectedRevision: (await extensions.routing.read()).document.revision,
      rule: { scope: { threadId }, serviceId: 'varin.retrieval.plan', version: 1, allowFallback: false,
        providerKeys: ['varin.builtin.retrieval-semantic:host:varin.retrieval.plan@1'] } });
    if(source.mode!=='live_root') {
      const seed=await kernel.issueGrant({grantId:`source-view-fixture-materialize:${runId}`,threadId,runId,
        owningWorkspace:source.workspace_id,executionWorkspace:source.execution_workspace_id,capabilities:['storage.read','storage.write'],pathScopes:['']});
      const actor=kernel.scoped(seed);
      if(source.mode==='materialized') {
        const location=await originalMaterializationLocation(String(kernel.handshake!.storageRoot),source.workspace_id,runId);
        const container=await actor.fileRootRegister({workspaceId:source.workspace_id,executionWorkspaceId:source.execution_workspace_id,canonicalRoot:String(kernel.handshake!.storageRoot)});
        const branch=await actor.readBranch({branchId:source.branch_id!,revision:source.revision!,includeEntries:false});
        await actor.fileMaterialize({operationId:`source-view-materialize:${runId}`,workspaceId:source.workspace_id,rootId:String(container.rootId),path:location.relativeTarget,sourceRoot:branch.root});
        const registered=await actor.fileRootRegister({workspaceId:source.workspace_id,executionWorkspaceId:source.execution_workspace_id,canonicalRoot:location.targetPath});
        physicalRoot={hostId:HOST,rootId:String(registered.rootId),canonicalRoot:location.targetPath};
        if(!mode.startsWith('llm-')&&!mode.startsWith('decision-')) {
          const address={workspaceId:source.workspace_id,rootId:physicalRoot.rootId,path:'allowed/a.ts'};
          const captured=await actor.fileCapture({...address,operationId:`source-view-before-edit:${runId}`,store:false});
          const bytes=Buffer.from(fixedSemantic()?semanticBody('WORKING_MAGENTA_CAPSULE_紫'):'// actual working copy padding\n'.repeat(4000)+'export const retrievalNeedle = "SOURCE_A_WORKING_COPY";\n');
          const blob=await actor.putBlob(bytes,`source-view-cas-edit:${runId}`);
          const applied=await actor.fileApply({...address,operationId:`source-view-apply-edit:${runId}`,expectedJson:String(captured.stateJson),
            targetJson:JSON.stringify({kind:'regular-file',objectHash:blob.hash,byteLength:bytes.byteLength,
              mode:(JSON.parse(String(captured.stateJson)) as { mode?: number }).mode}),ownerId:blob.ownerId});
          assert.equal(applied.status,'applied');await actor.releaseBlob(blob.ownerId);
        }
      }
      if(!child) {
      // The source revision survives both a diverging branch head and a missing original live path.
      const changed=await actor.putBlob(Buffer.from('export const retrievalNeedle = "WRONG_NEW_HEAD";\n'),'source-view-new-head');
      const branch=await actor.readBranch({branchId:source.branch_id!,includeEntries:false});
      await actor.writeBranch({operationId:'source-view-head-edit',branchId:source.branch_id!,expectedWriteRevision:branch.writeRevision,
        changes:[{path:mode.startsWith('llm-')||mode.startsWith('decision-')?'allowed/seed.ts':'allowed/a.ts',ownerId:changed.ownerId,
          state:{kind:'regular-file',objectHash:changed.hash,byteLength:changed.byteLength,mode:420}}]});
      await actor.releaseBlob(changed.ownerId);
      await rename(join(root,'workspace'),join(root,'detached-original-workspace'));
      }
      await kernel.revokeGrant(seed.grantId);
    }
    grant=await kernel.issueGrant({grantId:`rerank-grant:${runId}`,threadId,runId,
      owningWorkspace:source.workspace_id,executionWorkspace:source.execution_workspace_id,capabilities:['storage.read'],
      pathScopes:child?frame.pathScopes as string[]:frame.childParent?['']:['allowed']});
    write({kind:'fixture-prepared',grantId:grant.grantId,physicalRoot});return;
  }
  if(frame.kind==='fixture-native-request') {
    await withMaterialReviewClient(runtime,{} as ThreadMaterialsAPI,api=>api.cancelRun(runId));return;
  }
  if(frame.kind==='fixture-native-body-cancelled') {write({kind:'fixture-body-cancelled',drained:false});return;}
  if(frame.kind==='fixture-release-body') {if(mode==='semantic-local-stop'){await writeFile(join(localModelRoot!, 'release'), 'yes');}else if(mode==='llm-stop'){drained=true;write({kind:'fixture-native-release'});}else releaseBody();return;}
  if(frame.kind==='fixture-finish') {
    // Publishing may outlive the detached caller. Wait for that existing owner's completion before exit.
    const facts=ledger?await ledger.list():[];
    if (mode === 'semantic-local-stop') { await inference.requests!.close(); drained = true; }
    if (mode === 'semantic-local-queued') {
      await writeFile(join(localModelRoot!, 'release'), 'yes'); await localBackground;
      await localEncoder!.embed(['unrelated-after-cancel']);
    }
    await semantic?.dispose();indexScope?.dispose();await inference.close();await extensions.stop();await compute.dispose();await documents.dispose();
    write({kind:'fixture-finished',localCalls:(await localCalls()).slice(localValidationCalls),localValidationCalls,requests,bodies,drained,syntaxComputations,embeddingRequests,indexRequests,documentRequests,documentInputs,backgroundInputs,fixedUnits,lexicalSearches,queryFacts,guardMutation,guardPath,retrievalCalls,ledgerFacts:facts});return;
  }
  (kernel as unknown as {consumeFrame(value:unknown):void}).consumeFrame(frame);
}
createInterface({input:process.stdin}).on('line',line=>{
  void handle(JSON.parse(line) as Record<string,unknown>).catch(error=>write({kind:'fixture-failed',error:String(error),stack:error instanceof Error?error.stack:undefined}));
});
