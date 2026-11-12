import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { HarnessProtocolError, HarnessTransport } from './transport.js';
import type { KernelManagedProcess } from '../kernel/process-service.js';

function fixture() {
  let complete!: () => void;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitConfirmed: false,
    completion: new Promise<void>((resolve) => { complete = resolve; }),
    release: vi.fn(async () => {}), discardOutput: vi.fn(),
    requestTermination: vi.fn(async () => { child.exitConfirmed = true; complete(); }),
  });
  const frames: Array<Record<string, unknown>> = [];
  child.stdin.on('data', (data) => frames.push(JSON.parse(data.toString())));
  const peer = new HarnessTransport(child as unknown as KernelManagedProcess);
  return { child, frames, peer, reply(value: unknown) { child.stdout.write(`${JSON.stringify(value)}\n`); } };
}

describe('external protocol transport', () => {
  it('uses original managed stop evidence even after its observation stream is lost', async () => {
    const child = Object.assign(new EventEmitter(), {stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),
      completion:Promise.reject(new Error('observation lost')),exitConfirmed:false,discardOutput:vi.fn(),release:vi.fn(),requestTermination:vi.fn()});
    let confirm!:()=>void;const proof=new Promise<void>(resolve=>{confirm=resolve;});
    const closeOwner=vi.fn(()=>proof);const peer=new HarnessTransport(child as unknown as KernelManagedProcess,'rpc',closeOwner);
    const closing=peer.close();let settled=false;void closing.then(()=>{settled=true;});
    await Promise.resolve();expect(settled).toBe(false);expect(child.requestTermination).not.toHaveBeenCalled();
    confirm();await closing;expect(closeOwner).toHaveBeenCalledTimes(1);
  });

  it('keeps typed protocol failure information and method while removing the waiter', async () => {
    const f = fixture();
    const request = f.peer.request('session/new');
    f.reply({ jsonrpc: '2.0', id: f.frames[0]!.id, error: { code: -32000, message: 'Authentication required', data: { reason: 'auth_required' } } });
    await expect(request).rejects.toMatchObject({ method: 'session/new', code: -32000, data: { reason: 'auth_required' } });
    await f.peer.close();
  });
  it('abandons a control wait without replaying or claiming cancellation of its native effect', async () => {
    const f = fixture(), abort = new AbortController();
    const request = f.peer.request('session/set_mode', { modeId: 'plan' }, { signal: abort.signal });
    abort.abort(new Error('Caller stopped waiting'));
    await expect(request).rejects.toThrow('Caller stopped waiting');
    f.reply({ id: f.frames[0]!.id, result: {} });
    expect(f.frames).toHaveLength(1);
    expect(f.child.requestTermination).not.toHaveBeenCalled();
    await f.peer.close();
  });
  it('has an explicit bounded control deadline but no implicit model execution timeout', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const control = f.peer.request('initialize', {}, { timeoutMs: 100 });
      const failed = expect(control).rejects.toBeInstanceOf(HarnessProtocolError);
      await vi.advanceTimersByTimeAsync(100);
      await failed;
      const prompt = f.peer.request('session/prompt', {});
      let done = false;
      void prompt.then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(done).toBe(false);
      f.reply({ id: f.frames[1]!.id, result: { stopReason: 'end_turn' } });
      await prompt;
    } finally { await f.peer.close(); vi.useRealTimers(); }
  });
  it('preserves split UTF-8 and Unicode separators and joins the process before close resolves', async () => {
    const f = fixture(), received: unknown[] = [];
    f.peer.onMessage((message) => received.push(message));
    const bytes = Buffer.from(JSON.stringify({ method: 'delta', text: '中文\u2028text' }) + '\n');
    for (const byte of bytes) f.child.stdout.write(Buffer.from([byte]));
    expect(received).toEqual([{ method: 'delta', text: '中文\u2028text' }]);
    await Promise.all([f.peer.close(), f.peer.close()]);
    expect(f.child.requestTermination).toHaveBeenCalledTimes(1);
    expect(f.child.exitConfirmed).toBe(true);
  });
});


it('answers callbacks whose valid JSON-RPC identity is the empty string', async () => {
  const f = fixture();
  f.peer.onRequest(async () => ({ outcome: 'cancelled' }));
  f.reply({ jsonrpc: '2.0', id: '', method: 'permission', params: {} });
  await vi.waitFor(() => expect(f.frames).toEqual([{ jsonrpc: '2.0', id: '', result: { outcome: 'cancelled' } }]));
  await f.peer.close();
});
