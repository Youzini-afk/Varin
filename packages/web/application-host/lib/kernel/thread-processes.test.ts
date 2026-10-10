import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createTerminalRuntime } from '../terminal/runtime.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient, KernelGrantHandle, KernelProcessObserver } from './kernel-client.js';
import type { KernelProcessInteractionReceipt, KernelProcessSnapshot } from './protocol.generated.js';
import { createThreadProcesses } from './thread-processes.js';
import { ProcessInteractionError } from './process-interaction.js';

const identity = { runtime: 'agent' as const, threadId: 'thread:process', branchId: 'branch:process', operationId: 'original-process' };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

/** Real runtime client, source rebind, process projection and terminal consumer. Only framed kernel
 * resource responses are supplied here; actual OS receipts are exercised in the Rust guardian tests. */
function fixture() {
  const routes = new Map<string, (req: never, res: never) => Promise<void>>();
  const spawn = vi.fn(() => { throw new Error('Opening an admitted process must never spawn'); });
  const terminal = createTerminalRuntime({
    app: { get() {}, post(name: string, handler: never) { routes.set(name, handler); }, delete() {} },
    server: new EventEmitter(), fs, path, uiAuthController: null, loadPtyProvider: async () => ({ backend: 'fixture', spawn }),
    buildAugmentedPath: () => '', searchPathFor: () => null, isExecutable: () => false,
    isRequestOriginAllowed: async () => true, rejectWebSocketUpgrade() {},
    TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 30_000, TERMINAL_INPUT_WS_REBIND_WINDOW_MS: 1000,
    TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW: 3,
  } as unknown as Parameters<typeof createTerminalRuntime>[0]);
  cleanup.push(() => terminal.shutdown());
  const original: KernelProcessSnapshot = { processId: identity.operationId, kernelEpoch: 'epoch', workspaceId: 'workspace',
    cwd: '/workspace/subdirectory', mode: 'pty', status: 'running', pid: 123, exitCode: null, signal: null,
    reason: null, writerActive: true, outputAvailable: true };
  const observers: KernelProcessObserver[] = [];
  const exits = new Set<(error: Error) => void>();
  const calls: Array<{ params: Record<string, unknown>; resolve(value: KernelProcessInteractionReceipt): void }> = [];
  const closed = vi.fn(async () => {});
  const scoped = {
    fileRootRegister: vi.fn(async () => ({ rootId: 'root', canonicalRoot: '/workspace' })),
    processSubscribe: vi.fn(async (_params: unknown, observer: KernelProcessObserver) => {
      observers.push(observer);
      queueMicrotask(() => emit(observer, 'control', [], 0, original));
      return { close: closed, closed: new Promise<void>(() => {}), acknowledge: async () => {} };
    }),
    processWrite: vi.fn((params: Record<string, unknown>) => new Promise<KernelProcessInteractionReceipt>(resolve => calls.push({ params, resolve }))),
    processResize: vi.fn((params: Record<string, unknown>) => new Promise<KernelProcessInteractionReceipt>(resolve => calls.push({ params, resolve }))),
    processKill: vi.fn(), processRelease: vi.fn(),
  };
  const requests = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'runtime.operation.inspect') return { id: identity.operationId, run_id: 'run', executor: 'process_spawn' };
    if (method === 'runtime.run.inspect') return { id: 'run', thread_id: identity.threadId, branch_id: identity.branchId, state: 'completed' };
    if (method === 'runtime.launch.inspect') return { selection: { source: { mode: 'live_root', workspace_id: 'workspace',
      execution_workspace_id: 'execution', branch_id: null, revision: null, environment_run_id: null,
      live_root: { hostId: 'host', rootId: 'root', canonicalRoot: '/workspace' } },
      tools: [{ name: 'process_spawn' }, { name: 'process_write' }, { name: 'process_resize' }], extension_bindings: [], mcp_binding: null } };
    if (method === 'runtime.process.access') return { ...identity, runId: 'run', workspaceId: 'workspace', rootId: 'root', process: original };
    if (method === 'runtime.operation.cancel') return { id: params.operationId, executor: 'process_spawn', cancel_requested: true };
    throw new Error(`Unexpected request ${method}`);
  });
  const kernel = { subscribeExit(listener: (error: Error) => void) { exits.add(listener); return () => exits.delete(listener); },
    onToolReleased() {}, cancelRunPreparation() {}, unregisterCredentialOwner() {}, unregisterToolOwners() {}, releaseRunPolicyOwners() {}, agentRuntimeRequest: requests,
    issueGrant: vi.fn(async (params: Record<string, unknown>) => ({ ...params, kernelEpoch: 'epoch' }) as unknown as KernelGrantHandle),
    revokeGrant: vi.fn(async () => {}), scoped: vi.fn(() => scoped),
  };
  const runtime = new AgentRuntimeClient(kernel as unknown as KernelClient);
  const errors: unknown[] = [];
  const service = createThreadProcesses({ runtime, kernel: kernel as unknown as KernelClient, terminal: () => terminal,
    resolveLiveSource: async () => {}, onError: error => errors.push(error) });
  function emit(observer: KernelProcessObserver, stream: 'control' | 'data', chunks: Array<{ channel: 'stdout'; offset: number; bytesBase64: string }>, cursor: number, process = original) {
    observer({ v: 1, kind: 'process-event', grantId: 'grant', error: null, stream, subscriptionId: 'subscription', processId: process.processId, kernelEpoch: 'epoch', sequence: 0,
      result: { process, chunks, nextCursor: cursor, endCursor: cursor, inputSequence: -1, inputError: null,
        outputComplete: !process.writerActive, outputError: null } }, async () => {});
  }
  function settle(index: number, state: 'applied' | 'partial' = 'applied') {
    const { params, resolve } = calls[index]!;
    const base = { processId: String(params.processId), operationId: String(params.operationId), kernelEpoch: 'epoch',
      sequence: index, state, reason: state === 'partial' ? 'pipe closed after prefix' : null, cancelled: false };
    const receipt: KernelProcessInteractionReceipt = typeof params.bytesBase64 === 'string'
      ? { ...base, kind: 'write', requestedBytes: Buffer.from(params.bytesBase64, 'base64').length,
        confirmedBytes: state === 'applied' ? Buffer.from(params.bytesBase64, 'base64').length : 1, eofRequested: false, eofApplied: false }
      : { ...base, kind: 'resize', cols: Number(params.cols), rows: Number(params.rows) };
    resolve(receipt); return receipt;
  }
  return { service, terminal, kernel, scoped, requests, spawn, calls, settle, original, observers, emit, routes, errors, exits };
}

it('adopts the original completed-run PTY once, shares acknowledged input and resize, and retains its output on view detach', async () => {
  const f = fixture();
  const [first, duplicate] = await Promise.all([f.service.openTerminal(identity), f.service.openTerminal(identity)]);
  expect(duplicate).toEqual(first); expect(first.cwd).toBe('/workspace/subdirectory');
  expect(f.spawn).not.toHaveBeenCalled(); expect(f.kernel.issueGrant).toHaveBeenCalledTimes(1);
  expect(f.scoped.processSubscribe).toHaveBeenCalledWith(expect.objectContaining({ processId: identity.operationId, rootId: 'root', cursor: 0 }), expect.any(Function));
  expect(f.requests).toHaveBeenCalledWith('runtime.process.access', expect.objectContaining({ operationId: identity.operationId,
    toolBinding: expect.objectContaining({ runId: 'run', rootId: 'root', sourceMode: 'live_root' }) }), undefined);
  const handle = f.terminal.attachTerminalSession(first.sessionId)!;
  let written = false;
  const write = Promise.resolve(handle.write('hello')).then(() => { written = true; });
  await turn(); expect(written).toBe(false);
  expect(f.calls[0]!.params).toMatchObject({ processId: identity.operationId, rootId: 'root', bytesBase64: Buffer.from('hello').toString('base64') });
  expect(f.calls[0]!.params).not.toHaveProperty('sequence');
  f.settle(0); await write; expect(written).toBe(true);
  let resized = false;
  const response = { statusCode: 200, status(n: number) { this.statusCode = n; return this; }, json() { resized = true; } };
  const resize = f.routes.get('/api/terminal/:sessionId/resize')!({ params: { sessionId: first.sessionId }, body: { cols: 111, rows: 41 } } as never, response as never);
  await turn(); expect(resized).toBe(false); f.settle(1); await resize; expect(resized).toBe(true);
  expect(response.statusCode).toBe(200);
  const output: string[] = []; handle.onData(value => output.push(value));
  f.emit(f.observers[0]!, 'data', [{ channel: 'stdout', offset: 0, bytesBase64: Buffer.from('saved output').toString('base64') }], 12);
  await turn(); expect(output.join('')).toBe('saved output');
  const theme = '\x1b[?996n';
  f.emit(f.observers[0]!, 'data', [{ channel: 'stdout', offset: 12, bytesBase64: Buffer.from(theme).toString('base64') }], 12 + Buffer.byteLength(theme));
  await turn(); expect(f.calls).toHaveLength(3);
  expect(Buffer.from(String(f.calls[2]!.params.bytesBase64), 'base64').toString()).toBe('\x1b[?997;1n');
  expect(new Set(f.calls.map(call => call.params.operationId)).size).toBe(3);
  f.settle(2); await turn();
  await handle.destroy();
  expect((await f.service.openTerminal(identity)).sessionId).toBe(first.sessionId);
  const restart = { statusCode: 200, status(n: number) { this.statusCode = n; return this; }, json() {} };
  await f.routes.get('/api/terminal/:sessionId/restart')!({ params: { sessionId: first.sessionId } } as never, restart as never);
  expect(restart.statusCode).toBe(409);
  expect(f.scoped.processKill).not.toHaveBeenCalled(); expect(f.scoped.processRelease).not.toHaveBeenCalled();
  await f.terminal.shutdown();
  expect(f.kernel.revokeGrant).toHaveBeenCalledTimes(1);
  expect(f.requests.mock.calls.some(([method]) => method === 'runtime.operation.cancel')).toBe(false);
});

it('retains partial input evidence, never retries it, and rebinds a failed view to the same original job', async () => {
  const f = fixture();
  const opened = await f.service.openTerminal(identity);
  const handle = f.terminal.attachTerminalSession(opened.sessionId)!;
  const errors: Error[] = []; handle.onError?.(error => errors.push(error));
  const rejected = expect(handle.write('not-all-written')).rejects.toBeInstanceOf(ProcessInteractionError);
  await turn(); const receipt = f.settle(0, 'partial'); await rejected;
  expect(errors[0]).toMatchObject({ receipt }); expect(handle.status).toBe('error');
  expect(f.scoped.processWrite).toHaveBeenCalledTimes(1);
  const rebound = await f.service.openTerminal(identity);
  expect(rebound).toEqual(opened); expect(handle.status).toBe('running');
  expect(f.kernel.issueGrant).toHaveBeenCalledTimes(2); expect(f.kernel.revokeGrant).toHaveBeenCalledTimes(1);
  expect(f.spawn).not.toHaveBeenCalled(); expect(f.scoped.processRelease).not.toHaveBeenCalled();
  const stopping = handle.terminate();
  await turn();
  expect(f.requests).toHaveBeenCalledWith('runtime.operation.cancel', { operationId: identity.operationId }, undefined);
  f.emit(f.observers.at(-1)!, 'control', [], 0, { ...f.original, writerActive: false, status: 'exited', exitCode: 0 });
  await stopping;
  expect(handle.status).toBe('exited'); expect(f.scoped.processKill).not.toHaveBeenCalled();
  expect(f.scoped.processRelease).not.toHaveBeenCalled();
});

it('rejects a foreign branch before granting or exposing the original process', async () => {
  const f = fixture();
  await expect(f.service.openTerminal({ ...identity, branchId: 'foreign' })).rejects.toThrow('this branch');
  expect(f.kernel.issueGrant).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
});
