import { resolvePiSdkSpecifier } from '@varin/pi-host/sdk';
import { createMcpLease } from './mcp-owner.js';
import { McpAuthority } from '@varin/pi-host/mcp-authority';
import { createThreadContext } from './thread-context.js';
import { createAgentPersonalization } from '../memory/agent-personalization.js';
import { createMemoryOwner } from './memory-owner.js';
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
async function fixture(reply: (body: Record<string, unknown>, response: ServerResponse) => void, existingRoot?: string, existingEndpoint?: string, selectedServers: readonly string[] = ['fixture'], maxMessageBytes?: number) {
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
  const personalization = createAgentPersonalization({ client: kernel, context: async () => ({ bot: false, projectId: 'selected-project' }) });
  const prepareContext = createThreadContext({ personalization, workingStates, projectForWorkspace: async () => 'selected-project' });
  kernel.setMemoryOwner(createMemoryOwner({ personalization, prepareContext }));
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await storage.dispose(); await documents.dispose(); await kernel.close(); };
  cleanups.push(close);

  const agentDir = path.join(root, 'agent'); await fs.mkdir(agentDir, { recursive: true });
  const effectsPath = path.join(root, 'remote-effects.jsonl');
  const startsPath = path.join(root, 'remote-starts.jsonl');
  const unusedPath = path.join(root, 'unused-started');
  const script = path.join(root, 'fixture-mcp.mjs');
  await fs.writeFile(script, `import fs from 'node:fs'; import readline from 'node:readline';
const [effects, starts] = process.argv.slice(2); fs.appendFileSync(starts, JSON.stringify({cwd:process.cwd()})+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => { const request=JSON.parse(line); if(request.id===undefined)return; let result;
if(request.method==='initialize') result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
else if(request.method==='tools/list') result={tools:[{name:'send',description:'Fixture external send',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}]};
else if(request.method==='tools/call'){fs.appendFileSync(effects,JSON.stringify(request.params)+'\\n');const text=request.params.arguments.text==='large unicode response'?'界'.repeat(6*1024*1024):JSON.stringify({received:request.params.arguments,cwd:process.cwd()});result={content:[{type:'text',text}]};if(request.params.arguments.text==='large unicode response')fs.appendFileSync(effects,JSON.stringify({outputBytes:Buffer.byteLength(text),outputUnits:text.length})+'\\n');}
else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'unsupported'}})+'\\n');return;}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');});`);
  await fs.writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
    fixture: { command: process.execPath, args: [script, effectsPath, startsPath], exposure: 'direct' },
    unused: { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(unusedPath)}, 'should not start')`], exposure: 'direct' },
  } }));
  // Increase only this fixture's real stdio framing budget when testing the independent frame boundary.
  const sdk = maxMessageBytes ? await import(resolvePiSdkSpecifier(path.join(repository, 'packages/pi-host'), '@earendil-works/pi-coding-agent')) : undefined;
  const transportRuntime = sdk ? await sdk.loadMcpRuntime() : undefined;
  const mcp = new McpAuthority(maxMessageBytes ? { createTransport: (...args) => {
    const base = transportRuntime.createDefaultTransport(...args);
    const Transport = base.constructor as new (options: Record<string, unknown>) => typeof base;
    return new Transport({ ...base.options, maxMessageBytes });
  } } : {}); cleanups.push(() => mcp.close());
  const scope = (threadId: string) => ({ agentDir, configCwd: workspace, executionCwd: workspace,
    environmentId: 'fixture-environment', executionScope: 'workspace' as const, projectTrusted: true, sessionId: threadId });
  const transportTrace: Array<Record<string, unknown>> = [];
  const runtime = new AgentRuntimeClient(kernel, async (input, signal) => {
    const lease = await mcp.acquire(scope(input.threadId), { servers: selectedServers, ...(signal ? { signal } : {}) });
    const tracked = { ...lease, callTool: async (...args: Parameters<typeof lease.callTool>) => { transportTrace.push({ stage: 'enter', run: input.runId }); try { const result = await lease.callTool(...args); transportTrace.push({ stage: 'returned', run: input.runId }); return result; } catch (error) { transportTrace.push({ stage: 'error', error: String(error), run: input.runId }); throw error; } } };
    return createMcpLease({ lease: tracked, kernel, currentPolicy: async () => ({ mode: 'normal', rules: [] }) });
  });
  const adapter = new ThreadAdapter(runtime, {
    resolveModel: async selection => {
      if (selection.providerId !== 'fixture-provider' || selection.modelId !== 'fixture-model') throw new Error('unselected model');
      return { configuration, credentialOwner: owner };
    },
    rebindModel: async () => owner,
  }, async source => { await documents.inspectWorkspace(source.workspaceId); await documents.inspectWorkspace(source.executionWorkspaceId); }, (_runId, error) => { launchErrors.push(error); }, prepare, prepareContext);
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  registerThreadRoutes(app, adapter, (request, response, next) => {
    if (request.headers['x-fixture-auth'] !== 'fixture-client') { response.status(401).json({ error: 'authentication required' }); return; }
    next();
  });
  const hostUrl = await listen(createServer(app));
  configureRuntimeUrlResolver({ apiBaseUrl: hostUrl, realtimeBaseUrl: hostUrl });
  setRuntimeExtraHeaders({ 'x-fixture-auth': 'fixture-client' });
  return { transportTrace, effectsPath, startsPath, unusedPath, script, agentDir, scope, mcp, endpoint, personalization, workspace, documents, workingStates, close, kernel, api: createThreadsHttpAPI(), runtime: adapter.runtime, hostUrl, secret, requests, launchErrors, root, closeKernel: () => kernel.close() };
}

it('the shared MCP authority invokes a real selected stdio server only after allow-once and never starts unrelated configuration', async () => {
  let turns = 0;
  const f = await fixture((body, response) => {
    const tool = (body.tools as Array<{ name: string }>).find(tool => tool.name.startsWith('mcp__fixture__'))!;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const output = ++turns === 1 ? { id: 'real-mcp-call', type: 'function_call', call_id: 'real-mcp-call-id', name: tool.name, arguments: JSON.stringify({ text: 'explicitly approved remote content' }) }
      : { id: 'real-mcp-answer', type: 'message', content: [{ type: 'output_text', text: 'actual MCP result received' }] };
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [output] } })}\n\n`);
  });
  const identity = await f.api.create('real-shared-mcp');
  const receipt = await f.api.submit({ ...identity, key: 'real-shared-mcp-input', expectedHead: null, text: 'send the fixture content', model: { providerId: 'fixture-provider', modelId: 'fixture-model' } });
  await expect.poll(async () => (await f.api.snapshot(identity)).operations.some(op => op.waiting_on?.startsWith('permission:')), { timeout: 15_000 }).toBe(true).catch(async error => {
    throw new Error(`${String(error)} ${JSON.stringify({ run: await f.runtime.run(receipt.run_id), errors: f.launchErrors.map(String), events: (await f.runtime.events(0, 256)).slice(-8).map(event => ({ kind: event.kind, data: event.kind.endsWith('failed') ? event.data : undefined })) })}`);
  });
  expect(await fs.readFile(f.effectsPath, 'utf8').catch(() => '')).toBe('');
  expect(await fs.stat(f.unusedPath).then(() => true, () => false)).toBe(false);
  const op = (await f.api.snapshot(identity)).operations.find(op => op.waiting_on?.startsWith('permission:'))!;
  const permission = (op.result as { permission: { id: string } }).permission;
  await f.api.decidePermission({ ...identity, operationId: op.id, permissionId: permission.id, decision: 'allow_once' });
  await expect.poll(async () => (await f.api.run(receipt.run_id)).state, { timeout: 15_000 }).toBe('completed').catch(async error => {
    throw new Error(`${String(error)} ${JSON.stringify({ trace: f.transportTrace, operations: (await f.api.snapshot(identity)).operations, requests: f.requests.length })}`);
  });
  const effects = (await fs.readFile(f.effectsPath, 'utf8')).trim().split('\n').map(value => JSON.parse(value));
  expect(effects).toEqual([{ name: 'send', arguments: { text: 'explicitly approved remote content' } }]);
  expect((await fs.readFile(f.startsPath, 'utf8')).trim().split('\n')).toHaveLength(1);
  expect(await fs.stat(f.unusedPath).then(() => true, () => false)).toBe(false);
  expect(JSON.stringify(f.requests[1]!.body)).toContain('explicitly approved remote content');
  expect(f.launchErrors).toEqual([]);
}, 30_000);
it('lazy discovery starts only its selected real server, then validates and gates the discovered concrete call', async () => {
  let turns = 0; let held!: ServerResponse;
  const f = await fixture((body, response) => {
    turns++;
    if (turns === 1) { held = response; return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    let output: Record<string, unknown>;
    if (turns === 2) {
      const previous = (body.input as Array<Record<string, unknown>>).findLast(item => item.type === 'function_call_output')!;
      const result = JSON.parse(String(previous.output)) as { content: { tools: Array<{ server: string; tool: string; schemaVersion: string }> } };
      const discovered = result.content.tools.find(tool => tool.server === 'fixture' && tool.tool === 'send')!;
      expect(discovered).toBeDefined();
      output = { id: 'lazy-concrete-call', type: 'function_call', call_id: 'lazy-concrete-id', name: 'mcp_call', arguments: JSON.stringify({ server: discovered.server, tool: discovered.tool, schemaVersion: discovered.schemaVersion, arguments: { text: 'lazy approved content' } }) };
    } else output = { id: 'lazy-answer', type: 'message', content: [{ type: 'output_text', text: 'lazy action finished' }] };
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [output] } })}\n\n`);
  }, undefined, undefined, []);
  const identity = await f.api.create('lazy-mcp');
  const receipt = await f.api.submit({ ...identity, key: 'lazy-mcp-input', expectedHead: null, text: 'discover selected tool then call it', model: { providerId: 'fixture-provider', modelId: 'fixture-model' } });
  await expect.poll(() => f.requests.length).toBe(1).catch(async error => {
    throw new Error(`${String(error)} ${JSON.stringify({ run: await f.runtime.run(receipt.run_id), errors: f.launchErrors.map(String), events: (await f.runtime.events(0, 256)).slice(-8).map(event => ({ kind: event.kind, data: event.kind.endsWith('failed') ? event.data : undefined })) })}`);
  });
  expect(await fs.stat(f.startsPath).then(() => true, () => false)).toBe(false);
  expect(await fs.stat(f.unusedPath).then(() => true, () => false)).toBe(false);
  const toolNames = (f.requests[0]!.body.tools as Array<{ name: string }>).map(tool => tool.name);
  expect(toolNames).toEqual(expect.arrayContaining(['mcp_call', 'mcp_discover', 'ask_user']));
  expect(toolNames).not.toContain('send');
  held.writeHead(200, { 'content-type': 'text/event-stream' });
  held.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: 'lazy-discover-item', type: 'function_call', call_id: 'lazy-discover-id', name: 'mcp_discover', arguments: JSON.stringify({ server: 'fixture' }) }] } })}\n\n`);
  await expect.poll(async () => (await f.api.snapshot(identity)).operations.some(op => op.waiting_on?.startsWith('permission:')), { timeout: 15_000 }).toBe(true).catch(async error => { throw new Error(`${String(error)} ${JSON.stringify({ requests: f.requests.length, run: await f.runtime.run(receipt.run_id), events: (await f.runtime.events(0, 256)).slice(-8) })}`); });
  expect(await fs.readFile(f.effectsPath, 'utf8').catch(() => '')).toBe('');
  const op = (await f.api.snapshot(identity)).operations.find(op => op.waiting_on?.startsWith('permission:'))!;
  const permission = (op.result as { permission: { id: string; call: { arguments: unknown } } }).permission;
  expect(permission.call.arguments).toMatchObject({ server: 'fixture', tool: 'send', arguments: { text: 'lazy approved content' } });
  await f.api.decidePermission({ ...identity, operationId: op.id, permissionId: permission.id, decision: 'allow_once' });
  await expect.poll(async () => (await f.api.run(receipt.run_id)).state, { timeout: 15_000 }).toBe('completed').catch(async error => {
    throw new Error(`${String(error)} ${JSON.stringify({ trace: f.transportTrace, operations: (await f.api.snapshot(identity)).operations, requests: f.requests.length })}`);
  });
  expect((await fs.readFile(f.effectsPath, 'utf8')).trim().split('\n').map(value => JSON.parse(value))).toEqual([{ name: 'send', arguments: { text: 'lazy approved content' } }]);
  expect((await fs.readFile(f.startsPath, 'utf8')).trim().split('\n')).toHaveLength(1);
  expect(await fs.stat(f.unusedPath).then(() => true, () => false)).toBe(false);
}, 30_000);
it('a real configuration watch prepares a new MCP directory while the frozen request completes against its original server', async () => {
  let held!: ServerResponse;
  let turns = 0;
  const f = await fixture((body, response) => {
    if (++turns === 1) { held = response; return; }
    const tool = (body.tools as Array<{ name: string; parameters: Record<string, unknown> }>).find(tool => tool.name.startsWith('mcp__fixture__'))!;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const output = turns === 2 ? { id: 'new-call', type: 'function_call', call_id: 'new-call-id', name: tool.name, arguments: JSON.stringify({ message: 'new schema call' }) }
      : { id: 'done', type: 'message', content: [{ type: 'output_text', text: 'both retained generations completed' }] };
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [output] } })}\n\n`);
  });
  const identity = await f.api.create('live-mcp-update');
  const receipt = await f.api.submit({ ...identity, key: 'live-mcp-update-input', expectedHead: null, text: 'use this tool across its update', model: { providerId: 'fixture-provider', modelId: 'fixture-model' } });
  await expect.poll(() => f.requests.length, { timeout: 15_000 }).toBe(1);
  const original = f.kernel.mcpBinding(receipt.run_id)!;
  const originalTool = original.tools.find(tool => tool.name.startsWith('mcp__fixture__'))!;
  const configPath = path.join(f.agentDir, 'mcp.json');
  const initialConfig = await fs.readFile(configPath, 'utf8');
  await fs.writeFile(configPath, '{ invalid configuration');
  await expect(f.runtime.refreshMcp(receipt.run_id)).rejects.toThrow('mcp-config-invalid');
  expect(f.kernel.mcpBinding(receipt.run_id)).toEqual(original);
  await fs.writeFile(configPath, initialConfig);
  await f.kernel.agentRuntimeRequest('runtime.tools.select', { runId: receipt.run_id, selectionId: 'obsolete-candidate' });
  await f.kernel.agentRuntimeRequest('runtime.tools.select', { runId: receipt.run_id, selectionId: 'newer-desire' });
  expect(await f.kernel.agentRuntimeRequest('runtime.tools.ready', { runId: receipt.run_id, selectionId: 'obsolete-candidate', binding: original })).toEqual({ ready: false });
  let updated!: () => void; let failed!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { updated = resolve; failed = reject; });
  const unsubscribe = await f.mcp.subscribe(f.scope(identity.threadId), () => { void f.runtime.refreshMcp(receipt.run_id).then(updated, failed); });
  cleanups.push(async () => { unsubscribe(); });
  const nextScript = path.join(f.root, 'next-mcp.mjs');
  const nextEffects = path.join(f.root, 'next-effects.jsonl');
  await fs.writeFile(nextScript, (await fs.readFile(f.script, 'utf8'))
    .replace("description:'Fixture external send'", "description:'Updated fixture tool'")
    .replace("text:{type:'string'}", "message:{type:'string'}").replace("required:['text']", "required:['message']"));
  const config = JSON.parse(initialConfig) as { mcpServers: Record<string, Record<string, unknown>> };
  config.mcpServers.fixture = { ...config.mcpServers.fixture, args: [nextScript, nextEffects, f.startsPath] };
  await fs.writeFile(configPath, JSON.stringify(config));
  await ready;
  expect(f.kernel.mcpBinding(receipt.run_id)).toEqual(original);
  expect((await f.runtime.launch(receipt.run_id))!.selection.mcp_binding?.generation).toBe(original.generation);
  held.writeHead(200, { 'content-type': 'text/event-stream' });
  held.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: 'old-call', type: 'function_call', call_id: 'old-call-id', name: originalTool.name, arguments: JSON.stringify({ text: 'old schema call' }) }] } })}\n\n`);
  for (const callId of ['old-call-id', 'new-call-id']) {
    await expect.poll(async () => (await f.api.snapshot(identity)).operations.some(op => op.waiting_on?.startsWith('permission:')
      && (op.result as { permission?: { call?: { callId?: string } } })?.permission?.call?.callId === callId), { timeout: 15_000 }).toBe(true);
    const operation = (await f.api.snapshot(identity)).operations.find(op => op.waiting_on?.startsWith('permission:')
      && (op.result as { permission?: { call?: { callId?: string } } })?.permission?.call?.callId === callId)!;
    await f.api.decidePermission({ ...identity, operationId: operation.id, permissionId: (operation.result as { permission: { id: string } }).permission.id, decision: 'allow_once' });
  }
  await expect.poll(async () => (await f.api.run(receipt.run_id)).state, { timeout: 15_000 }).toBe('completed');
  expect((await fs.readFile(f.effectsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual([{ name: 'send', arguments: { text: 'old schema call' } }]);
  expect((await fs.readFile(nextEffects, 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual([{ name: 'send', arguments: { message: 'new schema call' } }]);
  const nextTool = (f.requests[1]!.body.tools as Array<{ name: string; parameters: { properties: Record<string, unknown> } }>).find(tool => tool.name === originalTool.name)!;
  expect(nextTool.parameters.properties).toHaveProperty('message');
  expect(nextTool.parameters.properties).not.toHaveProperty('text');
  const selection = (await f.runtime.launch(receipt.run_id))!.selection;
  expect(selection.mcp_binding!.generation).not.toBe(original.generation);
  expect(selection.tool_schema_generation).toBeGreaterThan(0);
  expect((await f.runtime.events(0, 256)).filter(event => event.kind === 'run.tools_activated' && event.subject === receipt.run_id)).toHaveLength(1);
  expect(f.launchErrors).toEqual([]);
}, 45_000);
it('disabling a real selected MCP dependency ends its outstanding permission wait without an answer or remote dispatch', async () => {
  let turns=0;
  const f=await fixture((body,response)=>{
    response.writeHead(200,{'content-type':'text/event-stream'});
    const tool=(body.tools as Array<{name:string}>).find(tool=>tool.name.startsWith('mcp__fixture__'))!;
    const output=++turns===1?{id:'blocked-call',type:'function_call',call_id:'blocked-call-id',name:tool.name,arguments:JSON.stringify({text:'must not send'})}
      :{id:'finished',type:'message',content:[{type:'output_text',text:'disabled dependency was rejected'}]};
    response.end(`data: ${JSON.stringify({type:'response.completed',response:{output:[output]}})}\n\n`);
  });
  const identity=await f.api.create('disabled-mcp');
  const receipt=await f.api.submit({...identity,key:'disabled-mcp-input',expectedHead:null,text:'try this tool',model:{providerId:'fixture-provider',modelId:'fixture-model'}});
  await expect.poll(async()=>(await f.api.snapshot(identity)).operations.some(op=>op.waiting_on?.startsWith('permission:')),{timeout:15_000}).toBe(true);
  const opened=f.mcp.open(f.scope(identity.threadId));
  try {await f.mcp.updateConfig(opened.scope,'fixture',{enabled:false});} finally {f.mcp.closeScope(opened.scope);}
  await expect.poll(async()=>(await f.api.run(receipt.run_id)).state,{timeout:15_000}).toBe('completed');
  expect(await fs.readFile(f.effectsPath,'utf8').catch(()=>'' )).toBe('');
  expect((await f.api.snapshot(identity)).operations.some(op=>op.waiting_on?.startsWith('permission:'))).toBe(false);
  const result=(f.requests[1]!.body.input as Array<{type:string;output?:string}>).find(item=>item.type==='function_call_output')!;
  expect(JSON.parse(result.output!)).toMatchObject({kind:'result',outcome:'failed',effect:'none',content:{error:'mcp_authorization_failed'}});
},30_000);
it('a real oversized UTF-8 MCP result keeps its remote-effect receipt, preserves other Runs and releases headless owners', async () => {
  const f = await fixture((body, response) => {
    const independent = JSON.stringify(body.input).includes('independent small run');
    const result = (body.input as Array<Record<string, unknown>>).findLast(item => item.type === 'function_call_output');
    const selected = (body.tools as Array<{ name: string }>).find(tool => !['ask_user', 'mcp_discover', 'mcp_call'].includes(tool.name))!;
    const output = !independent && !result
      ? { id: 'large-mcp-item', type: 'function_call', call_id: 'large-mcp-call', name: selected.name, arguments: JSON.stringify({ text: 'large unicode response' }) }
      : { id: `final-${crypto.randomUUID()}`, type: 'message', content: [{ type: 'output_text', text: independent ? 'independent run completed' : 'oversized output unavailable; do not replay' }] };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [output] } })}\n\n`);
  }, undefined, undefined, ['fixture'], 32 * 1024 * 1024);
  const identity = await f.api.create('large-mcp-output');
  const before = await f.runtime.status();
  const receipt = await f.api.submit({ ...identity, key: 'large-mcp-input', expectedHead: null, text: 'receive large output safely', model: { providerId: 'fixture-provider', modelId: 'fixture-model' } });
  await expect.poll(async () => (await f.api.snapshot(identity)).operations.some(op => op.waiting_on?.startsWith('permission:'))).toBe(true);
  const op = (await f.api.snapshot(identity)).operations.find(op => op.waiting_on?.startsWith('permission:'))!;
  const permissionId = (op.result as { permission: { id: string } }).permission.id;
  const other = await f.api.create('independent-mcp-run');
  const otherReceipt = await f.api.submit({ ...other, key: 'independent-mcp-input', expectedHead: null, text: 'independent small run', model: { providerId: 'fixture-provider', modelId: 'fixture-model' } });
  await f.api.decidePermission({ ...identity, operationId: op.id, permissionId, decision: 'allow_once' });
  // Do not call api.run/runtime.run here: their terminal observation also releases owners.
  await expect.poll(() => f.kernel.mcpBinding(receipt.run_id), { timeout: 20_000 }).toBeUndefined().catch(async error => { const run = await f.kernel.agentRuntimeRequest('runtime.run.inspect', { runId: receipt.run_id }); const events = (await f.runtime.events(0, 256)).slice(-8).map(event => ({kind:event.kind,data:event.data && typeof event.data === 'object' ? {code:(event.data as {code?:unknown}).code,message:(event.data as {message?:unknown}).message} : event.data})); throw new Error(`${String(error)} ${JSON.stringify({run, events, requests:f.requests.length, trace:f.transportTrace, remote:await fs.readFile(f.effectsPath,'utf8').catch(()=>''), starts:await fs.readFile(f.startsPath,'utf8').catch(()=>'')})}`); });
  await expect.poll(() => f.kernel.mcpBinding(otherReceipt.run_id), { timeout: 10_000 }).toBeUndefined();
  expect((await f.runtime.status()).epoch).toBe(before.epoch);
  expect((await f.api.run(otherReceipt.run_id)).state).toBe('completed');
  expect((await f.api.run(receipt.run_id)).state).toBe('completed');
  const settled = await f.api.operation(op.id);
  expect(settled).toMatchObject({ phase: 'terminal', outcome: 'failed', effect: 'confirmed', result: { error: 'mcp_output_exceeds_transport_frame', remoteOutcome: 'succeeded' } });
  const records = (await fs.readFile(f.effectsPath, 'utf8')).trim().split('\n').map(value => JSON.parse(value));
  expect(records.filter(value => value.name === 'send')).toHaveLength(1);
  const sizes = records.find(value => value.outputBytes);
  expect(sizes.outputBytes).toBeGreaterThan(16 * 1024 * 1024);
  expect(sizes.outputUnits).toBeLessThan(16 * 1024 * 1024);
  expect(JSON.stringify(f.requests)).toContain('mcp_output_exceeds_transport_frame');
}, 45_000);
it('the default MCP framing limit cannot invent a receipt or break the kernel when a remote result is oversized', async () => {
  let turn = 0;
  const f = await fixture((body, response) => {
    const name = (body.tools as Array<{ name: string }>).find(tool => !['ask_user', 'mcp_discover', 'mcp_call'].includes(tool.name))!.name;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const output = ++turn === 1 ? { id: 'framing-call', type: 'function_call', call_id: 'framing-call-id', name, arguments: JSON.stringify({ text: 'large unicode response' }) }
      : { id: 'framing-final', type: 'message', content: [{ type: 'output_text', text: 'remote receipt unavailable; do not replay' }] };
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [output] } })}\n\n`);
  });
  const identity = await f.api.create('default-framing');
  const epoch = (await f.runtime.status()).epoch;
  const receipt = await f.api.submit({ ...identity, key: 'default-framing-input', expectedHead: null, text: 'receive the large result', model: { providerId: 'fixture-provider', modelId: 'fixture-model' } });
  await expect.poll(async () => (await f.api.snapshot(identity)).operations.some(op => op.waiting_on?.startsWith('permission:'))).toBe(true);
  const op = (await f.api.snapshot(identity)).operations.find(op => op.waiting_on?.startsWith('permission:'))!;
  await f.api.decidePermission({ ...identity, operationId: op.id, permissionId: (op.result as {permission:{id:string}}).permission.id, decision: 'allow_once' });
  // The current SDK's declared request timeout is 60s. A framing failure may reject earlier.
  await expect.poll(() => f.kernel.mcpBinding(receipt.run_id), { timeout: 75_000 }).toBeUndefined();
  const settled = await f.api.operation(op.id);
  expect(settled).toMatchObject({ phase: 'terminal', outcome: 'indeterminate', effect: 'unknown' });
  expect((await f.runtime.status()).epoch).toBe(epoch);
  expect((await fs.readFile(f.effectsPath, 'utf8')).trim().split('\n').map(value => JSON.parse(value)).filter(value => value.name === 'send')).toHaveLength(1);
}, 90_000);
