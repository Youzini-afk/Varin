import { expect, it } from 'vitest';
import { McpBridge, type McpLease, type LiveMcpBinding, type PrivateMcpResponse } from './mcp-bridge.js';

it('retired MCP owners drain actual holders and calls, while a resumed holder keeps its selected owner', async () => {
  let epoch = 'epoch';
  const replies: PrivateMcpResponse[] = [];
  const bridge = new McpBridge(() => epoch, async reply => { replies.push(reply); }, () => { throw new Error('transport failed'); });
  const released: number[] = [];
  let settle!: () => void;
  const pending = new Promise<void>(resolve => { settle = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const lease = (generation: number): McpLease => ({
    implementationIdentity: `implementation-${generation}`,
    binding: { reference: 'owner', generation, tools: [{ name: 'query', version: String(generation), schema: { type: 'object' } }], resources: { query: 'remote' } },
    authorize: async () => {},
    execute: async () => { entered(); await pending; return { kind: 'result', outcome: 'succeeded', effect: 'confirmed', content: 'receipt' }; },
    release: () => { released.push(generation); },
  });
  const frame = (kind: string, binding: LiveMcpBinding, holderId: string, kernelEpoch = epoch) => ({ v: 1, kind, kernelEpoch, runId: 'run', ownerId: binding.ownerId, holderId });
  const first = bridge.register('run', lease(1));
  bridge.consume(frame('mcp-binding-retain', first, 'old'));
  bridge.consume(frame('mcp-binding-retain', first, 'resumed'));
  bridge.consume(frame('mcp-binding-release', first, 'old'));
  expect(released).toEqual([]);
  const call = { runId: 'run', requestId: 'request', operationId: 'operation', callId: 'call', name: 'query', schemaVersion: '1', arguments: {} };
  const request = (id: string, phase: string) => ({ v: 1, kind: 'mcp-tool-request', kernelEpoch: epoch, id, phase, binding: { ownerId: first.ownerId, reference: 'owner', generation: 1, holderId: 'resumed' }, call });
  bridge.consume(request('authorize', 'authorize'));
  await expect.poll(() => replies.length).toBe(1);
  bridge.consume(request('execute', 'execute'));
  await started;
  const next = bridge.register('run', lease(2), false);
  expect(bridge.binding('run')).toEqual(first.binding);
  bridge.consume(frame('mcp-binding-retain', next, 'next'));
  bridge.consume(frame('mcp-binding-activate', next, 'next'));
  bridge.consume(frame('mcp-binding-release', first, 'resumed'));
  expect(bridge.binding('run')?.generation).toBe(2);
  expect(released).toEqual([]);
  settle();
  await expect.poll(() => released).toEqual([1]);
  expect(replies[1]?.completion).toEqual({ kind: 'result', outcome: 'succeeded', effect: 'confirmed', content: 'receipt' });
  bridge.consume(frame('mcp-binding-release', next, 'next'));
  expect(released).toEqual([1]); // Waiting Run keeps its active selection for reconstruction.
  bridge.consume(frame('mcp-binding-retain', next, 'new-scope'));
  epoch = 'replacement';
  bridge.consume(frame('mcp-binding-release', next, 'new-scope', 'epoch'));
  bridge.close();
  expect(released).toEqual([1, 2]);
});
it('an identically described replacement receives a new live owner and cannot revive an old revoked call',async()=>{
  const replies:PrivateMcpResponse[]=[];const effects:string[]=[];let revoked=false;
  const bridge=new McpBridge(()=>'epoch',async reply=>{replies.push(reply);},()=>{throw new Error('transport failed');});
  const lease=(identity:string):McpLease=>({implementationIdentity:identity,
    binding:{reference:'same-owner',generation:1,resources:{query:'same-resource'},tools:[{name:'query',version:'same-schema',schema:{type:'object'}}]},
    authorize:async()=>{if(identity==='old' && revoked)throw new Error('revoked');},
    execute:async()=>{effects.push(identity);return {kind:'result',outcome:'succeeded',effect:'confirmed',content:identity};},release:()=>{}});
  const old=bridge.register('run',lease('old'));
  const next=bridge.register('run',lease('new'),false);
  expect(next.binding).toEqual(old.binding);expect(next.ownerId).not.toBe(old.ownerId);
  const hold=(kind:string,owner:LiveMcpBinding)=>bridge.consume({v:1,kind,kernelEpoch:'epoch',runId:'run',ownerId:owner.ownerId,holderId:owner.ownerId});
  hold('mcp-binding-retain',old);hold('mcp-binding-retain',next);hold('mcp-binding-activate',next);
  revoked=true;
  const request=(owner:LiveMcpBinding,id:string,phase:string)=>bridge.consume({v:1,kind:'mcp-tool-request',id,kernelEpoch:'epoch',phase,
    binding:{ownerId:owner.ownerId,reference:'same-owner',generation:1,holderId:owner.ownerId},
    call:{runId:'run',requestId:'request',operationId:owner.ownerId,callId:owner.ownerId,name:'query',schemaVersion:'same-schema',arguments:{}}});
  request(old,'old-authorize','authorize');request(next,'new-authorize','authorize');
  await expect.poll(()=>replies.length).toBe(2);
  expect(replies.find(reply=>reply.id==='old-authorize')?.ok).toBe(false);
  expect(replies.find(reply=>reply.id==='new-authorize')?.ok).toBe(true);
  request(next,'new-execute','execute');
  await expect.poll(()=>replies.length).toBe(3);
  expect(effects).toEqual(['new']);bridge.close();
});
