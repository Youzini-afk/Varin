import { expect, it, vi } from 'vitest';
import type { ManagedSourceLocalScope } from '../harness/managed-remote-types.js';
import type { KernelClient } from './kernel-client.js';
import { KernelClientError, KernelRequestError } from './kernel-error.js';
import { createManagedMcpProcesses } from './managed-mcp-processes.js';
import { StdioTransport } from '../mcp/authority.js';

// Controlled transport construction and Kernel ports. Framing and real native receipts
// have separate owners; this fixture checks the Host's original request/receipt join.
vi.mock('../mcp/authority.js', () => ({
  StdioTransport: class { constructor(readonly options: object) {} },
  StreamableHttpTransport: class {},
}));
vi.mock('./mcp-process-transport.js', () => ({
  createMcpProcessTransport: (options: object, spawn: (options: object, signal: AbortSignal) => Promise<unknown>) =>
    ({ start: () => spawn(options, new AbortController().signal) }),
}));

function fixture(error: Error, present = false) {
  let processId = '';
  const root = process.cwd();
  const scope = { authorityId: 'original-authority', resourceEpoch: 'original-epoch', coordinatorHostId: 'host-a',
    principal: { principalId: 'caller-a', capabilities: [] }, grant: {},
    physicalRoot: { hostId: 'host-b', rootId: 'root-b', canonicalRoot: root },
    source: { workspace_id: 'workspace-b', resource_owner: { kind: 'managed_host', hostId: 'host-b' } },
  } as unknown as ManagedSourceLocalScope;
  const receipt = { operationId: '', resourceEpoch: scope.resourceEpoch, accepted: present, executorStopped: present,
    process: present ? { processId: '', workspaceId: 'workspace-b', kernelEpoch: scope.resourceEpoch,
      mode: 'pipe', writerActive: false, treeConfirmed: true } : null };
  const sourceRequest = vi.fn(async (_method: string, address: { operationId: string }) => {
    expect(address).toEqual({ principalId: 'caller-a', coordinatorHostId: 'host-a', authorityId: 'original-authority',
      resourceEpoch: 'original-epoch', operationId: processId });
    return { ...receipt, operationId: processId, process: receipt.process && { ...receipt.process, processId } };
  });
  const processSpawn = vi.fn(async (input: { processId: string }) => { processId = input.processId; throw error; });
  const owner = createManagedMcpProcesses({ scope, readmit: async () => {}, onError: () => {},
    kernel: { scoped: () => ({ processSpawn }), sourceRequest, subscribeExit: () => () => {} } as unknown as KernelClient });
  const transport = owner.adapt(new StdioTransport({ command: 'original-mcp' }));
  return { owner, transport, sourceRequest, processSpawn, receipt };
}

it('settles an explicit original spawn error only after joining its absent original receipt', async () => {
  const f = fixture(new KernelRequestError({ code: 'operation-error', message: 'command contains NUL' }, 'process.spawn', 'response'));
  await expect(f.transport.start()).rejects.toThrow('command contains NUL');
  await f.owner.drain(); expect(f.owner.executorsStopped()).toBe(true);
  expect(f.sourceRequest).toHaveBeenCalledTimes(1);
  await f.owner.drain(); expect(f.sourceRequest).toHaveBeenCalledTimes(1);
});

it('does not mistake a transport error or same-code unclassified failure for a native rejection', async () => {
  const f = fixture(new KernelClientError({ code: 'operation-error', message: 'response lost' }));
  await expect(f.transport.start()).rejects.toThrow('response lost');
  await expect(f.owner.drain()).rejects.toThrow('acceptance_unconfirmed');
  expect(f.owner.executorsStopped()).toBe(false);
  // A later original process receipt converges the retained identity without another spawn.
  Object.assign(f.receipt, { accepted: true, executorStopped: true, process: { processId: '', workspaceId: 'workspace-b',
    kernelEpoch: 'original-epoch', mode: 'pipe', writerActive: false, treeConfirmed: true } });
  await f.owner.drain(); expect(f.owner.executorsStopped()).toBe(true);
  expect(f.processSpawn).toHaveBeenCalledTimes(1);
});

it('honors a persisted failed-launch tree receipt and a distinct not-dispatched refusal', async () => {
  const replied = fixture(new KernelRequestError({ code: 'storage-error', message: 'guardian unavailable' }, 'process.spawn', 'response'), true);
  await expect(replied.transport.start()).rejects.toThrow('guardian unavailable');
  await replied.owner.drain(); expect(replied.owner.executorsStopped()).toBe(true);
  const refused = fixture(new KernelRequestError({ code: 'forbidden', message: 'inactive grant' }, 'process.spawn', 'not_dispatched'));
  await expect(refused.transport.start()).rejects.toThrow('inactive grant');
  await refused.owner.drain(); expect(refused.sourceRequest).not.toHaveBeenCalled();
});
