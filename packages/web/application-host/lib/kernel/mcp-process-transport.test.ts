import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import { McpConnectionClosedError, McpMessageTooLargeError, type JsonRpcMessage, type StdioTransportOptions } from '@varin/pi-host/mcp-authority';
import { ManagedProcessLaunchError, type ManagedPipedProcessHandle, type ManagedProcessOwner } from '../process/types.js';
import { createMcpProcessTransport, type McpProcessSpawn } from './mcp-process-transport.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** Controlled native ports only: these tests exercise the real SDK parser/error classes,
 * not OS/kernel admission, durable process records or end-to-end tree ownership. */
function peer() {
  const completion = deferred<void>();
  const writes: { bytes: Buffer; done: (error?: Error | null) => void }[] = [];
  let acknowledge = true;
  const stdin = new Writable({ write(chunk: Buffer, _encoding, done) {
    writes.push({ bytes: Buffer.from(chunk), done });
    if (acknowledge) done();
  } });
  const child = Object.assign(new EventEmitter(), {
    stdin, stdout: new PassThrough(), stderr: new PassThrough(),
    pid: 123_456, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    exitConfirmed: false, killed: false, completion: completion.promise,
    requestTermination: vi.fn(async (_force?: boolean) => {}),
    kill: vi.fn(() => { throw new Error('No PID or legacy kill port is allowed'); }),
  }) satisfies ManagedPipedProcessHandle;
  return {
    child, completion, writes,
    holdWrites() { acknowledge = false; },
    finish() {
      child.exitConfirmed = true; child.exitCode = 0;
      child.stdout.end(); child.stderr.end();
      child.emit('exit', 0, null); child.emit('close', 0, null);
      completion.resolve();
    },
  };
}

function fixture(overrides: Partial<StdioTransportOptions> = {}, launch?: McpProcessSpawn) {
  const port = peer();
  const owner: ManagedProcessOwner<ManagedPipedProcessHandle> = { child: null };
  const options = Object.freeze({ command: '/sdk/resolved/mcp', args: ['resolved-argument'],
    cwd: '/admitted/execution', env: { MCP_TEST: 'resolved' }, inheritEnv: false, ...overrides });
  const spawn = vi.fn(launch ?? (() => port.child));
  const transport = createMcpProcessTransport(options, spawn, owner);
  const messages: JsonRpcMessage[] = [], errors: Error[] = [];
  const closed = vi.fn();
  transport.onMessage(message => messages.push(message));
  transport.onError(error => errors.push(error));
  transport.onClose(closed);
  return { ...port, owner, options, spawn, transport, messages, errors, closed };
}

test('uses trusted SDK options and frames raw split UTF-8/CRLF bytes with the SDK parser', async () => {
  const f = fixture();
  await f.transport.start();
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.spawn.mock.calls[0]?.[0]).toBe(f.options);
  expect(f.spawn.mock.calls[0]?.[1].aborted).toBe(false);
  const first = { jsonrpc: '2.0', id: 1, result: 'a🦀界b' };
  const wire = Buffer.from(`${JSON.stringify(first)}\r\n`);
  const split = wire.indexOf(Buffer.from('🦀')) + 2;
  f.child.stdout.write(wire.subarray(0, split));
  expect(f.messages).toEqual([]);
  f.child.stdout.write(wire.subarray(split, wire.length - 1));
  expect(f.messages).toEqual([]);
  f.child.stdout.write(Buffer.concat([wire.subarray(-1), Buffer.from('\r\n \n{"jsonrpc":"2.0","method":"ready"}\n')]));
  expect(f.messages).toEqual([first, { jsonrpc: '2.0', method: 'ready' }]);
  f.child.stdout.write('{"jsonrpc":"1.0","id":2,"result":true}\nnot json\n{"jsonrpc":"2.0","id":3,"result":true}\n');
  expect(f.errors).toHaveLength(2);
  expect(f.errors[0]).toMatchObject({ name: 'McpError', code: -32600, message: 'Invalid JSON-RPC message' });
  expect(f.messages.at(-1)).toEqual({ jsonrpc: '2.0', id: 3, result: true });
  f.finish(); await f.transport.close();
});

test('preserves the SDK 16 MiB frame default and rejects a split oversized frame with its actual typed error', async () => {
  const f = fixture(); await f.transport.start();
  const limit = 16 * 1024 * 1024;
  const empty = JSON.stringify({ jsonrpc: '2.0', id: 1, result: '' });
  const wire = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'x'.repeat(limit - Buffer.byteLength(empty)) });
  expect(Buffer.byteLength(wire)).toBe(limit);
  f.child.stdout.write(wire); f.child.stdout.write('\n');
  expect(f.messages).toHaveLength(1);
  expect(f.errors).toEqual([]);
  f.child.stdout.write(Buffer.alloc(limit, 0x20));
  f.child.stdout.write(' \n{"jsonrpc":"2.0","id":2,"result":true}\n');
  expect(f.errors).toHaveLength(1);
  expect(f.errors[0]).toBeInstanceOf(McpMessageTooLargeError);
  expect(f.errors[0]).toMatchObject({ code: 'mcp_message_too_large' });
  f.child.stdout.write('{"jsonrpc":"2.0","id":3,"result":true}\n');
  expect(f.messages).toHaveLength(1);
  expect(f.closed).toHaveBeenCalledTimes(1);
  await expect(f.transport.send({ jsonrpc: '2.0', method: 'after-frame-loss' })).rejects.toBeInstanceOf(McpConnectionClosedError);
  f.finish(); await f.transport.close();
});

test('an oversized complete frame stops its batch without replaying following frames', async () => {
  const f = fixture({ maxMessageBytes: 40 }); await f.transport.start();
  f.child.stdout.write('x'.repeat(41) + '\n{"jsonrpc":"2.0","method":"late"}\n');
  expect(f.errors[0]).toBeInstanceOf(McpMessageTooLargeError);
  expect(f.messages).toEqual([]);
  f.finish(); await f.transport.close();
  await expect(f.transport.start()).rejects.toBeInstanceOf(McpConnectionClosedError);
  expect(f.spawn).toHaveBeenCalledTimes(1);
});

test('send waits for the native stdin write receipt and preserves a failed receipt', async () => {
  const f = fixture(); f.holdWrites(); await f.transport.start();
  let sent = false;
  const message: JsonRpcMessage = { jsonrpc: '2.0', id: 'request', method: 'tools/list' };
  const sending = f.transport.send(message).then(() => { sent = true; });
  await flush();
  expect(sent).toBe(false);
  expect(f.writes[0]?.bytes.toString()).toBe(`${JSON.stringify(message)}\n`);
  f.writes[0]!.done(); await sending;
  expect(sent).toBe(true);
  const failure = new Error('native stdin interaction was rejected');
  const rejected = f.transport.send(message);
  const observed = expect(rejected).rejects.toBe(failure);
  f.writes[1]!.done(failure);
  await observed; await flush();
  expect(f.errors).toContain(failure);
  f.finish(); await f.transport.close();
  expect(f.child.kill).not.toHaveBeenCalled();
});

test('stderr retains a bounded raw tail and delivers only live chunks to the SDK callback', async () => {
  const onStderr = vi.fn();
  const f = fixture({ maxStderrBytes: 6, onStderr }); await f.transport.start();
  f.child.stderr.write(Buffer.from('old:'));
  f.child.stderr.write(Buffer.from('界界'));
  expect(f.transport.stderr).toBe('界界');
  f.child.stderr.write(Buffer.from('tail'));
  expect(f.transport.stderr).toBe(Buffer.from('界界tail').subarray(-6).toString());
  expect(onStderr.mock.calls.map(call => call[0])).toEqual(['old:', '界界', 'tail']);
  f.finish(); await f.transport.close();
  const disabled = fixture({ maxStderrBytes: 0 }); await disabled.transport.start();
  disabled.child.stderr.write('unretained'); expect(disabled.transport.stderr).toBe('');
  disabled.finish(); await disabled.transport.close();
});

test('close escalates through original termination ports but waits for actual completion', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const f = fixture(); await f.transport.start();
  let settled = false;
  const closing = f.transport.close();
  void closing.then(() => { settled = true; });
  expect(f.transport.close()).toBe(closing);
  await flush();
  expect(f.child.stdin.writableEnded).toBe(true);
  await vi.advanceTimersByTimeAsync(500);
  expect(f.child.requestTermination.mock.calls).toEqual([[false]]);
  f.child.exitCode = 0; f.child.emit('exit', 0, null); f.child.emit('close', 0, null);
  expect(settled).toBe(false); expect(f.owner.child).toBe(f.child);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(f.child.requestTermination.mock.calls).toEqual([[false], [true]]);
  expect(settled).toBe(false); expect(f.owner.child).toBe(f.child);
  f.finish(); await closing;
  expect(f.owner.child).toBeNull(); expect(f.closed).toHaveBeenCalledTimes(1);
  expect(f.child.kill).not.toHaveBeenCalled();
});

test('denied termination stays rejected and retains the original owner on repeated close', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const f = fixture({ closeTimeoutMs: 1 }); await f.transport.start();
  const denied = new Error('native termination denied');
  f.child.requestTermination.mockRejectedValue(denied);
  const closing = f.transport.close();
  const rejection = expect(closing).rejects.toBe(denied);
  await vi.advanceTimersByTimeAsync(1); await rejection;
  expect(f.transport.close()).toBe(closing);
  await expect(f.transport.close()).rejects.toBe(denied);
  expect(f.owner.child).toBe(f.child); expect(f.closed).not.toHaveBeenCalled();
  expect(f.child.kill).not.toHaveBeenCalled();
  f.finish(); await flush();
});

test('kernel loss settles the protocol but never supplies an exit receipt', async () => {
  const f = fixture(); await f.transport.start();
  const lost = new Error('native process connection lost');
  f.completion.reject(lost); await flush();
  expect(f.errors).toEqual([lost]); expect(f.closed).toHaveBeenCalledTimes(1);
  await expect(f.transport.close()).rejects.toBe(lost);
  expect(f.owner.child).toBe(f.child);
  await expect(f.transport.send({ jsonrpc: '2.0', method: 'late' })).rejects.toBeInstanceOf(McpConnectionClosedError);
  f.child.stdout.end(); f.child.stderr.end();
});

test('a termination deadline retains the child and the same failed close outcome', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const f = fixture({ closeTimeoutMs: 1 }); await f.transport.start();
  const closing = f.transport.close();
  const rejection = expect(closing).rejects.toThrow('Process termination is unconfirmed');
  await vi.advanceTimersByTimeAsync(5_002); await rejection;
  expect(f.child.requestTermination.mock.calls).toEqual([[false], [true]]);
  expect(f.owner.child).toBe(f.child); expect(f.transport.close()).toBe(closing);
  expect(f.child.kill).not.toHaveBeenCalled();
  f.finish(); await flush();
});

test('missing native completion or termination ports cannot fall back to legacy kill', async () => {
  const original = peer();
  Object.assign(original.child, { completion: undefined, requestTermination: undefined });
  const f = fixture({}, () => original.child);
  await expect(f.transport.start()).rejects.toBeInstanceOf(ManagedProcessLaunchError);
  expect(f.owner.child).toBe(original.child);
  await expect(f.transport.close()).rejects.toThrow('owned native process completion and termination port');
  expect(f.owner.child).toBe(original.child); expect(original.child.kill).not.toHaveBeenCalled();
  original.finish(); await flush();
});

test('close during admission drains the exact late child before resolving', async () => {
  const late = deferred<ManagedPipedProcessHandle>();
  const f = fixture({}, () => late.promise);
  const starting = f.transport.start();
  const rejectedStart = expect(starting).rejects.toMatchObject({ name: 'AbortError' });
  let settled = false;
  const closing = f.transport.close().then(() => { settled = true; });
  expect(f.spawn.mock.calls[0]?.[1].aborted).toBe(true);
  late.resolve(f.child); await flush();
  expect(f.child.requestTermination.mock.calls).toEqual([[true]]);
  expect(settled).toBe(false); expect(f.owner.child).toBe(f.child);
  f.child.stdout.write('{"jsonrpc":"2.0","id":1,"result":"discarded"}\n');
  f.finish(); await closing; await rejectedStart;
  expect(f.messages).toEqual([]); expect(f.owner.child).toBeNull();
  expect(f.child.kill).not.toHaveBeenCalled();
});

test('a failed handoff retains and drains the ManagedProcessLaunchError child', async () => {
  const original = peer();
  const failure = new ManagedProcessLaunchError(original.child, new Error('handoff failed'));
  const f = fixture({}, () => { throw failure; });
  await expect(f.transport.start()).rejects.toBe(failure);
  expect(f.owner.child).toBe(original.child);
  const closing = f.transport.close();
  original.finish(); await closing;
  expect(f.owner.child).toBeNull(); expect(original.child.kill).not.toHaveBeenCalled();
});

test('natural EOF reports incomplete bytes and drains before one close event', async () => {
  const f = fixture(); await f.transport.start();
  f.child.stdout.write('{"jsonrpc":"2.0"');
  f.finish(); await flush(); await f.transport.close();
  expect(f.errors).toHaveLength(1);
  expect(f.errors[0]?.message).toContain('incomplete JSON-RPC message');
  expect(f.closed).toHaveBeenCalledTimes(1);
  expect(f.owner.child).toBeNull();
});

test('buffered complete frames arriving with an already finished handle are still delivered once', async () => {
  const f = fixture();
  f.child.stdout.write('{"jsonrpc":"2.0","method":"buffered"}\n'); f.finish();
  await f.transport.start(); await flush(); await f.transport.close();
  expect(f.messages).toEqual([{ jsonrpc: '2.0', method: 'buffered' }]);
  expect(f.closed).toHaveBeenCalledTimes(1);
});

test('close before start prevents any admission and listeners can unsubscribe', async () => {
  const f = fixture(); const removed = vi.fn();
  const off = f.transport.onClose(removed); off();
  await f.transport.close();
  await expect(f.transport.start()).rejects.toBeInstanceOf(McpConnectionClosedError);
  expect(f.spawn).not.toHaveBeenCalled(); expect(removed).not.toHaveBeenCalled();
  expect(f.closed).toHaveBeenCalledTimes(1);
});
