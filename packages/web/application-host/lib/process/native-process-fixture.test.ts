import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import type { KernelClientOptions } from '../kernel/kernel-client.js';
import type { NativeProcessDiagnostic } from './native-process.test-helper.js';

// These doubles represent acquired resources, not process behavior. The owner
// under test is the fixture itself; its temp directory and rollback are real.
const resources = vi.hoisted(() => ({
  start: vi.fn(), close: vi.fn(), disposeDocuments: vi.fn(), disposeAdapter: vi.fn(),
  disposeService: vi.fn(), createClient: vi.fn(), bind: vi.fn(), spawn: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: resources.spawn }));
vi.mock('../kernel/kernel-client.js', () => ({ createKernelClient: resources.createClient }));
vi.mock('../documents/authority.js', () => ({ createDocumentAuthority: () => ({
  dispose: resources.disposeDocuments, bindDurableMutationStorage: resources.bind,
}) }));
vi.mock('../kernel/storage-adapter.js', () => ({ KernelStorageAdapter: class {
  bindFileStore() {}
  dispose = resources.disposeAdapter;
} }));
vi.mock('../kernel/file-resource-backend.js', () => ({ KernelFileResourceBackend: class {} }));
vi.mock('../kernel/kernel-recovery-store.js', () => ({ KernelRecoveryContentStore: class {}, KernelRecoveryStore: class {} }));
vi.mock('../kernel/process-service.js', () => ({ createKernelProcessService: () => ({ dispose: resources.disposeService }) }));

vi.stubEnv('VARIN_TEST_KERNEL_PATH', process.execPath);
const { createNativeProcessTestHarness } = await import('./native-process.test-helper.js');
afterAll(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.resetAllMocks();
  resources.start.mockResolvedValue(undefined);
  resources.createClient.mockImplementation(() => ({ start: resources.start, close: resources.close }));
});
const createdRoot = () => path.dirname(resources.createClient.mock.calls[0]![0].storageRoot as string);

it('rolls back owned resources when kernel startup fails before get can return', async () => {
  const failed = new Error('handshake rejected');
  resources.start.mockRejectedValue(failed);
  const fixture = createNativeProcessTestHarness();
  await expect(fixture.get()).rejects.toBe(failed);
  expect(resources.close).toHaveBeenCalledOnce();
  expect(resources.disposeDocuments).toHaveBeenCalledOnce();
  expect(fs.existsSync(createdRoot())).toBe(false);
  await fixture.dispose();
  expect(resources.close).toHaveBeenCalledOnce();
});

it('releases later resources and the directory even when one teardown fails', async () => {
  const fixture = createNativeProcessTestHarness();
  await fixture.get();
  const failed = new Error('process teardown failed');
  resources.disposeService.mockRejectedValue(failed);
  await expect(fixture.dispose()).rejects.toMatchObject({ errors: [failed] });
  expect(resources.disposeAdapter).toHaveBeenCalledOnce();
  expect(resources.close).toHaveBeenCalledOnce();
  expect(resources.disposeDocuments).toHaveBeenCalledOnce();
  expect(fs.existsSync(createdRoot())).toBe(false);
  await fixture.dispose();
  expect(resources.disposeService).toHaveBeenCalledOnce();
});

it.each([false, true])('awaits Documents before revoking storage or closing the kernel (Documents failure: %s)', async (failDocuments) => {
  const fixture = createNativeProcessTestHarness();
  await fixture.get();
  const order: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const failed = new Error('document teardown failed');
  resources.disposeService.mockImplementation(async () => { order.push('processes'); });
  resources.disposeDocuments.mockImplementation(async () => {
    order.push('documents-start');
    await pending;
    order.push('documents-end');
    if (failDocuments) throw failed;
  });
  resources.disposeAdapter.mockImplementation(async () => { order.push('storage'); });
  resources.close.mockImplementation(async () => { order.push('kernel'); });
  const closing = fixture.dispose();
  // Observe the actual disposer entering before allowing it to complete.
  try {
    await vi.waitFor(() => expect(order).toEqual(['processes', 'documents-start']));
    expect(resources.disposeAdapter).not.toHaveBeenCalled();
    expect(resources.close).not.toHaveBeenCalled();
  } finally {
    release();
    if (failDocuments) await expect(closing).rejects.toMatchObject({ errors: [failed] });
    else await closing;
  }
  expect(order).toEqual(['processes', 'documents-start', 'documents-end', 'storage', 'kernel']);
  expect(fs.existsSync(createdRoot())).toBe(false);
});

it('does not dispose a caller-owned document authority during rollback', async () => {
  resources.start.mockRejectedValue(new Error('handshake rejected'));
  const dispose = vi.fn();
  const fixture = createNativeProcessTestHarness({ dispose } as never);
  await expect(fixture.get()).rejects.toThrow('handshake rejected');
  expect(dispose).not.toHaveBeenCalled();
  expect(fs.existsSync(createdRoot())).toBe(false);
});

// Exercise the fixture's actual stderr observer through KernelClient's supported
// spawn seam. Only the OS spawn boundary is doubled; no process or IPC is opened.
async function diagnosticFixture(observe: (event: NativeProcessDiagnostic) => void) {
  const fixture = createNativeProcessTestHarness(undefined, { onProcessDiagnostic: observe });
  try {
    await fixture.get();
    const options = resources.createClient.mock.calls[0]![0] as KernelClientOptions;
    const stderr = new EventEmitter();
    const child = { stderr };
    resources.spawn.mockReturnValue(child);
    const args = ['--stdio'];
    const spawnOptions = { env: options.env };
    expect(options.spawnProcess!(process.execPath, args, spawnOptions)).toBe(child);
    expect(resources.spawn).toHaveBeenCalledExactlyOnceWith(process.execPath, args, spawnOptions);
    return { fixture, stderr, options };
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}

const stage = (elapsedMs: number): NativeProcessDiagnostic => ({
  processId: 'fixture-process', guardianPid: 123, elapsedMs, stage: 'stop-received',
});
const diagnosticLine = (value: unknown) => `[native process stage] ${JSON.stringify(value)}\n`;

it('enables tracing only for an opted-in fixture without mutating the inherited environment', async () => {
  const inheritedTrace = process.env.VARIN_PROCESS_TRACE;
  const hadOwnTrace = Object.hasOwn(process.env, 'VARIN_PROCESS_TRACE');
  const plain = createNativeProcessTestHarness();
  try {
    await plain.get();
    const options = resources.createClient.mock.calls[0]![0] as KernelClientOptions;
    expect(options.env).toBeUndefined();
    expect(options.spawnProcess).toBeUndefined();
    expect(resources.spawn).not.toHaveBeenCalled();
  } finally { await plain.dispose(); }

  resources.createClient.mockClear();
  const traced = await diagnosticFixture(vi.fn());
  try {
    expect(traced.options.env).toEqual({ VARIN_PROCESS_TRACE: '1' });
    expect(process.env.VARIN_PROCESS_TRACE).toBe(inheritedTrace);
    expect(Object.hasOwn(process.env, 'VARIN_PROCESS_TRACE')).toBe(hadOwnTrace);
  } finally { await traced.fixture.dispose(); }
});

it('observes fragmented and coalesced diagnostic lines only after their newline', async () => {
  const observe = vi.fn();
  const { fixture, stderr } = await diagnosticFixture(observe);
  try {
    const first = diagnosticLine(stage(1));
    stderr.emit('data', Buffer.from(first.slice(0, 10)));
    stderr.emit('data', first.slice(10, -1));
    expect(observe).not.toHaveBeenCalled();
    stderr.emit('data', `\n${diagnosticLine(stage(2))}${diagnosticLine(stage(3))}`);
    expect(observe.mock.calls).toEqual([[stage(1)], [stage(2)], [stage(3)]]);
  } finally { await fixture.dispose(); }
});

it('ignores unrelated, malformed, and invalid diagnostic stderr without losing later stages', async () => {
  const observe = vi.fn();
  const { fixture, stderr } = await diagnosticFixture(observe);
  try {
    stderr.emit('data', `unrelated stderr\nnot-at-start ${diagnosticLine(stage(1))}[native process stage] {broken}\n`);
    for (const invalid of [
      null, [], {}, { ...stage(1), processId: '' }, { ...stage(1), guardianPid: 0 },
      { ...stage(1), guardianPid: '123' }, { ...stage(1), guardianPid: 1.5 },
      { ...stage(1), guardianPid: Number.MAX_SAFE_INTEGER + 1 },
      { ...stage(1), elapsedMs: -1 }, { ...stage(1), elapsedMs: '1' },
      { ...stage(1), elapsedMs: 1.5 }, { ...stage(1), stage: 'unsafe stage\n' },
    ]) stderr.emit('data', diagnosticLine(invalid));
    expect(observe).not.toHaveBeenCalled();
    stderr.emit('data', diagnosticLine(stage(0)));
    expect(observe).toHaveBeenCalledExactlyOnceWith(stage(0));
  } finally { await fixture.dispose(); }
});

it('forwards only the four diagnostic metadata fields', async () => {
  const observe = vi.fn();
  const { fixture, stderr } = await diagnosticFixture(observe);
  try {
    stderr.emit('data', diagnosticLine({
      ...stage(1), args: ['private argument'], output: 'private output', env: { PRIVATE: 'private value' },
    }));
    expect(observe).toHaveBeenCalledExactlyOnceWith(stage(1));
  } finally { await fixture.dispose(); }
});

it('discards oversized partial lines through their newline and resumes on the next line', async () => {
  const observe = vi.fn();
  const { fixture, stderr } = await diagnosticFixture(observe);
  try {
    stderr.emit('data', 'x'.repeat(16 * 1024));
    stderr.emit('data', diagnosticLine(stage(1)).trimEnd());
    expect(observe).not.toHaveBeenCalled();
    stderr.emit('data', `\n${diagnosticLine(stage(2))}`);
    stderr.emit('data', `${'x'.repeat(16 * 1024)}\n${diagnosticLine(stage(3))}`);
    expect(observe.mock.calls).toEqual([[stage(2)], [stage(3)]]);
  } finally { await fixture.dispose(); }
});

it('isolates observer failures and continues forwarding later stages', async () => {
  const observe = vi.fn().mockImplementationOnce(() => { throw new Error('observer failed'); });
  const { fixture, stderr } = await diagnosticFixture(observe);
  try {
    expect(() => stderr.emit('data', `${diagnosticLine(stage(1))}${diagnosticLine(stage(2))}`)).not.toThrow();
    expect(observe.mock.calls).toEqual([[stage(1)], [stage(2)]]);
  } finally { await fixture.dispose(); }
  expect(resources.close).toHaveBeenCalledOnce();
  expect(fs.existsSync(createdRoot())).toBe(false);
});
