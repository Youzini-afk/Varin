/** Original retrieval/configuration/credential owners over test stdio, never product IPC.
 * Storage authorizes actual files/compute; only inference provider bytes are controlled. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
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
import { createRetrievalModelStage } from './retrieval-model.js';
import { createRetrievalOwner } from './retrieval-owner.js';
import { withMaterialReviewClient, writeMaterialFixtureFrame as write } from './material-review-fixture.test-helper.js';
import type { KernelHandshakeResult } from './protocol.generated.js';
const HOST='web-domain-host', GENERATION='web-domain-generation';
const pending=new Map<string,{resolve(value:unknown):void;reject(error:Error):void}>();
let sequence=0, mode='', root='', runId='', requests=0, drained=false;
let kernel:KernelClient, runtime:AgentRuntimeClient;
let documents:ReturnType<typeof createDocumentAuthority>, extensions:ApplicationExtensionRuntime;
let inference:ReturnType<typeof createSemanticInference>, grant:KernelGrantHandle;
let releaseBody:()=>void=()=>{throw new Error('No original body to release');};
const bodies:unknown[]=[];
function request(method:string,params:unknown,options:{grant?:KernelGrantHandle}={}) {
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
    if(mode.startsWith('decision-')) {
      assert.equal(String(url),'https://rerank.invalid/models/systemone');
      assert.equal(new Headers(init.headers).get('authorization'),'Bearer controlled-rerank-key');
      const body=JSON.parse(String(init.body)) as {model:string;state:{goal:string;materials:Array<{id:string;text:string;label:string}>};questions:Record<string,unknown>};
      bodies.push(body);requests++;
      assert.equal(body.model,'classifier');
      assert.equal(body.state.goal,'retrievalNeedle');
      assert(body.state.materials.every(material=>!material.text.includes('FORBIDDEN_SOURCE')));
      assert.equal('messages' in body,false);
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
    if(mode==='stale') await writeFile(join(root,'workspace','allowed','c.ts'),'export const retrievalNeedle = "CHANGED_SOURCE_C";\n');
    return Response.json({results:[{index:c,relevance_score:0.9},{index:a,relevance_score:0}],
      usage:{total_tokens:91},meta:{fixture:'raw original usage is not input/output'}});
  }});
async function initialize(frame:Record<string,unknown>) {
  root=String(frame.root);mode=String(frame.mode);
  const workspace=join(root,'workspace'), agentDir=join(root,'agent');
  await mkdir(join(workspace,'allowed'),{recursive:true});await mkdir(join(workspace,'private'),{recursive:true});await mkdir(agentDir,{recursive:true});
  if(mode.startsWith('decision-')) {
    await writeFile(join(workspace,'allowed','seed.ts'),'export const retrievalNeedle = hiddenHelper();\n');
    await writeFile(join(workspace,'allowed','helper.ts'),'export function hiddenHelper() { return "DISCOVERED_HELPER"; }\n');
  } else {
    for(const [file,value] of [['a','SOURCE_A'],['b','SOURCE_B'],['c','SOURCE_C']])
      await writeFile(join(workspace,'allowed',`${file}.ts`),`export const retrievalNeedle = "${value}";\n`);
  }
  await writeFile(join(workspace,'private','secret.ts'),'export const retrievalNeedle = "FORBIDDEN_SOURCE";\n');
  await writeFile(join(agentDir,'models.json'),JSON.stringify({providers:{rank:{apiKey:'controlled-rerank-key',baseUrl:'https://rerank.invalid/models',chat:false,
    capabilities:{rerank:{protocol:'http-rerank',models:[{id:'ranker'}]},decision:{protocol:'pi-classifier',models:[{id:'classifier',api:'typesafe-system-one'}]}}}}}));
  await writeFile(join(agentDir,'settings.json'),JSON.stringify({harness:{codeRetrieval:{decision:mode.startsWith('decision-')?'fast-decision':mode==='source'?'source':mode==='unsupported'?'llm':'rerank'},
    rerank:{protocol:'http-rerank',providerId:'rank',modelId:'ranker'},
    fastDecision:mode.startsWith('decision-')?{default:{protocol:'pi-classifier',providerId:'rank',modelId:'classifier'}}:undefined}}));
  kernel=new KernelClient({hostId:HOST,hostGeneration:GENERATION,storageRoot:String(frame.storageRoot),buildVersion:'0.9.25'});
  // Replace delivery/handshake only. Original grant minting/token checks, bridges and runtime events remain.
  const transport=kernel as unknown as {epoch:string;handshakeResult:KernelHandshakeResult;consumeFrame(value:unknown):void};
  transport.epoch=String(frame.epoch);
  transport.handshakeResult={hostId:HOST,storageRoot:String(frame.storageRoot),kernelEpoch:String(frame.epoch)} as KernelHandshakeResult;
  Object.defineProperty(kernel,'requestRaw',{value:request});
  Object.defineProperty(kernel,'write',{value:async(value:unknown)=>{write(value);}});
  runtime=new AgentRuntimeClient(kernel);
  documents=createDocumentAuthority({hostId:HOST,dataDir:join(root,'documents'),isTrusted:async()=>true,
    isAllowedRoot:async(candidate:string)=>candidate===workspace||candidate.startsWith(workspace+'/')});
  const identity=await documents.resolveWorkspace({path:workspace});
  const live=createLiveSourceOwner({documents,kernel});
  const source={workspaceId:identity.workspaceId,executionWorkspaceId:identity.workspaceId,liveRoot:await live.prepare(identity.workspaceId,identity.workspaceId,'thread:parent')};
  const credentials=HostCredentialAuthority.open(agentDir);
  inference=createSemanticInference(credentials,undefined,{requests:{kernel,runtime,egress}});
  const model=createRetrievalModelStage({inference,readGlobalSettings:()=>credentials.readGlobalInferenceSettings(),kernel,validateSource:live.validate});
  extensions=await ApplicationExtensionRuntime.create({dataDir:join(root,'extensions'),varinVersion:'0.9.25',
    brokerScript:resolve('packages/extension-host/broker/broker-child.mjs')});
  await extensions.start();
  await extensions.upsertServiceRoutingRule({expectedRevision:(await extensions.routing.read()).document.revision,
    rule:{scope:{sessionId:'thread:parent'},serviceId:'varin.retrieval.plan',version:1,allowFallback:false,providerKey:'varin.builtin.retrieval-keyword:host:varin.retrieval.plan@1'}});
  const composition=createRetrievalComposition(extensions,{prepareModel:(scope,signal)=>{assert(scope.query);return model.prepare(scope.query,signal??new AbortController().signal);}});
  kernel.setRetrievalOwner(createRetrievalOwner({documents,kernel,validateSource:live.validate,
    preparePipeline:(query,signal)=>composition.prepare({threadId:query.threadId,workspaceId:source.liveRoot.canonicalRoot,query},signal)}));
  write({kind:'fixture-prepared',source});
}
async function handle(frame:Record<string,unknown>) {
  if(frame.kind==='fixture-initialize') {await initialize(frame);return;}
  if(frame.kind==='fixture-response') {
    const waiting=pending.get(String(frame.id));assert(waiting);pending.delete(String(frame.id));
    if(frame.ok)waiting.resolve(frame.result);else waiting.reject(new Error(String(frame.error)));return;
  }
  if(frame.kind==='fixture-select') {
    runId=String(frame.runId);
    const source=frame.source as {workspaceId:string;executionWorkspaceId:string;liveRoot:{rootId:string}};
    grant=await kernel.issueGrant({grantId:`rerank-grant:${runId}`,threadId:'thread:parent',runId,
      owningWorkspace:source.workspaceId,executionWorkspace:source.executionWorkspaceId,capabilities:['storage.read'],pathScopes:['allowed']});
    write({kind:'fixture-prepared',grantId:grant.grantId});return;
  }
  if(frame.kind==='fixture-release-body') {releaseBody();return;}
  if(frame.kind==='fixture-finish') {
    // Publishing may outlive the detached caller. Wait for that existing owner's completion before exit.
    await inference.close();await extensions.stop();await documents.dispose();
    write({kind:'fixture-finished',requests,bodies,drained});return;
  }
  (kernel as unknown as {consumeFrame(value:unknown):void}).consumeFrame(frame);
}
createInterface({input:process.stdin}).on('line',line=>{
  void handle(JSON.parse(line) as Record<string,unknown>).catch(error=>write({kind:'fixture-failed',error:String(error),stack:error instanceof Error?error.stack:undefined}));
});
