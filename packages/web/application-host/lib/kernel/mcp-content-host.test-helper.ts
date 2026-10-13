/** Original Host MCP authority and tool bridge over a test-only stdio rendezvous.
 * No product socket, remote MCP service, credential, or model connection is opened. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { McpAuthority, McpCompositions, type McpCompositionScope } from '@varin/pi-host/mcp-authority';
import { resolvePiSdkSpecifier } from '@varin/pi-host/sdk';
import { createMcpLease } from './mcp-owner.js';
import { permissionService } from './permission-service.js';
import { ToolBridge } from './tool-bridge.js';
import type { KernelClient } from './kernel-client.js';

const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
let sequence = 0;
let epoch = '';
let tracePath = '';
let scope: McpCompositionScope | undefined;
// Original StreamableHttpTransport, with only fetch responses controlled. No HTTP listener.
const httpRequests: Record<string, unknown>[] = [];
let httpSessions = 0;
const fixtureFetch: typeof fetch = async (_input, init) => {
  const session = new Headers(init?.headers).get('mcp-session-id');
  if (init?.method === 'GET') return new Response(null, { status: 405 });
  if (init?.method === 'DELETE') return new Response(null, { status: 204 });
  assert.equal(typeof init?.body, 'string');
  const request = JSON.parse(init!.body as string) as Record<string, unknown>;
  httpRequests.push({ ...request, session });
  if (request.method === 'initialize') {
    const params = request.params as Record<string, unknown>;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
      protocolVersion: params.protocolVersion, capabilities: { resources: {} },
      serverInfo: { name: 'expiry-peer', version: '1' },
    } }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': `session-${++httpSessions}` } });
  }
  if (request.method === 'resources/read' && session === 'session-1') return new Response('expired', { status: 404 });
  if (request.id === undefined) return new Response(null, { status: 202 });
  const params = request.params as Record<string, unknown> | undefined;
  const result = request.method === 'resources/list' ? { resources: [] }
    : request.method === 'resources/templates/list' ? { resourceTemplates: [] }
    : { contents: [{ uri: params?.uri, text: `read from ${session}` }] };
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
    { status: 200, headers: { 'content-type': 'application/json' } });
};
const sdk = await import(resolvePiSdkSpecifier(join(process.cwd(), 'packages/pi-host'), '@earendil-works/pi-coding-agent'));
const transportRuntime = await sdk.loadMcpRuntime();
const authority = new McpAuthority({ createTransport: (...args) => {
  const original = transportRuntime.createDefaultTransport(...args);
  if (args[0].name !== 'expiry') return original;
  const Transport = original.constructor as new (options: Record<string, unknown>) => typeof original;
  return new Transport({ ...original.options, fetch: fixtureFetch });
} });
const compositions = new McpCompositions(authority, code => write({ kind: 'fixture-failed', code }));
const kernel = {
  subscribeExit() { return () => {}; },
  agentRuntimeRequest(method: string, params: unknown) {
    const id = `mcp-review:${++sequence}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      write({ kind: 'fixture-request', id, method, params });
    });
  },
} as unknown as KernelClient;
const bridge = new ToolBridge(() => epoch, async frame => { write(frame); },
  () => write({ kind: 'fixture-failed', code: 'original-tool-bridge-send-failed' }));
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7h8AAAAASUVORK5CYII=';

async function initialize(frame: Record<string, unknown>) {
  epoch = String(frame.epoch);
  const root = String(frame.root);
  const agentDir = join(root, 'agent');
  tracePath = join(root, 'mcp-requests.jsonl');
  await mkdir(agentDir, { recursive: true });
  const peer = join(root, 'mcp-peer.mjs');
  // The actual installed MCP stdio transport starts this finite protocol peer. Server output,
  // including unexpected ordinary JSON fields, is controlled; its transport/lifetime is real.
  await writeFile(peer, `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const trace = process.argv[2], promptsOnly = process.argv[3] === 'prompts-only', pixel = ${JSON.stringify(pixel)};
for await (const line of createInterface({input:process.stdin})) {
  const q=JSON.parse(line); if(q.id===undefined) continue;
  appendFileSync(trace,JSON.stringify({server:promptsOnly?'promptsOnly':'fixture',method:q.method,params:q.params})+'\\n');
  let result;
  switch(q.method) {
    case 'initialize': result={protocolVersion:q.params.protocolVersion,capabilities:promptsOnly?{prompts:{}}:{tools:{},resources:{},prompts:{}},serverInfo:{name:'typed-peer',version:'1'}}; break;
    case 'tools/list': result={tools:[{name:'picture',description:'Explicit MCP content',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}}]}; break;
    case 'tools/call': result={content:[{type:'text',text:'before image',_meta:{outputPartIndex:777}},{type:'image',data:pixel,mimeType:'image/png',annotations:{audience:['assistant'],priority:0.8},_meta:{source:'remote metadata only'}},{type:'resource_link',uri:'asset://not-listed',name:'Original link',_meta:{opaque:true}},{type:'text',text:'after image'},{type:'custom',data:'not an image',nested:{type:'image',data:'ordinary'}}],structuredContent:{echo:{kind:'media',media:{data_base64:'opaque ordinary JSON'}},nullable:null},_meta:{original:'tool-result'}}; break;
    case 'resources/list': result=q.params?.cursor==='resource-next'?{resources:[{uri:'asset://second',name:'second'}],_meta:{page:2}}:{resources:[{uri:'asset://first',name:'first'}],nextCursor:'resource-next',_meta:{page:1}}; break;
    case 'resources/templates/list': result={resourceTemplates:[{uriTemplate:'asset://{name}',name:'asset'}],_meta:{original:'template-page'}}; break;
    case 'resources/read': result={contents:[{uri:q.params.uri,mimeType:'text/plain',text:'resource text',_meta:{keep:1}},{uri:q.params.uri,mimeType:'image/png',blob:pixel,_meta:{keep:2}}],_meta:{original:'resource-result'}}; break;
    case 'prompts/list': result=q.params?.cursor==='prompt-next'?{prompts:[],_meta:{page:2}}:{prompts:[{name:'review',description:'Untrusted prompt template',arguments:[{name:'subject',required:true}]}],nextCursor:'prompt-next',_meta:{page:1}}; break;
    case 'prompts/get': result={description:'Original remote prompt',messages:[{role:'user',content:{type:'text',text:'Review '+q.params.arguments.subject}},{role:'assistant',content:{type:'image',data:pixel,mimeType:'image/png',_meta:{keep:'prompt-image'}}},{role:'user',content:{type:'resource',resource:{uri:'asset://embedded',mimeType:'text/plain',text:'embedded prompt text'}}}],_meta:{original:'prompt-result'}}; break;
    default: process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32601,message:'unsupported'}})+'\\n'); continue;
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
}`);
  await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
    fixture: { command: process.execPath, args: [peer, tracePath], exposure: 'deferred' },
    expiry: { url: 'https://expiry.invalid/mcp', exposure: 'deferred' },
    promptsOnly: { command: process.execPath, args: [peer, tracePath, 'prompts-only'], exposure: 'deferred' },
    unused: { command: process.execPath, args: ['-e', `throw Error('unselected dependency started')`], exposure: 'deferred' },
  } }));
  scope = await compositions.observe({ resourceOwner: { kind: 'local' }, agentDir, configCwd: root, executionCwd: root,
    environmentId: 'mcp-review-environment', executionScope: 'global', projectTrusted: false,
    sessionId: 'thread' }, () => {});
  const lease = createMcpLease({ lease: scope.snapshot(), kernel,
    currentPolicy: async () => ({ mode: 'normal', rules: [] }) });
  const live = bridge.register(String(frame.runId), lease);
  write({ kind: 'fixture-prepared', live });
}

async function receive(frame: Record<string, unknown>) {
  if (frame.kind === 'fixture-initialize') return initialize(frame);
  if (frame.kind === 'fixture-response') {
    const entry = pending.get(String(frame.id)); assert(entry); pending.delete(String(frame.id));
    if (frame.ok) entry.resolve(frame.result); else entry.reject(new Error(String(frame.error)));
    return;
  }
  if (frame.kind === 'fixture-permission') {
    await permissionService(kernel).decide(String(frame.operationId), String(frame.permissionId), 'allow_once');
    return;
  }
  if (frame.kind === 'fixture-finish') {
    bridge.close(); scope?.release(); compositions.close(); await authority.close();
    write({ kind: 'fixture-finished', httpRequests, requests: (await readFile(tracePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) });
    return;
  }
  assert(bridge.consume(frame), `unhandled original bridge frame ${String(frame.kind)}`);
}
const lines = createInterface({ input: process.stdin });
lines.on('line', line => { void receive(JSON.parse(line) as Record<string, unknown>).catch(error => {
  write({ kind: 'fixture-failed', code: error instanceof Error ? error.message : String(error) });
}); });
lines.on('close', () => { bridge.close(); scope?.release(); compositions.close(); void authority.close(); });
