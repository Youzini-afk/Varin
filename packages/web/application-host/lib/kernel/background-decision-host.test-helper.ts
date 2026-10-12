/** Installed decision -> original PDF/credential owners -> Catalog, with controlled bytes.
 * Only request delivery is test stdio. No real listener/account/provider is used. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { WEB_CAPABILITY, VARIN_BUILTIN_WEB_EXTENSION_ID, RESEARCH_DECISION_CAPABILITY,
  VARIN_BUILTIN_RESEARCH_DECISION_EXTENSION_ID } from '@varin/extension-builtins';
import { HostCredentialAuthority } from '@varin/pi-host/credentials';
import type { ExtensionToolBinding } from './protocol.generated.js';
import { KernelStorageAdapter } from './storage-adapter.js';
import { createMaterialStorageAccess, threadMaterialScope } from './material-storage.js';
import { createWebRuntime } from './web-runtime.js';
import { createResearchDecisionRuntime } from './research-decision.js';
import { createSemanticInference } from '../knowledge/semantic/runtime-inference.js';
import { createExtensionTools, type ExtensionToolScope } from './extension-tool-owner.js';
import { createEgressRuntime } from '../harness/egress.js';
import { checkSsrf, isSameHost } from '../harness/ssrf-policy.js';
import { createWebFetch } from '../harness/web-fetch.js';
import { createWebMaterialStore } from '../harness/web-materials.js';
import { createDocumentReader } from '../harness/document-reading.js';
import { createMaterialReviewFixture, withMaterialReviewClient, writeMaterialFixtureFrame as write } from './material-review-fixture.test-helper.js';
import { makePdf } from '../harness/pdf-test-fixture.js';
const unreachable = async (): Promise<never> => { throw new Error('Decision fixture attempted a Pi worker or physical source'); };
const fixture = createMaterialReviewFixture(params => {
  assert.equal(params.sessionId, undefined); assert.deepEqual(params.pathScopes, []);
  assert.equal(params.owningWorkspace, threadMaterialScope('thread:parent'));
});
const { kernel, runtime, bridge } = fixture;
let storage: KernelStorageAdapter, extensions: ApplicationExtensionRuntime;
let web: ReturnType<typeof createWebRuntime>, decision: ReturnType<typeof createResearchDecisionRuntime>;
let inference: ReturnType<typeof createSemanticInference>;
const scopes: ExtensionToolScope[] = [];
let requests = 0, pdfFetches = 0, mode = '', bodyDrained = false;
let stopping: Promise<void> | undefined;
const egress = createEgressRuntime({ env: {}, resolveAll: async () => [{ address: '93.184.216.34', family: 4 }],
  systemFetch: async (input, init) => {
    init.signal?.throwIfAborted();
    if (input === 'https://paper.invalid/paper.pdf') { pdfFetches++; return new Response(new Uint8Array(makePdf()), { headers: { 'content-type': 'application/pdf' } }); }
    assert.equal(input,mode.startsWith('retry-')?'https://classifier.invalid/account/ai/run':'https://classifier.invalid/systemone'); assert.equal(init.method,'POST');
    assert.equal(new Headers(init.headers).get('authorization'),'Bearer fixture-only-no-real-key');
    requests++;
    const raw = JSON.parse(String(init.body)) as { state: { goal: string; materials: unknown[] }; questions: Record<string,unknown>; input?: { state: { goal: string; materials: unknown[] }; questions: Record<string,unknown> } };
    const body = raw.input ?? raw;
    assert.equal('messages' in body,false,'decision is not a chat request');
    if(mode.startsWith('retry-')) {
      assert(raw.input,'original Cloudflare payload is retained');
      if(requests===1) return Response.json(mode==='retry-known'
        ? {success:true,result:{answers:{},usage:{input_tokens:5,output_tokens:1}}}
        : {success:false,errors:[{message:'Temporarily unavailable'}]}, {status:503,headers:{'retry-after':'0'}});
      assert.equal(mode,'retry-known','Goal unknown usage must fence the next paid request');
      return Response.json({success:true,result:{state:'Completed',result:{answers:{url:{type:'score',score:0}},usage:{input_tokens:13,output_tokens:2}}}});
    }
    if(mode==='settle-failure' || mode==='stop-settle') return Response.json({answers:{url:{type:'score',score:1}},usage:{input_tokens:19,output_tokens:4}});
    if (mode === 'stop') {
      assert(init.signal);
      let release!: () => void;
      const allowDrain = new Promise<void>(resolve => { release=resolve; });
      let aborted!: () => void;
      const sawAbort = new Promise<void>(resolve => { aborted=resolve; });
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        init.signal!.addEventListener('abort', () => {
          aborted();
          void allowDrain.then(() => { bodyDrained=true; controller.error(new DOMException('Original controlled transport stopped','AbortError')); });
        }, { once:true });
      } });
      stopping = (async () => {
        const operations = await runtime.activeOperations('thread:parent','branch:parent');
        const operation = operations.find(value => (value.intent as { kind?: string }).kind === 'decision_request_v1'); assert(operation);
        await withMaterialReviewClient(runtime, web.user, async api => {
          const receipt = await api.cancelOperation(operation.id); assert.equal(receipt.id,operation.id);
        });
        await sawAbort;
        assert.equal(bodyDrained,false,'cancellation acknowledgement is not transport drain');
        const pending=await runtime.operation(operation.id); assert.notEqual(pending.phase,'terminal');
        release();
      })().catch(error => { release(); write({kind:'fixture-failed',error:String(error)}); throw error; });
      return new Response(stream,{headers:{'content-type':'application/json'}});
    }
    assert(JSON.stringify(body.state.materials).includes('LEFT'),'classifier must receive extracted original PDF text');
    assert.equal(pdfFetches,1,'material judging never fetches the paper again');
    const usage = body.state.goal.includes('partial') ? { input_tokens:17 } : { input_tokens:19, output_tokens:4 };
    return Response.json({ ...(body.state.goal.includes('invalid') ? {} : {answers:{pdf:{type:'score',score:0}}}), usage });
  } });
async function select(frame: Record<string,unknown>) {
  const runId=String(frame.runId), threadId=String(frame.threadId);
  const prepare=createExtensionTools({runtime:extensions,kernel,currentPolicy:async()=>({mode:'normal',rules:[]}),
    prepareConfiguration:async(run,required)=>decision.prepareConfiguration(run,required,await web.prepareConfiguration(run,required))});
  const selected=await prepare({threadId,runId,source:null},(frame.required??[]) as ExtensionToolBinding[],new AbortController().signal);
  scopes.push(selected);
  const bindings=selected.initial.filter(entry=>['research_decide','webfetch'].includes(entry.binding.tool.name)).map(entry=>{
    const registered=bridge.register(runId,entry.lease); return {ownerId:registered.ownerId,generation:entry.generation,binding:entry.binding};
  });
  write({kind:'fixture-prepared',bindings});
}
async function initialize(frame:Record<string,unknown>) {
  fixture.initialize(frame); mode=String(frame.mode);
  if(mode==='stop-settle') {
    const original=kernel.agentRuntimeRequest.bind(kernel);
    let stopBeforeSettle:Promise<void>|undefined;
    kernel.agentRuntimeRequest=async (method,params,signal,options) => {
      if(method==='runtime.inference.settle') {
        bodyDrained=true;
        const operationId=(params as {operationId:string}).operationId;
        stopBeforeSettle??=withMaterialReviewClient(runtime,web.user,async api=>{
          const receipt=await api.cancelOperation(operationId); assert.equal(receipt.id,operationId);
        });
        // Reconciliation may publish the same receipt concurrently. Hold every
        // delivery at this same finite window until the real Stop commits.
        await stopBeforeSettle;
      }
      return original(method,params,signal,options);
    };
  }
  const root=String(frame.root), agentDir=join(root,'agent'); await mkdir(agentDir,{recursive:true});
  const api=mode.startsWith('retry-')?'cloudflare-workers-ai-system-one':'typesafe-system-one';
  const baseUrl=mode.startsWith('retry-')?'https://classifier.invalid/account/ai':'https://classifier.invalid';
  await writeFile(join(agentDir,'models.json'),JSON.stringify({providers:{'decision-review':{
    apiKey:'fixture-only-no-real-key',baseUrl,models:[{id:'classifier',type:'classifier',api}],
    capabilities:{decision:{protocol:'pi-classifier',models:[{id:'classifier',api}]}}
  }}}));
  await writeFile(join(agentDir,'settings.json'),JSON.stringify({harness:{fastDecision:{default:{protocol:'pi-classifier',providerId:'decision-review',modelId:'classifier'}}}}));
  const credentials=HostCredentialAuthority.open(agentDir);
  inference=createSemanticInference(credentials,undefined,{decision:{kernel,runtime,egress}});
  storage=new KernelStorageAdapter({client:kernel,hostId:'web-domain-host',storageRoot:String(frame.storageRoot),resolveWorkspaceRoot:unreachable});
  const access=createMaterialStorageAccess({kernel,storage,legacy:{withBranchStore:unreachable}});
  const materials=createWebMaterialStore(access), documentReader=createDocumentReader({materials});
  const settings=async()=>({global:{},globalRevision:'fixture',project:{},projectRevision:'none',projectTrusted:false});
  web=createWebRuntime({runtime,webFetch:createWebFetch({ssrf:{check:checkSsrf,isSameHost},egress,materials,documentReader}),
    documentReader,materials,fetch:egress.fetch as typeof globalThis.fetch,readAuth:unreachable,settings});
  decision=createResearchDecisionRuntime({inference,materials:web,settings});
  extensions=await ApplicationExtensionRuntime.create({dataDir:join(root,'extensions'),varinVersion:'0.9.25',brokerScript:join(resolve('.'),'packages/extension-host/broker/broker-child.mjs')});
  extensions.capabilities.register(WEB_CAPABILITY,web.capability);
  extensions.capabilities.register(RESEARCH_DECISION_CAPABILITY,decision.capability);
  await extensions.start(); await extensions.activateExtension(VARIN_BUILTIN_WEB_EXTENSION_ID); await extensions.activateExtension(VARIN_BUILTIN_RESEARCH_DECISION_EXTENSION_ID);
  await select(frame);
}
async function receive(frame:Record<string,unknown>) {
  if(frame.kind==='fixture-initialize') return initialize(frame);
  if(fixture.receive(frame)) return;
  if(frame.kind==='fixture-select') return select(frame);
  if(frame.kind==='fixture-finish') {
    await stopping; for(const scope of scopes)scope.close(); await bridge.close(); await inference.close(); await extensions.stop(); await storage.dispose(); await egress.close();
    write({kind:'fixture-finished',requests,pdfFetches,bodyDrained}); return;
  }
  throw new Error(`Unexpected decision frame ${String(frame.kind)}`);
}
createInterface({input:process.stdin}).on('line',line=>{
  void receive(JSON.parse(line) as Record<string,unknown>).catch(error=>write({kind:'fixture-failed',error:error instanceof Error?error.stack:String(error)}));
});
