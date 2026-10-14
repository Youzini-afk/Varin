import { describe, expect, it } from 'vitest';
import { ModelProtocolBridge } from './model-protocol-bridge.js';
import type { ModelProtocolResult } from '@varin/extension-contract';
const call = { kind: 'parse', request_id: 'request', run_id: 'run', connection_identity: 'connection', frame: 'data', state: null };
describe('model protocol callback ownership', () => {
  it('retains cancelled callback until actual completion and preserves its original result', async () => {
    const frames: unknown[] = []; let settle!: (value: ModelProtocolResult) => void; let signal!: AbortSignal;
    const bridge = new ModelProtocolBridge(() => 'epoch', async frame => { frames.push(frame); }, () => { throw new Error('channel failed'); });
    bridge.setOwner({ protocol: async (_id, _call, input) => { signal = input; return new Promise(resolve => { settle = resolve; }); }, release() {} });
    bridge.consume({ v: 1, kind: 'model-protocol-request', id: 'original', kernelEpoch: 'epoch', query: { bindingId: 'pin', call } });
    await Promise.resolve();
    bridge.consume({ v: 1, kind: 'model-protocol-cancel', id: 'original', kernelEpoch: 'epoch' });
    expect(signal.aborted).toBe(true); expect(frames).toEqual([]);
    let drained = false; const drain = bridge.drain().then(() => { drained = true; }); await Promise.resolve(); expect(drained).toBe(false);
    settle({ kind: 'parsed', events: [], state: { received: true }, finish: 'stop' }); await drain;
    expect(frames).toEqual([{ v: 1, kind: 'model-protocol-response', id: 'original', kernelEpoch: 'epoch', result: { ok: true, value: { kind: 'parsed', events: [], state: { received: true }, finish: 'stop' } } }]);
  });
  it('epoch loss suppresses old callbacks and releases only current exact bindings', async () => {
    let epoch = 'old'; const frames: unknown[] = []; const releases: string[] = [];
    let settle!: (value: ModelProtocolResult) => void;
    const bridge = new ModelProtocolBridge(() => epoch, async frame => { frames.push(frame); }, () => {});
    bridge.setOwner({ protocol: async () => new Promise(resolve => { settle = resolve; }), release: id => { releases.push(id); } });
    bridge.consume({ v: 1, kind: 'model-protocol-request', id: 'original', kernelEpoch: epoch, query: { bindingId: 'pin', call } }); await Promise.resolve();
    bridge.close(); epoch = 'new';
    bridge.consume({ v: 1, kind: 'model-protocol-release', kernelEpoch: 'old', bindingId: 'pin' });
    bridge.consume({ v: 1, kind: 'model-protocol-release', kernelEpoch: 'new', bindingId: 'new-pin' });
    settle({ kind: 'body', body: {} }); await bridge.drain();
    expect(frames).toEqual([]); expect(releases).toEqual(['new-pin']);
  });
});
