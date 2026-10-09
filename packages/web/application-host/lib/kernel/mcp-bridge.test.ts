import { expect, it } from 'vitest';
import { McpBridge, type McpLease, type PrivateMcpResponse } from './mcp-bridge.js';

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
    binding: { reference: 'owner', generation, tools: [{ name: 'query', version: String(generation), schema: { type: 'object' } }], resources: { query: 'remote' } },
    authorize: async () => {},
    execute: async () => { entered(); await pending; return { kind: 'result', outcome: 'succeeded', effect: 'confirmed', content: 'receipt' }; },
    release: () => { released.push(generation); },
  });
  const frame = (kind: string, generation: number, holderId: string, kernelEpoch = epoch) => ({ v: 1, kind, kernelEpoch, runId: 'run', reference: 'owner', generation, holderId });
  const first = bridge.register('run', lease(1));
  bridge.consume(frame('mcp-binding-retain', 1, 'old'));
  bridge.consume(frame('mcp-binding-retain', 1, 'resumed'));
  bridge.consume(frame('mcp-binding-release', 1, 'old'));
  expect(released).toEqual([]);
  const call = { runId: 'run', requestId: 'request', operationId: 'operation', callId: 'call', name: 'query', schemaVersion: '1', arguments: {} };
  const request = (id: string, phase: string) => ({ v: 1, kind: 'mcp-tool-request', kernelEpoch: epoch, id, phase, binding: { reference: 'owner', generation: 1, holderId: 'resumed' }, call });
  bridge.consume(request('authorize', 'authorize'));
  await expect.poll(() => replies.length).toBe(1);
  bridge.consume(request('execute', 'execute'));
  await started;
  bridge.register('run', lease(2), false);
  expect(bridge.binding('run')).toEqual(first);
  bridge.consume(frame('mcp-binding-retain', 2, 'next'));
  bridge.consume(frame('mcp-binding-activate', 2, 'next'));
  bridge.consume(frame('mcp-binding-release', 1, 'resumed'));
  expect(bridge.binding('run')?.generation).toBe(2);
  expect(released).toEqual([]);
  settle();
  await expect.poll(() => released).toEqual([1]);
  expect(replies[1]?.completion).toEqual({ kind: 'result', outcome: 'succeeded', effect: 'confirmed', content: 'receipt' });
  bridge.consume(frame('mcp-binding-release', 2, 'next'));
  expect(released).toEqual([1]); // Waiting Run keeps its active selection for reconstruction.
  bridge.consume(frame('mcp-binding-retain', 2, 'new-scope'));
  epoch = 'replacement';
  bridge.consume(frame('mcp-binding-release', 2, 'new-scope', 'epoch'));
  bridge.close();
  expect(released).toEqual([1, 2]);
});
