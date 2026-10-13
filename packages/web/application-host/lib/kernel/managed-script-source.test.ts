import { expect, it, vi } from 'vitest';
import type { ManagedSourceClient } from '../harness/managed-remote-client.js';
import type { ManagedScriptControlReceipt, ManagedScriptControlRequest } from '../harness/managed-remote-types.js';
import type { KernelProcessSnapshot } from './protocol.generated.js';
import { controlManagedScript, stopManagedScript } from './managed-script-source.js';
import { ManagedSourceBridge, type PrivateManagedSourceFrame } from './managed-source-bridge.js';

const original: ManagedScriptControlRequest = {
  coordinatorHostId: 'host-a', processId: 'original-script', runId: 'original-run', threadId: 'original-thread', stop: false,
  source: { resource_owner: { kind: 'managed_host', hostId: 'host-b', connectionId: 'connection-b', endpointIdentity: 'endpoint-b' },
    mode: 'materialized', workspace_id: 'source-workspace', execution_workspace_id: 'execution-workspace',
    branch_id: 'original-branch', revision: 7, live_root: null, environment_run_id: null },
};

function terminal(): ManagedScriptControlReceipt & { process: KernelProcessSnapshot & { treeConfirmed: boolean } } {
  return { processId: original.processId, runId: original.runId, threadId: original.threadId,
    source: structuredClone(original.source), accepted: true, executorStopped: true,
    process: { processId: original.processId, kernelEpoch: 'original-b-epoch', workspaceId: original.source.workspace_id,
      cwd: '/original/source', mode: 'pipe', status: 'exited', pid: 123, exitCode: 0, signal: null, reason: null,
      writerActive: false, treeConfirmed: true, outputAvailable: true } };
}

function sourcePort(receipt: ManagedScriptControlReceipt) {
  const scriptControl = vi.fn(async (_input: ManagedScriptControlRequest) => receipt);
  return { scriptControl, client: { scriptControl } as unknown as ManagedSourceClient };
}

it('passes the original observation and stop requests unchanged and preserves pending versus stopped evidence', async () => {
  const pending: ManagedScriptControlReceipt = { ...terminal(), executorStopped: false, process: null };
  const stopped = terminal();
  const { client, scriptControl } = sourcePort(pending);
  scriptControl.mockResolvedValueOnce(pending).mockResolvedValueOnce(stopped);
  const observation = structuredClone(original);
  const stop = { ...structuredClone(original), stop: true };
  const before = structuredClone([observation, stop]);

  await expect(controlManagedScript(client, observation)).resolves.toBe(pending);
  await expect(controlManagedScript(client, stop)).resolves.toBe(stopped);
  expect(scriptControl.mock.calls).toEqual([[before[0]], [before[1]]]);
  expect(scriptControl.mock.calls[0][0]).toBe(observation);
  expect(scriptControl.mock.calls[1][0]).toBe(stop);
});

it('stops once and keeps observing the original process until its late tree receipt confirms termination', async () => {
  vi.useFakeTimers();
  try {
    const late = terminal();
    late.executorStopped = false;
    late.process.treeConfirmed = false;
    const stopped = terminal();
    const { client, scriptControl } = sourcePort(late);
    scriptControl.mockResolvedValueOnce(late).mockResolvedValueOnce(late).mockResolvedValueOnce(stopped);
    const { stop: _stop, ...request } = structuredClone(original);
    const settled = vi.fn();
    const result = stopManagedScript(client, request);
    void result.then(settled);

    await vi.advanceTimersByTimeAsync(0);
    expect(scriptControl).toHaveBeenCalledExactlyOnceWith({ ...original, stop: true });
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(scriptControl).toHaveBeenCalledTimes(2);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toBe(stopped);
    expect(scriptControl.mock.calls).toEqual([[{ ...original, stop: true }], [original], [original]]);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
});

it('rejects transport failure while following the original stop without respawning or retrying dispatch', async () => {
  vi.useFakeTimers();
  try {
    const pending = { ...terminal(), executorStopped: false, process: null };
    const { client, scriptControl } = sourcePort(pending);
    const unavailable = new Error('Original source connection lost');
    scriptControl.mockResolvedValueOnce(pending).mockRejectedValueOnce(unavailable);
    const scriptSpawn = vi.fn();
    const { stop: _stop, ...request } = structuredClone(original);
    const result = stopManagedScript({ ...client, scriptSpawn }, request);
    const rejection = expect(result).rejects.toBe(unavailable);

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    await vi.runAllTimersAsync();
    expect(scriptControl.mock.calls).toEqual([[{ ...original, stop: true }], [original]]);
    expect(scriptSpawn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
});

it.each<[string, (receipt: ReturnType<typeof terminal>) => void]>([
  ['source revision', receipt => { receipt.source.revision = 8; }],
  ['source owner', receipt => { receipt.source.resource_owner = { kind: 'managed_host', hostId: 'other-host', connectionId: 'connection-b', endpointIdentity: 'endpoint-b' }; }],
  ['process address', receipt => { receipt.processId = 'another-script'; }],
  ['run', receipt => { receipt.runId = 'another-run'; }],
  ['thread', receipt => { receipt.threadId = 'another-thread'; }],
  ['process snapshot', receipt => { receipt.process.processId = 'another-script'; }],
  ['process workspace', receipt => { receipt.process.workspaceId = 'another-workspace'; }],
  ['process mode', receipt => { receipt.process.mode = 'pty'; }],
  ['unaccepted stop', receipt => { receipt.accepted = false; }],
  ['active writer', receipt => { receipt.process.writerActive = true; }],
  ['unconfirmed tree', receipt => { receipt.process.treeConfirmed = false; }],
])('rejects a receipt with changed %s', async (_reason, change) => {
  const receipt = terminal();
  change(receipt);
  await expect(controlManagedScript(sourcePort(receipt).client, original)).rejects.toThrow('Original managed script process receipt changed');
});

it('rejects stopped claims without a process snapshot', async () => {
  const receipt = { ...terminal(), process: null };
  await expect(controlManagedScript(sourcePort(receipt).client, original)).rejects.toThrow('Original managed script process receipt changed');
});

it.each(['pending', 'terminal', 'unconfirmed'] as const)('routes the private script request through the real receipt guard (%s)', async state => {
  const receipt: ManagedScriptControlReceipt = state === 'pending'
    ? { ...terminal(), executorStopped: false, process: null } : terminal();
  if (state === 'unconfirmed') receipt.process!.writerActive = true;
  const { client, scriptControl } = sourcePort(receipt);
  let receive!: (frame: PrivateManagedSourceFrame) => void;
  const response = new Promise<PrivateManagedSourceFrame>(resolve => { receive = resolve; });
  const failed = vi.fn();
  const bridge = new ManagedSourceBridge(() => 'coordinator-epoch', async frame => { receive(frame); }, failed);
  const owner = vi.fn(async () => client);
  bridge.setOwner(owner, () => original.coordinatorHostId);
  const { coordinatorHostId: _coordinator, ...request } = structuredClone(original);
  try {
    expect(bridge.consume({ v: 1, kind: 'source-resource-request', id: 'private-request', kernelEpoch: 'coordinator-epoch',
      query: { kind: 'script_control', ...request } })).toBe(true);
    expect(await response).toEqual({ v: 1, kind: 'source-resource-response', id: 'private-request', kernelEpoch: 'coordinator-epoch',
      result: state === 'unconfirmed' ? { ok: false, message: 'Original managed script process receipt changed' } : { ok: true, value: receipt } });
    expect(owner).toHaveBeenCalledExactlyOnceWith(original.source.resource_owner);
    expect(scriptControl).toHaveBeenCalledExactlyOnceWith(original);
    expect(failed).not.toHaveBeenCalled();
  } finally { bridge.close(); }
});
