/** Original MCP/permission/Job owners over a test-only stdio rendezvous.
 * The receiver's work is controlled, but its installed MCP stdio transport is real.
 * No product socket, network listener, remote service or model connection is opened. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { McpAuthority, McpCompositions, type McpCompositionScope } from '@varin/pi-host/mcp-authority';
import { createMcpLease } from './mcp-owner.js';
import { permissionService } from './permission-service.js';
import { ToolBridge } from './tool-bridge.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { createMcpTaskRuntime } from './mcp-task-runtime.js';
import { createMcpTaskRecovery } from './mcp-task-recovery.js';
import type { KernelClient } from './kernel-client.js';
import { CredentialBridge } from './credential-bridge.js';

const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
const eventListeners = new Set<(event: unknown) => void>();
const readyListeners = new Set<() => void>();
let sequence = 0, epoch = '', root = '';
let scope: McpCompositionScope | undefined;
const authority = new McpAuthority();
const compositions = new McpCompositions(authority, code => write({ kind: 'fixture-failed', code }));
const credentials = new CredentialBridge(() => epoch || null, async frame => { write(frame); },
  () => write({ kind: 'fixture-failed', code: 'original-credential-bridge-send-failed' }));
const kernel = {
  get kernelEpoch() { return epoch || null; },
  registerCredentialOwner(...args: Parameters<CredentialBridge['register']>) { return credentials.register(...args); },
  unregisterCredentialOwner(...args: Parameters<CredentialBridge['unregister']>) { return credentials.unregister(...args); },
  cancelRunPreparation() {}, // This fixture admits no deferred Thread source preparation.
  unregisterToolOwners(runId: string) { bridge.unregister(runId); },
  releaseRunPolicyOwners() {}, // Its main policy is the original builtin policy, not a Host policy lease.
  subscribeExit() { return () => {}; },
  subscribeReady(listener: () => void) { readyListeners.add(listener); return () => readyListeners.delete(listener); },
  onToolReleased() {},
  onAgentRuntimeEvent(listener: (event: unknown) => void) { eventListeners.add(listener); return () => eventListeners.delete(listener); },
  agentRuntimeRequest(method: string, params: unknown) {
    const id = `task-review:${++sequence}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      write({ kind: 'fixture-request', id, method, params });
    });
  },
} as unknown as KernelClient;
const runtime = new AgentRuntimeClient(kernel);
let recover: ReturnType<typeof createMcpTaskRecovery> | undefined;
const tasks = createMcpTaskRuntime({ kernel, runtime, recover: (pending, signal) => {
  assert(recover); return recover(pending, signal);
}, onError: error => write({ kind: 'fixture-task-error', code: error.message }) });
const bridge = new ToolBridge(() => epoch, async frame => { write(frame); },
  () => write({ kind: 'fixture-failed', code: 'original-tool-bridge-send-failed' }));
let consumer: Awaited<ReturnType<typeof import('./mcp-consumer-host.test-helper.js').createMcpConsumers>> | undefined;
let resource: Awaited<ReturnType<typeof import('./mcp-resource-host.test-helper.js').createResourceFixture>> | undefined;
let interaction: Awaited<ReturnType<typeof import('./mcp-interaction-host.test-helper.js').createInteractionFixture>> | undefined;
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7h8AAAAASUVORK5CYII=';

async function initialize(frame: Record<string, unknown>) {
  epoch = String(frame.epoch); root = String(frame.root);
  if (frame.interactions === 'http' || frame.interactions === 'stdio') {
    const { createInteractionFixture } = await import('./mcp-interaction-host.test-helper.js');
    interaction = await createInteractionFixture({ root, mode: frame.interactions, kernel, runtime, bridge, sampling: frame.sampling === true,
      onError: error => write({ kind: 'fixture-failed', code: error.message }) });
    write({ kind: 'fixture-prepared', ...await interaction.prepare(frame) }); return;
  }
  if (frame.resources === true) {
    const { createResourceFixture } = await import('./mcp-resource-host.test-helper.js');
    resource = await createResourceFixture({ root, kernel, runtime, authority, compositions, bridge,
      onError: error => write({ kind: 'fixture-resource-error', code: error.message }) });
    write({ kind: 'fixture-prepared', ...await resource.prepare(frame) });
    return;
  }
  const agentDir = join(root, 'agent'), peer = join(root, 'task-peer.mjs');
  await mkdir(agentDir, { recursive: true });
  await writeFile(peer, `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const root=process.argv[2], file=join(root,'receiver-tasks.json'), trace=join(root,'receiver-trace.jsonl');
const tasks=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{}, pendingResults=new Map(), pendingGets=new Map(), rootsRequests=new Map();
const send=q=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...q})+'\\n');
const save=()=>writeFileSync(file,JSON.stringify(tasks));
const state=t=>({taskId:t.id,status:t.status,createdAt:t.createdAt,lastUpdatedAt:t.updated,ttl:null,pollInterval:20,statusMessage:'Original receiver status'});
const update=t=>{if(t.status==='working'&&t.scenario==='input')t.status='input_required';
  if(t.status!=='cancelled'&&existsSync(join(root,t.scenario+'.done')))t.status='completed';
  t.updated=new Date().toISOString();save();return state(t);};
const result=(q,t)=>{if(t.status==='cancelled'){send({id:q.id,error:{code:-32000,message:'Original cancellation result',data:{remoteWorkContinues:true}}});return;}
  send({id:q.id,result:{content:[{type:'text',text:'Before task image'},{type:'image',data:${JSON.stringify(pixel)},mimeType:'image/png'},{type:'text',text:'After task image'}],
    structuredContent:{scenario:t.scenario,nullable:null,empty:[],opaque:{type:'image',data:'not media'}},_meta:{'io.modelcontextprotocol/related-task':{taskId:t.id},original:'task-result'}}});};
const drain=()=>{if(!existsSync(join(root,'hold-cancel-get'))){for(const [id,q]of pendingGets){pendingGets.delete(id);send({id,result:update(tasks[q.params.taskId])});}}for(const t of Object.values(tasks)){if(t.status==='cancelled')writeFileSync(join(root,'continued-after-cancel'),'actual receiver effect after acknowledgement');}for(const [id,q]of pendingResults){const t=tasks[q.params.taskId];update(t);if(['completed','failed','cancelled'].includes(t.status)){pendingResults.delete(id);result(q,t);}}};
setInterval(drain,20).unref();
createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);
  appendFileSync(trace,JSON.stringify(q)+'\\n');
  if(!q.method){const original=rootsRequests.get(q.id);if(original){rootsRequests.delete(q.id);const t=tasks[original.params.taskId];
    if(q.result?.roots){t.status='completed';t.updated=new Date().toISOString();save();pendingResults.delete(original.id);result(original,t);}
    else send({id:original.id,error:{code:-32000,message:'Original roots interaction failed'}});}return;}
  if(q.id===undefined)return;
  let out;
  switch(q.method){
    case'initialize':out={protocolVersion:q.params.protocolVersion,capabilities:{tools:{},tasks:{cancel:{},requests:{tools:{call:{}}}}},serverInfo:{name:'original-task-peer',version:'1'}};break;
    case'tools/list':out={tools:[{name:'deferred',description:'Required remote job',inputSchema:{type:'object',properties:{scenario:{type:'string'}},required:['scenario'],additionalProperties:false},execution:{taskSupport:'required'}},
      {name:'ordinary',description:'Synchronous call while jobs are live',inputSchema:{type:'object',properties:{},additionalProperties:false},execution:{taskSupport:'forbidden'}}]};break;
    case'tools/call':if(q.params.name==='ordinary'){if(q.params.task)throw Error('ordinary RPC changed lifetime');out={content:[{type:'text',text:'Original server dispatch is available'}]};break;}
      if(!q.params.task)throw Error('required tool called without task metadata');
      {const scenario=q.params.arguments.scenario,id='receiver:'+scenario;if(tasks[id])throw Error('original task was submitted twice');
      const now=new Date().toISOString(),t=tasks[id]={id,scenario,status:'working',createdAt:now,updated:now,remoteWorkContinues:true};save();out={task:state(t),_meta:{original:'immutable-acceptance','io.modelcontextprotocol/model-immediate-response':'Remote work accepted'}};}break;
    case'tasks/get':{const t=tasks[q.params.taskId];if(!t){send({id:q.id,error:{code:-32602,message:'Unknown task'}});return;}if(t.scenario==='cancel'&&existsSync(join(root,'hold-cancel-get'))){pendingGets.set(q.id,q);writeFileSync(join(root,'cancel-get-blocked'),'receiver get is pending');return;}out=update(t);}break;
    case'tasks/cancel':{const t=tasks[q.params.taskId];if(!t||['completed','failed','cancelled'].includes(t.status)){send({id:q.id,error:{code:-32602,message:'Cannot cancel'}});return;}
      writeFileSync(join(root,'cancel-received'),'original tasks/cancel reached receiver');t.status='cancelled';t.updated=new Date().toISOString();t.remoteWorkContinues=true;save();out=state(t);}break;
    case'tasks/result':{const t=tasks[q.params.taskId];if(!t){send({id:q.id,error:{code:-32602,message:'Unknown task'}});return;}update(t);
      if(['completed','failed','cancelled'].includes(t.status)){result(q,t);return;}pendingResults.set(q.id,q);
      if(t.status==='input_required'){const id='roots:'+q.id;rootsRequests.set(id,q);send({id,method:'roots/list',params:{_meta:{'io.modelcontextprotocol/related-task':{taskId:t.id}}}});}return;}
    default:send({id:q.id,error:{code:-32601,message:'Unsupported method'}});return;
  }send({id:q.id,result:out});
});`);
  await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
    original: { command: process.execPath, args: [peer, root], exposure: 'direct' },
  } }));
  let changed: (() => void) | undefined;
  scope = await compositions.observe({ resourceOwner: { kind: 'local' }, agentDir, configCwd: agentDir, executionCwd: agentDir,
    environmentId: 'fixture-host:global', executionScope: 'global', projectTrusted: false,
    sessionId: 'agent:thread' }, () => changed?.());
  recover = createMcpTaskRecovery({ kernel, authority, agentDir, hostId: 'fixture-host',
    admitWorkspaceRegistration: async () => { throw new Error('Source-less task acquired an unrelated workspace'); },
    projectTrusted: () => false, validateLiveSource: async () => { throw new Error('Source-less task acquired a live source'); },
  });
  let original = scope.snapshot();
  while (!original.binding.tools.some(tool => tool.tool === 'deferred')) {
    original.release(); await new Promise<void>(resolve => { changed = resolve; });
    original = scope.snapshot();
  }
  const names = Object.fromEntries(original.binding.tools.map(tool => [tool.tool, tool.name]));
  const lease = createMcpLease({ lease: original, kernel, tasks,
    currentPolicy: async () => ({ mode: 'normal', rules: [] }) });
  if (frame.consumer === true) {
    const { createMcpConsumers } = await import('./mcp-consumer-host.test-helper.js');
    consumer = await createMcpConsumers({ root, agentDir, authority, kernel, tasks, bridge, parentMcp: lease });
    write({ kind: 'fixture-prepared', names, ...consumer.prepared });
    return;
  }
  const live = bridge.register(String(frame.runId), lease);
  tasks.start();
  write({ kind: 'fixture-prepared', live, names });
}
async function receive(frame: Record<string, unknown>) {
  if (credentials.consume(frame)) return;
  if (frame.kind === 'fixture-initialize') return initialize(frame);
  if (frame.kind === 'fixture-interaction-consumer') {
    assert(interaction);
    try { write({ kind: 'fixture-interaction-consumer-result', ok: true, result: await interaction.consume(frame) }); }
    catch (error) { write({ kind: 'fixture-interaction-consumer-result', ok: false, error: error instanceof Error ? error.message : String(error) }); }
    return;
  }
  if (frame.kind === 'fixture-interaction-complete') {
    assert(interaction); await interaction.complete(String(frame.elicitationId));
    if (frame.ack === true) write({ kind: 'fixture-interaction-completion-emitted' }); return;
  }
  if (frame.kind === 'fixture-resource-prepare') {
    assert(resource); write({ kind: 'fixture-prepared', ...await resource.prepare(frame) }); return;
  }
  if (frame.kind === 'fixture-consumer-parent' || frame.kind === 'fixture-consumer-child') {
    if (interaction) { write({ kind: 'fixture-prepared', ...await interaction.receive(frame) }); return; }
    if (resource) { write({ kind: 'fixture-prepared', ...await resource.receive(frame) }); return; }
    assert(consumer); write({ kind: 'fixture-prepared', ...await consumer.receive(frame) }); return;
  }
  if (frame.kind === 'fixture-response') {
    const entry = pending.get(String(frame.id)); assert(entry); pending.delete(String(frame.id));
    if (frame.ok) entry.resolve(frame.result); else { process.stderr.write(`fixture kernel rejection ${frame.id}: ${frame.error}\n`); entry.reject(new Error(String(frame.error))); }
    return;
  }
  if (frame.kind === 'fixture-permission') {
    await permissionService(kernel).decide(String(frame.operationId), String(frame.permissionId), 'allow_once'); return;
  }
  if (frame.kind === 'fixture-event') { for (const listener of eventListeners) listener(frame.event); return; }
  if (frame.kind === 'fixture-ready') { for (const listener of readyListeners) listener(); return; }
  if (frame.kind === 'fixture-finish') {
    credentials.close();
    if (interaction) { const result = await interaction.finish(); bridge.close(); compositions.close(); await authority.close(); write({ kind: 'fixture-finished', ...result }); return; }
    if (resource) {
      const result = await resource.finish(); bridge.close(); compositions.close(); await authority.close();
      write({ kind: 'fixture-finished', ...result }); return;
    }
    await tasks.dispose(); bridge.close(); await consumer?.close(); scope?.release(); compositions.close(); await authority.close();
    write({ kind: 'fixture-finished', requests: (await readFile(join(root, 'receiver-trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
      tasks: JSON.parse(await readFile(join(root, 'receiver-tasks.json'), 'utf8')) }); return;
  }
  assert(bridge.consume(frame), `unhandled original bridge frame ${String(frame.kind)}`);
}
const lines = createInterface({ input: process.stdin });
lines.on('line', line => { void receive(JSON.parse(line) as Record<string, unknown>).catch(error => {
  write({ kind: 'fixture-failed', code: error instanceof Error ? error.stack : String(error) });
}); });
lines.on('close', () => { credentials.close(); void tasks.dispose(); void interaction?.finish(); void resource?.finish(); bridge.close(); void consumer?.close(); scope?.release(); compositions.close(); void authority.close(); });
