/** Original retrieval/configuration/credential owners over test stdio, never product IPC.
 * Storage authorizes actual files/compute; only inference provider bytes are controlled. */
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { HostCredentialAuthority } from '@varin/pi-host/credentials';
import type { ThreadMaterialsAPI } from '@varin/application-client';
import { createDocumentAuthority } from '../documents/authority.js';
import { createEgressRuntime } from '../harness/egress.js';
import { createSemanticInference } from '../knowledge/semantic/runtime-inference.js';
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
let credentials:HostCredentialAuthority;
let compute:ReturnType<typeof createKernelComputeService>, syntaxComputations=0;
let releaseBody:()=>void=()=>{throw new Error('No original body to release');};
const bodies:unknown[]=[];
function request(method:string,params:unknown,options:{grant?:KernelGrantHandle}={}) {
  if(method==='compute.start'&&(params as {operation?:string}).operation==='structure') syntaxComputations++;
  if(options.grant) kernel.assertGrantForScope(options.grant);
  const id=`rerank-review:${++sequence}`;
  return new Promise((resolve,reject)=>{
    pending.set(id,{resolve,reject});
    write({kind:'fixture-request',id,method,params,...(options.grant?{grantId:options.grant.grantId}:{})});
  });
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
  void withMaterialReviewClient(runtime,{} as ThreadMaterialsAPI,api=>api.cancelRun(runId))
    .catch(error=>write({kind:'fixture-failed',error:String(error)}));
  return new Response(stream,{headers:{'content-type':'application/json'}});
}
const egress=createEgressRuntime({env:{},resolveAll:async()=>[{address:'93.184.216.34',family:4}],
  systemFetch:async(url,init)=>{
    if(mode.startsWith('decision-')||mode==='llm-auto') {
      assert.equal(String(url),'https://rerank.invalid/models/systemone');
      assert.equal(new Headers(init.headers).get('authorization'),'Bearer controlled-rerank-key');
      const body=JSON.parse(String(init.body)) as {model:string;state:{goal:string;materials:Array<{id:string;text:string;label:string}>};questions:Record<string,unknown>};
      bodies.push(body);requests++;
      assert.equal(body.model,'classifier');
      assert.equal(body.state.goal,mode.startsWith('llm-')?'How does retrievalNeedle resolve its dependency?':'retrievalNeedle');
      assert(body.state.materials.every(material=>!material.text.includes('FORBIDDEN_SOURCE')));
      assert.equal('messages' in body,false);
      if(mode==='llm-auto') assert(Object.keys(body.questions).every(id=>id.startsWith('a:')),'classifier keeps only its original action duty');
      if(mode==='decision-stop') return heldResponse(init);
      const usage=mode==='decision-unknown'?{input_tokens:7}:{input_tokens:requests*7,output_tokens:requests};
      if(mode==='decision-partial'&&body.state.materials.some(material=>material.text.includes('DISCOVERED_HELPER'))) return Response.json({answers:'invalid original second batch',usage});
      const answers=Object.fromEntries(Object.keys(body.questions).map(id=>[id,{type:'noul',noul:id.startsWith('m:')||id==='a:symbol:hiddenHelper'||id==='a:read:allowed/helper.ts'?1:0}]));
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
  if(mode.startsWith('decision-')||mode.startsWith('llm-')) {
    await writeFile(join(workspace,'allowed','seed.ts'),'export const retrievalNeedle = hiddenHelper();\n');
    await writeFile(join(workspace,'allowed','helper.ts'),'export function hiddenHelper() { return "DISCOVERED_HELPER"; }\n');
  } else {
    for(const [file,value] of [['a','SOURCE_A'],['b','SOURCE_B'],['c','SOURCE_C']])
      await writeFile(join(workspace,'allowed',`${file}.ts`),`export const retrievalNeedle = "${value}";\n`);
  }
  await writeFile(join(workspace,'private','secret.ts'),'export const retrievalNeedle = "FORBIDDEN_SOURCE";\n');
  if(sourceMode!=='live_root'&&!mode.startsWith('llm-')&&!mode.startsWith('decision-'))
    await writeFile(join(workspace,'allowed','a.ts'),'// original source padding\n'.repeat(4000)+'export const retrievalNeedle = "SOURCE_A";\n');
  await writeFile(join(agentDir,'models.json'),JSON.stringify({providers:{rank:{apiKey:'controlled-rerank-key',baseUrl:'https://rerank.invalid/models',chat:false,
    capabilities:{rerank:{protocol:'http-rerank',models:[{id:'ranker'}]},decision:{protocol:'pi-classifier',models:[{id:'classifier',api:'typesafe-system-one'}]}}},
    explore:{baseUrl:'https://explore.invalid/v1',apiKey:'controlled-explore-key',api:'openai-responses',models:[{id:'explore-model',name:'Original configured Explore',contextWindow:32768,maxTokens:2000,input:['text']}]}}}));
  await writeFile(join(agentDir,'settings.json'),JSON.stringify({harness:{codeRetrieval:{decision:mode==='llm-auto'?'auto':mode.startsWith('llm-')||mode==='unconfigured-model'?'llm':mode.startsWith('decision-')?'fast-decision':['source','syntax','semantic'].includes(mode)?'source':'rerank'},
    rerank:{protocol:'http-rerank',providerId:'rank',modelId:'ranker'},
    models:mode.startsWith('llm-')?{explore:{providerId:'explore',modelId:'explore-model'}}:undefined,
    fastDecision:mode.startsWith('decision-')||mode==='llm-auto'?{default:{protocol:'pi-classifier',providerId:'rank',modelId:'classifier'}}:undefined}}));
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
  selectedSource={workspace_id:identity.workspaceId,execution_workspace_id:identity.workspaceId,
    mode:'live_root',branch_id:null,revision:null,live_root:await live.prepare(identity.workspaceId,identity.workspaceId,'thread:parent')};
  physicalRoot=selectedSource.live_root;
  if(sourceMode!=='live_root') {
    const seed=await kernel.issueGrant({grantId:'source-view-fixture-seed',threadId:'thread:parent',
      owningWorkspace:identity.workspaceId,executionWorkspace:identity.workspaceId,capabilities:['storage.read','storage.write'],pathScopes:['']});
    const actor=kernel.scoped(seed), entries=[];
    for(const file of mode.startsWith('llm-')||mode.startsWith('decision-')?['allowed/seed.ts','allowed/helper.ts','private/secret.ts']:['allowed/a.ts','allowed/b.ts','allowed/c.ts','private/secret.ts']) {
      const bytes=await readFile(join(workspace,file)), blob=await actor.putBlob(bytes,`source-view:${file}`);
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
  credentials=HostCredentialAuthority.open(agentDir);
  inference=createSemanticInference(credentials,undefined,{requests:{kernel,runtime,egress}});
  const sources=createRetrievalSourceOwner({kernel,documents,validateLiveSource:live.validate});
  compute=createKernelComputeService({client:kernel,resolveIdentity:async()=>{throw new Error('Fixed syntax must only consume its admitted supplied text');}});
  const syntax=createTreeSitterStructureProvider({compute});
  const model=createRetrievalModelStage({models:createModelAuthority(credentials),inference,readGlobalSettings:()=>credentials.readGlobalInferenceSettings(),kernel,sources});
  extensions=await ApplicationExtensionRuntime.create({dataDir:join(root,'extensions'),varinVersion:'0.9.25',
    brokerScript:resolve('packages/extension-host/broker/broker-child.mjs')});
  await extensions.start();
  await extensions.upsertServiceRoutingRule({expectedRevision:(await extensions.routing.read()).document.revision,
    rule:{scope:{sessionId:'thread:parent'},serviceId:'varin.retrieval.plan',version:1,allowFallback:false,
      providerKey:`varin.builtin.retrieval-${mode==='syntax'?'structured':mode==='semantic'?'semantic':'keyword'}:host:varin.retrieval.plan@1`}});
  const composition=createRetrievalComposition(extensions,{structure:syntax,syntax,
    prepareSemantic:async()=>{throw new Error('Non-live retrieval cannot acquire the live published semantic reader');},
    prepareModel:(scope,signal)=>{assert(scope.query);return model.prepare(scope.query,signal??new AbortController().signal);}});
  const retrieve=createRetrievalOwner({sources,kernel,
    preparePipeline:async(query,signal)=>composition.prepare({threadId:query.threadId,workspaceId:await sources.routingWorkspace(query,signal),query},signal)});
  kernel.setRetrievalOwner(async(query,signal)=>{
    const result=await retrieve(query,signal);
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
    const settingsPath=join(root,'agent','settings.json');
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
          const bytes=Buffer.from('// actual working copy padding\n'.repeat(4000)+'export const retrievalNeedle = "SOURCE_A_WORKING_COPY";\n');
          const blob=await actor.putBlob(bytes,`source-view-cas-edit:${runId}`);
          const applied=await actor.fileApply({...address,operationId:`source-view-apply-edit:${runId}`,expectedJson:String(captured.stateJson),
            targetJson:JSON.stringify({kind:'regular-file',objectHash:blob.hash,byteLength:bytes.byteLength,mode:420}),ownerId:blob.ownerId});
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
  if(frame.kind==='fixture-release-body') {if(mode==='llm-stop'){drained=true;write({kind:'fixture-native-release'});}else releaseBody();return;}
  if(frame.kind==='fixture-finish') {
    // Publishing may outlive the detached caller. Wait for that existing owner's completion before exit.
    await inference.close();await extensions.stop();await compute.dispose();await documents.dispose();
    write({kind:'fixture-finished',requests,bodies,drained,syntaxComputations});return;
  }
  (kernel as unknown as {consumeFrame(value:unknown):void}).consumeFrame(frame);
}
createInterface({input:process.stdin}).on('line',line=>{
  void handle(JSON.parse(line) as Record<string,unknown>).catch(error=>write({kind:'fixture-failed',error:String(error),stack:error instanceof Error?error.stack:undefined}));
});
