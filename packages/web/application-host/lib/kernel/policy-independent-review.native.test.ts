import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { createAgentPolicy, AgentPolicyBridge } from './agent-policy.js';
import { createContextComposition } from './context-composition.js';
import { createRequire } from 'node:module';
import { createThreadContext } from './thread-context.js';
import { createAgentPersonalization } from '../memory/agent-personalization.js';
import { createThreadSourcePreparer } from './thread-sources.js';
import { createDocumentAuthority } from '../documents/authority.js';
import { KernelStorageAdapter, createKernelWorkspaceWorkingStateAccess } from './storage-adapter.js';
import express from 'express';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createThreadsHttpAPI, configureRuntimeUrlResolver, setRuntimeExtraHeaders } from '@varin/application-client';
import { createKernelClient } from './kernel-client.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { ExistingHostCredentialOwner } from './credential-owner.js';
import { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';
import { registerCommonRequestMiddleware } from '../platform/core-routes.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const { build } = createRequire(path.join(repository, 'packages/extension-builtins/package.json'))('esbuild');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { setRuntimeExtraHeaders(null); configureRuntimeUrlResolver({ apiBaseUrl: '', realtimeBaseUrl: '' }); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture needs a TCP listener');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  return `http://127.0.0.1:${address.port}`;
}
async function fixture(reply: (body: Record<string, unknown>, response: ServerResponse) => void, existingRoot?: string, existingEndpoint?: string) {
  await fs.access(kernelPath);
  const root = existingRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), 'varin-http-review-'));
  const kernel = createKernelClient({ hostId: 'http-review', storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  cleanups.push(async () => { await kernel.close(); if (!existingRoot) await fs.rm(root, { recursive: true, force: true }); });
  const secret = 'fake-http-provider-key-not-a-real-secret';
  const requests: Array<{ body: Record<string, unknown>; authorization?: string }> = [];
  const provider = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (bytes: Buffer) => chunks.push(bytes));
    request.on('end', () => {
      requests.push({ body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>, ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) });
      reply(requests.at(-1)!.body, response);
    });
  });
  const endpoint = existingEndpoint ?? `${await listen(provider)}/responses`;
  const owner = new ExistingHostCredentialOwner({ providerId: 'fixture-provider', providerFamily: 'openai-responses', endpoint,
    currentScope: async () => ({ reference: 'fixture-reference', authority: 'fixture-existing-owner', account: 'fixture-local-handle', generation: 1 }),
    runtime: { getAuth: async () => ({ auth: { apiKey: secret } }) },
  });
  const configuration = { providerFamily: 'openai-responses', model: 'fixture-model', endpoint, credentialEnvironment: null, allowAnonymous: false, configurationGeneration: 1, maxOutputTokens: 64 };
  const launchErrors: unknown[] = [];
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace, { recursive: true });
  const documents = createDocumentAuthority({ hostId: 'http-review', dataDir: path.join(root, 'documents'), isAllowedRoot: async () => true, isTrusted: async () => true });
  const storage = new KernelStorageAdapter({ client: kernel, hostId: 'http-review', storageRoot: root, resolveWorkspaceRoot: async id => (await documents.inspectWorkspace(id)).root });
  const workingStates = createKernelWorkspaceWorkingStateAccess(storage);
  const prepare = createThreadSourcePreparer({ documents, workingStates });
  let refresh = () => Promise.resolve();
  const refreshTasks: Promise<void>[] = [];
  const personalization = createAgentPersonalization({ client: kernel, context: async () => ({ bot: false, projectId: 'selected-project' }), onChanged: () => { const task = refresh(); void task.catch(() => undefined); refreshTasks.push(task); } });
  const extensions = await ApplicationExtensionRuntime.create({ dataDir: path.join(root, 'extensions'), varinVersion: buildVersion,
    brokerScript: path.join(repository, 'packages/extension-host/broker/broker-child.mjs') });
  await extensions.start(); cleanups.push(() => extensions.stop());
  const composition = createContextComposition(extensions);
  const prepareContext = createThreadContext({ composition, personalization, workingStates, projectForWorkspace: async () => 'selected-project' });
  const decisions: unknown[]=[]; let pins=0;
  const originalPrepare=extensions.prepareService.bind(extensions);
  extensions.prepareService=async(...args)=>{const binding=await originalPrepare(...args); if(args[0] && typeof args[0]==='object' && 'serviceId' in args[0] && args[0].serviceId==='varin.agent.policy') return {...binding,pin:()=>{const pin=binding.pin();pins++;let released=false;return {...pin,invoke:(method,args,signal)=>{if(method==='decide') decisions.push(structuredClone(args[0]));return pin.invoke(method,args,signal)},release:()=>{if(!released){released=true;pins--;}pin.release()}}}};return binding};
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await storage.dispose(); await documents.dispose(); await kernel.close(); };
  cleanups.push(close);

  const adapter = new ThreadAdapter(new AgentRuntimeClient(kernel, undefined, ({threadId}, signal) => createAgentPolicy(extensions)({sessionId:threadId,projectId:'selected-project'}, signal)), {
    resolveModel: async selection => {
      if (selection.providerId !== 'fixture-provider' || selection.modelId !== 'fixture-model') throw new Error('unselected model');
      return { configuration, credentialOwner: owner };
    },
    rebindModel: async () => owner,
  }, async source => { await documents.inspectWorkspace(source.workspaceId); await documents.inspectWorkspace(source.executionWorkspaceId); }, (_runId, error) => { launchErrors.push(error); }, prepare, prepareContext);
  refresh = () => adapter.refreshPersonalization();
  const flushRefreshes = async () => { while (refreshTasks.length) await Promise.all(refreshTasks.splice(0)); };
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  registerThreadRoutes(app, adapter, (request, response, next) => {
    if (request.headers['x-fixture-auth'] !== 'fixture-client') { response.status(401).json({ error: 'authentication required' }); return; }
    next();
  });
  const hostUrl = await listen(createServer(app));
  configureRuntimeUrlResolver({ apiBaseUrl: hostUrl, realtimeBaseUrl: hostUrl });
  setRuntimeExtraHeaders({ 'x-fixture-auth': 'fixture-client' });
  return { owner, decisions, pins:()=>pins, extensions, composition, adapter, flushRefreshes, endpoint, personalization, workspace, documents, workingStates, close, kernel, api: createThreadsHttpAPI(), runtime: adapter.runtime, hostUrl, secret, requests, launchErrors, root, closeKernel: () => kernel.close() };
}

const model = { providerId: 'fixture-provider', modelId: 'fixture-model' };
function complete(response: ServerResponse, id: string, text: string) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id, type: 'message', content: [{ type: 'output_text', text }] }] } })}\n\n`);
}
async function installExample(f: Awaited<ReturnType<typeof fixture>>) {
  await fs.writeFile(path.join(f.workspace, 'evidence-index.json'), JSON.stringify({ nextFile: 'evidence.txt' }));
  await fs.writeFile(path.join(f.workspace, 'evidence.txt'), 'Example evidence');
  const example = path.join(f.root, 'evidence-policy'); await fs.mkdir(example);
  for (const file of ['package.json', 'varin.extension.json']) await fs.copyFile(path.join(repository, 'examples/extensions/evidence-policy', file), path.join(example, file));
  await build({ entryPoints: [path.join(repository, 'examples/extensions/evidence-policy/host.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(example, 'host.cjs'), alias: { '@varin/extension-sdk': path.join(repository, 'packages/extension-sdk/dist/index.js') } });
  await f.extensions.installOrStage({ expectedRevision: (await f.extensions.state()).catalog.revision, source: { kind: 'local', display: 'Real example', specifier: example } });
}
async function route(f: Awaited<ReturnType<typeof fixture>>, providerKey: string, scope: {projectId?: string; sessionId?: string}) {
  return f.extensions.upsertServiceRoutingRule({ expectedRevision: (await f.extensions.routing.read()).document.revision,
    rule: { allowFallback: false, providerKey, scope, serviceId: 'varin.agent.policy', version: 1 } });
}
it('real installed policy settles read exchange and completes with pinned durable identity', async () => {
  let turn=0;
  const f=await fixture((body,response)=>{ if(++turn===1){ response.writeHead(200,{'content-type':'text/event-stream'}); response.end(`data: ${JSON.stringify({type:'response.completed',response:{output:[{id:'item-1',type:'function_call',call_id:'call-1',name:'file_read',arguments:JSON.stringify({path:'evidence.txt'})}]}})}\n\n`); } else complete(response,'done-item','done'); });
  await installExample(f); await route(f,'example.evidence-policy:host:varin.agent.policy@1',{projectId:'selected-project'});
  const identity=await f.api.create('policy-review'); await fs.writeFile(path.join(f.workspace,'evidence.txt'),'SENSITIVE_EVIDENCE_BODY');
  const source=await f.api.prepareSource({...identity,key:'source',path:f.workspace,mode:'fixed_branch'});
  const first=await f.api.submit({...identity,key:'first',expectedHead:null,text:'PRIVATE_USER_BODY',model,source:source.source});
  await expect.poll(async()=>(await f.kernel.agentRuntimeRequest<{state:string}, 'runtime.run.inspect'>('runtime.run.inspect',{runId:first.run_id})).state).toBe('completed');
  expect(f.requests).toHaveLength(2);
  const input=f.requests[1]!.body.input as Array<Record<string,unknown>>;
  expect(input.filter(i=>i.type==='function_call')).toHaveLength(1);
  expect(input.filter(i=>i.type==='function_call_output')).toHaveLength(1);
  expect(JSON.stringify(input)).toContain('SENSITIVE_EVIDENCE_BODY');
  expect((await f.runtime.launch(first.run_id))!.selection.policy.name).toContain('bounded-evidence+questions');
  await expect.poll(()=>f.kernel.policyBinding(first.run_id)).toBeUndefined();
  expect(f.launchErrors).toEqual([]); expect(JSON.stringify(f.decisions)).not.toMatch(/PRIVATE_USER_BODY|SENSITIVE_EVIDENCE_BODY|fake-http-provider-key|http:\/\//); expect(f.decisions).toHaveLength(7);
});
it('no selected policy uses default; explicit missing fails without inference', async()=>{
  const f=await fixture((_body,response)=>complete(response,'default','done'));
  const a=await f.api.create('default-review'); const first=await f.api.submit({...a,key:'default',expectedHead:null,text:'default',model});
  await expect.poll(async()=>(await f.api.run(first.run_id)).state).toBe('completed');
  expect((await f.runtime.launch(first.run_id))!.selection.policy.name).toBe('default+questions');
  await route(f,'missing.policy:host:varin.agent.policy@1',{projectId:'selected-project'});
  const b=await f.api.create('missing-review'); await f.api.submit({...b,key:'missing',expectedHead:null,text:'missing',model});
  await expect.poll(()=>f.launchErrors.length).toBe(1); expect(f.requests).toHaveLength(1);
});
async function installCustom(f: Awaited<ReturnType<typeof fixture>>, id: string, handlers: string) {
  const folder=path.join(f.root,id); await fs.mkdir(folder);
  await fs.writeFile(path.join(folder,'package.json'), JSON.stringify({name:id,version:'1.0.0'}));
  await fs.writeFile(path.join(folder,'varin.extension.json'),JSON.stringify({schemaVersion:1,id,version:'1.0.0',engines:{varin:'*'},entrypoints:{host:{file:'host.cjs',mode:'brokered',activation:['service-request']}},provides:{services:[{id:'varin.agent.policy',version:1,multiple:true}]}}));
  await fs.writeFile(path.join(folder,'host.cjs'),`module.exports={activate(context){context.services.provide({id:'varin.agent.policy',version:1,multiple:true},{${handlers}})}}`);
  await f.extensions.installOrStage({expectedRevision:(await f.extensions.state()).catalog.revision,source:{kind:'local',display:id,specifier:folder}});
  await route(f,`${id}:host:varin.agent.policy@1`,{projectId:'selected-project'});
}
it('cancel during hung broker describe releases preparing pin', async()=>{
  const f=await fixture((_body,response)=>complete(response,'unused','done'));
  await installCustom(f,'review.hung-description',"describe(){return new Promise(()=>{})},decide(){return {action:{kind:'complete'},state:null}}");
  const a=await f.api.create('hung-description'); const first=await f.api.submit({...a,key:'hung',expectedHead:null,text:'hang',model});
  await expect.poll(() => f.pins()).toBe(1);
  await f.runtime.cancelRun(first.run_id);
  expect((await f.runtime.run(first.run_id)).state).toBe('cancelled');
  await expect.poll(()=>f.pins(),{timeout:1500}).toBe(0);
});
it('cancel hung decision releases Run and unrelated selected run still completes', async()=>{
  const f=await fixture((_body,response)=>complete(response,'unused','done'));
  await installCustom(f,'review.hung-decision',"describe(){return {identity:{name:'hang',version:'1'},configuration:{}}},decide(){return new Promise(()=>{})}");
  const a=await f.api.create('hung-decision'); const first=await f.api.submit({...a,key:'hung',expectedHead:null,text:'hang',model});
  await expect.poll(()=>f.decisions.length).toBe(1);
  await f.runtime.cancelRun(first.run_id); await expect.poll(async()=>(await f.runtime.run(first.run_id)).state).toBe('cancelled');
  await installExample(f); await route(f,'example.evidence-policy:host:varin.agent.policy@1',{projectId:'selected-project'});
  const b=await f.api.create('other'); const source=await f.api.prepareSource({...b,key:'source',path:f.workspace,mode:'fixed_branch'}); const other=await f.api.submit({...b,key:'other',expectedHead:null,text:'done',model,source:source.source});
  await expect.poll(async()=>(await f.runtime.run(other.run_id)).state).toBe('completed');
});
it('illegal policy complete cannot skip registered tool exchange or run tool effects',async()=>{
 let turn=0;const f=await fixture((_body,response)=>{turn++;response.writeHead(200,{'content-type':'text/event-stream'});response.end(`data: ${JSON.stringify({type:'response.completed',response:{output:[{id:'bad-item',type:'function_call',call_id:'bad-call',name:'file_read',arguments:JSON.stringify({path:'evidence.txt'})}]}})}\n\n`)});
 await installCustom(f,'review.illegal-policy',"describe(){return {identity:{name:'bad',version:'1'},configuration:{}}},decide([input]){return {action:{kind:input.event.kind==='started'?'request_model':'complete'},state:null}}");
 const a=await f.api.create('illegal');await fs.writeFile(path.join(f.workspace,'evidence.txt'),'DO_NOT_READ');const source=await f.api.prepareSource({...a,key:'source',path:f.workspace,mode:'fixed_branch'});
 const first=await f.api.submit({...a,key:'illegal',expectedHead:null,text:'illegal',model,source:source.source});
 await expect.poll(async()=>(await f.runtime.run(first.run_id)).state).toBe('failed');expect(turn).toBe(1);
 const snap=await f.api.snapshot(a);expect(JSON.stringify(snap.history)).toContain('illegal_policy_action');expect(JSON.stringify(snap.history)).not.toContain('DO_NOT_READ');
});
it('malformed decision state fails closed before inference',async()=>{
 const f=await fixture((_body,response)=>complete(response,'never','never'));
 await installCustom(f,'review.malformed-policy',"describe(){return {identity:{name:'bad',version:'1'},configuration:{}}},decide(){return {action:{kind:'request_model'},state:undefined}}");
 const a=await f.api.create('malformed');const first=await f.api.submit({...a,key:'bad',expectedHead:null,text:'bad',model});
 await expect.poll(async()=>(await f.runtime.run(first.run_id)).state).toBe('failed');expect(f.requests).toHaveLength(0);
});
it('actual artifact replacement pins old implementation; later lease differs despite unchanged author version; revoke rejects',async()=>{
 const f=await fixture((_body,response)=>complete(response,'never','never'));
 await installCustom(f,'review.replace-policy',"describe(){return {identity:{name:'same',version:'1'},configuration:{budget:1}}},decide(){return {action:{kind:'complete'},state:{generation:1}}}");
 const prepare=createAgentPolicy(f.extensions);const old=await prepare({sessionId:'old',projectId:'selected-project'});expect(old).toBeDefined();
 const folder=path.join(f.root,'review.replace-policy');await fs.writeFile(path.join(folder,'host.cjs'),"module.exports={activate(context){context.services.provide({id:'varin.agent.policy',version:1,multiple:true},{describe(){return {identity:{name:'same',version:'1'},configuration:{budget:1}}},decide(){return {action:{kind:'complete'},state:{generation:2}}}})}}");
 const staged=await f.extensions.reloadLocalSource({expectedRevision:(await f.extensions.state()).catalog.revision,extensionId:'review.replace-policy'}); if(staged.outcome!=='staged') throw new Error('not staged'); await f.extensions.requestCandidateApplication({extensionId:'review.replace-policy',candidateIntegrity:staged.candidateIntegrity,expectedRevision:(await f.extensions.state()).catalog.revision}); const selecting=f.extensions.selectCandidate({extensionId:'review.replace-policy',candidateIntegrity:staged.candidateIntegrity,expectedRevision:(await f.extensions.state()).catalog.revision}); await expect.poll(()=>f.extensions.services.getSnapshot().providers.find(p=>p.extensionId==='review.replace-policy'&&p.status==='active')?.providerId).not.toBe(old!.binding.reference);
 const timeout=AbortSignal.timeout(1500); const next=await prepare({sessionId:'new',projectId:'selected-project'},timeout);expect(next).toBeDefined();expect(next!.binding.identity.version).not.toBe(old!.binding.identity.version);
 const input={view:{run_id:'r',state:'runnable',history_count:0,history_head_id:null,pending_tool_calls:0,model_capabilities:[]},event:{kind:'started' as const},state:null};
 expect((await old!.decide(input,new AbortController().signal)).state).toEqual({generation:1});expect((await next!.decide(input,new AbortController().signal)).state).toEqual({generation:2});
 old!.release(); await selecting; await f.extensions.setEnabled('review.replace-policy',false,(await f.extensions.state()).catalog.revision);
 await expect(old!.decide(input,new AbortController().signal)).rejects.toThrow();await expect(next!.decide(input,new AbortController().signal)).rejects.toThrow();old!.release();next!.release();
});
it('retry launch while model in flight cannot detach policy lease of active Run',async()=>{
 let held!:ServerResponse;const f=await fixture((_body,response)=>{held=response});await installExample(f);await route(f,'example.evidence-policy:host:varin.agent.policy@1',{projectId:'selected-project'});
 const a=await f.api.create('retry');const source=await f.api.prepareSource({...a,key:'source',path:f.workspace,mode:'fixed_branch'});const first=await f.api.submit({...a,key:'retry',expectedHead:null,text:'retry',model,source:source.source});await expect.poll(()=>f.requests.length).toBe(1);
 await f.runtime.rebindLaunch(first.run_id,{credentialOwner:f.owner}).catch(()=>undefined);
 expect(f.kernel.policyBinding(first.run_id)).toBeDefined();complete(held,'retry-complete','done');
 await expect.poll(async()=>(await f.runtime.run(first.run_id)).state).toBe('completed');expect(f.requests).toHaveLength(1);
});
it('restart accepts exact policy identity and rejects changed artifact or config with unchanged author version before inference',async()=>{
 const f=await fixture((_body,response)=>{response.writeHead(200,{'content-type':'text/event-stream'});response.end(`data: ${JSON.stringify({type:'response.completed',response:{output:[{id:'ask',type:'function_call',call_id:'ask-call',name:'ask_user',arguments:JSON.stringify({question:'Choose',options:['A','B']})}]}})}\n\n`)});
 await installExample(f);await route(f,'example.evidence-policy:host:varin.agent.policy@1',{projectId:'selected-project'});
 const a=await f.api.create('restart');const source=await f.api.prepareSource({...a,key:'source',path:f.workspace,mode:'fixed_branch'});const first=await f.api.submit({...a,key:'restart',expectedHead:null,text:'ask',model,source:source.source});await expect.poll(async()=>(await f.runtime.run(first.run_id)).state).toBe('waiting');const saved=(await f.runtime.launch(first.run_id))!.selection.policy;
 await f.close();await f.extensions.stop();
 const second=await fixture((_body,response)=>complete(response,'unexpected','unexpected'),f.root,f.endpoint);
 const same=await second.runtime.preparePolicy(first.run_id);expect(same).toBeDefined();expect((await second.runtime.launch(first.run_id))!.selection.policy).toEqual(saved);second.kernel.unregisterPolicyOwner(first.run_id);
 const actualPrepare=second.extensions.prepareService.bind(second.extensions);
 second.extensions.prepareService=async(...args)=>{const binding=await actualPrepare(...args);return {...binding,pin:()=>{const pin=binding.pin();return {...pin,invoke:async(method,args,signal)=>{const value=await pin.invoke(method,args,signal);return method==='describe'?{...(value as {identity:{name:string;version:string}}),configuration:{modelBudget:7}}:value}}}}};
 await expect(second.runtime.preparePolicy(first.run_id)).rejects.toThrow();second.extensions.prepareService=actualPrepare;
 const example=path.join(f.root,'evidence-policy');await fs.appendFile(path.join(example,'host.cjs'),'\n// changed artifact, identical author state version\n');
 const staged=await second.extensions.reloadLocalSource({extensionId:'example.evidence-policy',expectedRevision:(await second.extensions.state()).catalog.revision});if(staged.outcome!=='staged')throw new Error('not staged');await second.extensions.requestCandidateApplication({extensionId:'example.evidence-policy',candidateIntegrity:staged.candidateIntegrity,expectedRevision:(await second.extensions.state()).catalog.revision});await second.extensions.selectCandidate({extensionId:'example.evidence-policy',candidateIntegrity:staged.candidateIntegrity,expectedRevision:(await second.extensions.state()).catalog.revision});
 await expect(second.runtime.preparePolicy(first.run_id)).rejects.toThrow();expect((await second.runtime.launch(first.run_id))!.selection.policy).toEqual(saved);expect(f.requests).toHaveLength(1);expect(second.requests).toHaveLength(0);
});
it('late old-epoch response send failure cannot close replacement kernel',async()=>{
 let epoch='one';let rejectOld!:(e:Error)=>void;let failures=0;let sent=0;
 const bridge=new AgentPolicyBridge(()=>epoch,async()=>{sent++;await new Promise<void>((_resolve,reject)=>{rejectOld=reject})},()=>{failures++});
 bridge.register('r',{binding:{reference:'p',identity:{name:'policy',version:'1'}},release(){},async decide(){return {action:{kind:'complete'},state:null}}});
 bridge.consume({v:1,kind:'agent-policy-request',id:'decision1',kernelEpoch:'one',runId:'r',binding:{reference:'p',identity:{name:'policy',version:'1'}},input:{view:{run_id:'r',state:'runnable',history_count:0,history_head_id:null,pending_tool_calls:0,model_capabilities:[]},event:{kind:'started'},state:null}});
 await expect.poll(()=>sent).toBe(1);epoch='two';bridge.close();rejectOld(new Error('old pipe closed'));await new Promise(resolve=>setTimeout(resolve,20));expect(failures).toBe(0);
});
