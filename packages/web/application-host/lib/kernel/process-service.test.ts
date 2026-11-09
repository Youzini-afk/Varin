import { expect, it, vi } from 'vitest';
import { KernelManagedProcess, projectProcessTerminal, type ProcessProjectionClient } from './process-service.js';
import type { KernelProcessObserver } from './kernel-client.js';
import { KERNEL_PROTOCOL_VERSION, type KernelProcessReadResult, type KernelProcessSnapshot } from './protocol.generated.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture(overrides: Partial<KernelProcessSnapshot> = {}) {
  const initial: KernelProcessSnapshot = { processId: 'process', kernelEpoch: 'epoch', workspaceId: 'workspace', cwd: '/workspace', mode: 'pipe',
    status: 'running', pid: 123, exitCode: null, signal: null, reason: null, writerActive: true, outputAvailable: true, ...overrides };
  let observer!: KernelProcessObserver;
  const scoped = {
    processSubscribe: vi.fn(async (_params, receive: KernelProcessObserver) => {
      observer = receive;
      queueMicrotask(() => control());
      return { close: vi.fn(async () => {}), closed: new Promise<void>(() => {}), acknowledge: async () => {} };
    }),
    processWrite: vi.fn(), processResize: vi.fn(), processKill: vi.fn(), processRelease: vi.fn(async () => ({ ...initial, status: 'released' as const, writerActive: false })),
  } satisfies ProcessProjectionClient;
  const errors: Error[] = [];
  const child = new KernelManagedProcess(scoped, { workspaceId: 'workspace', processId: 'process' }, initial, error => errors.push(error), () => {});
  let cursor = 0;
  const emit = (stream: 'control' | 'data', fields: Partial<KernelProcessReadResult>) => observer({
    v: KERNEL_PROTOCOL_VERSION, kind: 'process-event', replayCursor: 0, grantId: 'grant', error: null, stream,
    subscriptionId: 'subscription', processId: 'process', kernelEpoch: 'epoch', sequence: 0,
    result: { process: initial, chunks: [], nextCursor: cursor, endCursor: cursor, inputSequence: -1, inputError: null,
      outputComplete: false, outputError: null, ...fields },
  }, async () => {});
  const control = (fields: Partial<KernelProcessReadResult> = {}) => emit('control', fields);
  const data = async (channel: 'stdout' | 'stderr', bytes: Buffer, textChunks?: KernelProcessReadResult['textChunks']) => {
    const offset = cursor; cursor += bytes.length;
    emit('data', { chunks: [{ channel, offset, bytesBase64: bytes.toString('base64') }], ...(textChunks === undefined ? {} : { textChunks }) });
    await turn();
  };
  const exit = (fields: Partial<KernelProcessReadResult> = {}) => control({
    process: { ...initial, status: 'exited', writerActive: false, exitCode: 0 }, ...fields,
  });
  await child.start();
  return { child, errors, control, data, exit, scoped };
}

it('applies channel EOF only after its raw watermark and waits for capture after an early exit', async () => {
  const f = await fixture();
  let stdout = ''; let stderr = '';
  f.child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
  f.child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
  await f.data('stdout', Buffer.from([0xe4, 0xb8]));
  expect(stdout).toBe('');
  f.control({ endCursor: 3, channelEnds: [{ channel: 'stdout', offset: 3 }] });
  await turn();
  expect(f.child.stdout.readableEnded).toBe(false);
  await f.data('stdout', Buffer.from([0xad]));
  expect(stdout).toBe('中');
  expect(f.child.stdout.readableEnded).toBe(true);
  f.exit();
  await turn();
  expect(f.child.stderr.readableEnded).toBe(false);
  let completed = false;
  void f.child.completion.then(() => { completed = true; });
  await f.data('stderr', Buffer.from('later'));
  expect(completed).toBe(false);
  f.exit({ outputComplete: true, channelEnds: [{ channel: 'stdout', offset: 3 }, { channel: 'stderr', offset: 8 }] });
  await f.child.completion;
  expect(stderr).toBe('later');
  expect(f.errors).toEqual([]);
});

it('keeps the terminal UTF-8 StringDecoder across single-byte chunks and flushes before exit', async () => {
  const f = await fixture();
  const terminal = projectProcessTerminal(f.child);
  let output = ''; let exited = false;
  terminal.onData(text => { output += text; });
  terminal.onExit(() => { exited = true; });
  for (const byte of Buffer.from('中🙂')) await f.data('stdout', Buffer.from([byte]));
  expect(output).toBe('中🙂');
  expect(exited).toBe(false);
  f.exit({ outputComplete: true, channelEnds: [{ channel: 'stdout', offset: 7 }] });
  await terminal.completion;
  expect(output).toBe('中🙂');
  expect(exited).toBe(true);
  expect(f.errors).toEqual([]);
});

it('does not let an early channel read error and exit truncate another channel', async () => {
  const f = await fixture();
  f.child.stdout.resume();
  let stderr = '';
  f.child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  f.control({ channelEnds: [{ channel: 'stdout', offset: 0, error: 'reader failed' }] });
  f.exit();
  await turn();
  expect(f.child.stderr.readableEnded).toBe(false);
  await f.data('stderr', Buffer.from('retained tail'));
  f.exit({ outputError: 'capture failed after drain', channelEnds: [{ channel: 'stderr', offset: 13 }] });
  await expect(f.child.completion).rejects.toThrow('reader failed');
  expect(stderr).toBe('retained tail');
});


it('adopts a legacy PTY using native text and strict native input without changing its ANSI stream', async () => {
  const f = await fixture({ mode: 'pty', inputEncoding: 'gbk', outputEncoding: 'gbk' });
  const terminal = projectProcessTerminal(f.child);
  let output = '';
  terminal.onData(text => { output += text; });
  const ansi = Buffer.from('\x1b[31m');
  await f.data('stdout', Buffer.concat([ansi, Buffer.from([0xd6])]), [{ channel: 'stdout', offset: 0, byteLength: ansi.length,
    bytesBase64: ansi.toString('base64'), text: '\x1b[31m', encoding: 'gbk', sourceRanges: [{ offset: 0, byteLength: ansi.length }] }]);
  expect(output).toBe('\x1b[31m');
  await f.data('stdout', Buffer.from([0xd0]), [{ channel: 'stdout', offset: ansi.length, byteLength: 2,
    bytesBase64: '1tA=', text: '中', encoding: 'gbk', sourceRanges: [{ offset: ansi.length, byteLength: 2 }] }]);
  expect(output).toBe('\x1b[31m中');
  f.scoped.processWrite.mockImplementation(async params => ({ processId: 'process', operationId: params.operationId,
    kernelEpoch: 'epoch', sequence: 0, kind: 'write', state: 'applied', cancelled: false, reason: null,
    requestedBytes: 2, confirmedBytes: 2, eofRequested: false, eofApplied: false }));
  await terminal.write('文', 'encoded-input');
  expect(f.scoped.processWrite).toHaveBeenCalledWith({ workspaceId: 'workspace', processId: 'process', operationId: 'encoded-input', text: '文' });
  f.exit({ outputComplete: true, channelEnds: [{ channel: 'stdout', offset: ansi.length + 2 }] });
  await terminal.completion;
  expect(f.errors).toEqual([]);
});
