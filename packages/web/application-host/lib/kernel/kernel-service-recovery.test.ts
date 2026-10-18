import { expect, it, vi } from 'vitest';
import type { KernelClient, KernelGrantHandle, KernelGrantIssueInput } from './kernel-client.js';
import { KernelStorageAdapter } from './storage-adapter.js';
import { createKernelComputeService } from './compute-service.js';
import { createKernelProcessService } from './process-service.js';

function hostFixture() {
  let epoch = 'first';
  const exits = new Set<(error: Error) => void>();
  const dispatch = vi.fn(async () => { throw new Error('Reached native process admission'); });
  const host = {
    get kernelEpoch() { return epoch; }, isReady: true,
    subscribeExit: (listener: (error: Error) => void) => { exits.add(listener); return () => { exits.delete(listener); }; },
    issueGrant: vi.fn(async (input: KernelGrantIssueInput) => ({ ...input, kernelEpoch: epoch } as KernelGrantHandle)),
    revokeGrant: vi.fn(async () => {}),
    scoped: vi.fn((grant: KernelGrantHandle) => {
      const check = () => { if (grant.kernelEpoch !== epoch) throw new Error('Old kernel grant'); };
      return {
        fileRootRegister: async () => { check(); return { rootId: 'root' }; },
        recoveryOperationList: async () => { check(); return { operations: [], nextCursor: null }; },
        computeGrammarRegister: async () => { check(); return { recipeId: `recipe:${epoch}` }; },
        computeStart: async (input: { workspaceId: string; jobId: string }) => { check(); return { ...input, kernelEpoch: epoch, root: null, status: 'empty', records: [], nextCursor: 0, endCursor: 0, scannedFiles: 0 }; },
        computeRelease: async () => { check(); },
        processSpawn: dispatch,
      };
    }),
  };
  return { host, client: host as unknown as KernelClient, dispatch,
    restart: () => { for (const exit of exits) exit(new Error('Kernel control connection disconnected')); epoch = 'second'; } };
}

it('renews cached storage grants after failure and after a kernel restart', async () => {
  const f = hostFixture();
  const adapter = new KernelStorageAdapter({ client: f.client, hostId: 'host', storageRoot: process.cwd(), resolveWorkspaceRoot: async () => process.cwd() });
  f.host.issueGrant.mockRejectedValueOnce(new Error('Kernel control connection disconnected'));
  await expect(adapter.recoveryMetadataClient('workspace')).rejects.toThrow('connection disconnected');
  const first = await adapter.recoveryMetadataClient('workspace');
  await adapter.recoveryMetadataClient('workspace');
  expect(f.host.issueGrant).toHaveBeenCalledTimes(2);
  f.restart();
  const second = await adapter.recoveryMetadataClient('workspace');
  expect(second).not.toBe(first);
  await expect(second.recoveryOperationList({ workspaceId: 'workspace' })).resolves.toMatchObject({ operations: [] });
  expect(f.host.issueGrant).toHaveBeenCalledTimes(3);
  await adapter.dispose();
});

it('allows new compute and process work after restart while fencing an old pending launch', async () => {
  const f = hostFixture();
  const identity = { workspaceId: 'workspace', executionWorkspaceId: 'workspace', canonicalRoot: process.cwd() };
  const compute = createKernelComputeService({ client: f.client, resolveIdentity: async () => identity });
  const processes = createKernelProcessService({ client: f.client, resolveIdentity: async () => identity });
  const recipe = { recipeId: '', grammarPath: 'typescript.wasm', grammarName: 'typescript', style: 'code' as const, definitionQuery: '', importQuery: '', literalCallQuery: '' };
  expect(await compute.registerGrammar(recipe)).toBe('recipe:first');
  await expect(compute.directory(process.cwd(), { operation: 'search', lane: 'foreground', query: 'hello' })).resolves.toMatchObject({ status: 'empty' });
  await expect(processes.spawn('fixture', [], { cwd: process.cwd() })).rejects.toThrow('Reached native process admission');
  let release!: () => void; let admitted!: () => void;
  const waiting = new Promise<void>(resolve => { admitted = resolve; });
  const admission = async () => { admitted(); await new Promise<void>(resolve => { release = resolve; }); return identity; };
  const pending = processes.spawnAdmitted(admission, 'fixture', [], { cwd: process.cwd() });
  const rejected = expect(pending).rejects.toThrow('authority changed');
  await waiting;
  f.restart(); release(); await rejected;
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  expect(await compute.registerGrammar(recipe)).toBe('recipe:second');
  await expect(compute.directory(process.cwd(), { operation: 'search', lane: 'foreground', query: 'hello' })).resolves.toMatchObject({ status: 'empty' });
  await expect(processes.spawn('fixture', [], { cwd: process.cwd() })).rejects.toThrow('Reached native process admission');
  expect(f.dispatch).toHaveBeenCalledTimes(2);
  await processes.dispose(); await compute.dispose();
});
