import { Router, type Express } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { routerTransport } from '../extensions/direct-router.test-helper.js';
import { createManagedRemoteTargetRegistry, managedEndpointIdentity } from './managed-remote-client.js';
import { registerManagedRemoteRoutes } from './managed-remote-routes.js';
import { createManagedRemoteExecutionService } from './managed-remote-service.js';
import type { ManagedHostSourceOwner, ManagedSourceService, ManagedSourceReceipt } from './managed-remote-types.js';

const coordinatorHostId = 'coordinator';
const request = { coordinatorHostId, authorityId: 'authority', resourceEpoch: 'target-epoch', operationId: 'operation' };
const receipt: ManagedSourceReceipt = { operationId: request.operationId, resourceEpoch: request.resourceEpoch,
  executionOwner: { kind: 'external', identity: 'source', epoch: 'target-epoch' }, accepted: true, executorStopped: false, result: null };

function fixture(capabilities = ['filesystem:read'], mount = '') {
  const sources = {
    capabilities: vi.fn(async () => ({ tools: [], grantCapabilities: [], clientCapabilities: ['filesystem:read'], unavailable: [] })),
    resolve: vi.fn(async () => ({ workspaceId: 'target-workspace', canonicalRoot: '/target/project', hostId: 'target' })),
    observe: vi.fn(async () => receipt),
    releaseReceipt: vi.fn(async () => ({ operationId: request.operationId, resourceEpoch: request.resourceEpoch,
      executionOwner: receipt.executionOwner, released: true })),
    cancel: vi.fn(async () => receipt),
    execute: vi.fn(async () => receipt),
    service: vi.fn(async () => ({ pathScopes: [''] })),
    cancelService: vi.fn<ManagedSourceService['cancelService']>(async (_principal, input) => ({ requestId: input.requestId, resourceEpoch: input.resourceEpoch, status: 'drained' })),
  } as unknown as ManagedSourceService;
  const service = createManagedRemoteExecutionService({ hostId: 'target', client: {} as never,
    resources: { getMachine: async () => ({ machineId: 'local', kind: 'local', state: 'available' }) } as never,
    sourceOwner: sources });
  const router = Router();
  registerManagedRemoteRoutes(router as unknown as Express, { service,
    resolveAuthContext: async request => request.headers.authorization === 'Bearer trusted'
      ? { type: 'client', clientId: 'verified-principal', client: { id: 'verified-principal', capabilities } } : null });
  const mountedRouter = Router();
  mountedRouter.use(mount || '/', router);
  const transport = routerTransport(mountedRouter);
  const urls: string[] = [];
  const fetch = vi.fn(async (target: string | URL | Request, init: RequestInit = {}) => {
    urls.push(String(target));
    return transport(new URL(String(target)), init);
  });
  let settings = { desktopHosts: [
    { id: 'preferred', label: 'Other route to same Host', apiUrl: 'https://other.invalid', clientToken: 'trusted' },
    { id: 'original', label: 'Original source', apiUrl: `https://original.invalid${mount}`, clientToken: 'trusted' },
  ] };
  const owner: ManagedHostSourceOwner = { kind: 'managed_host', hostId: 'target', connectionId: 'original',
    endpointIdentity: managedEndpointIdentity({ apiUrl: `https://original.invalid${mount}` }) };
  const registry = createManagedRemoteTargetRegistry({ coordinatorHostId, kernel: {} as never, resources: {} as never,
    readSettings: async () => settings, fetch: fetch as typeof globalThis.fetch });
  return { sources, transport, urls, fetch, registry, owner, changeEndpoint(apiUrl = 'https://replacement.invalid') {
    settings = { desktopHosts: settings.desktopHosts.map(entry => entry.id === 'original' ? { ...entry, apiUrl } : entry) };
  } };
}

describe('managed Source authenticated transport without listeners', () => {
  it('keeps the configured mount in Source identity, authenticated discovery and original-owner calls', async () => {
    const f = fixture(['filesystem:read'], '/team/original');
    const discovered = await f.registry.sourceTargets();
    expect(discovered.targets).toEqual([expect.objectContaining({ resourceOwner: f.owner })]);
    const client = await f.registry.source(f.owner);
    expect(await client.resolve({ coordinatorHostId, path: '/target/project' })).toMatchObject({ workspaceId: 'target-workspace' });
    expect(f.urls.filter(url => url.startsWith('https://original.invalid')))
      .toEqual(expect.arrayContaining([
        'https://original.invalid/team/original/api/harness/managed-execution/v1/identity',
        'https://original.invalid/team/original/api/harness/managed-execution/v1/sources/resolve',
      ]));
    expect(f.urls.filter(url => url.startsWith('https://original.invalid'))
      .every(url => url.startsWith('https://original.invalid/team/original/'))).toBe(true);
    f.changeEndpoint('https://original.invalid/team/replacement');
    await client.observe(request);
    const requestsBeforeReacquire = f.urls.length;
    await expect(f.registry.source(f.owner)).rejects.toThrow('original managed source connection');
    expect(f.urls).toHaveLength(requestsBeforeReacquire);
    expect(f.fetch.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
  });

  it('admits read-only discovery and Source reads with the verified principal while preserving the shell gate', async () => {
    const f = fixture();
    const listed = await f.registry.sourceTargets();
    expect(listed.targets).toHaveLength(2);
    expect(listed.targets.every(target => !('clientToken' in target))).toBe(true);
    const client = await f.registry.source(f.owner);
    expect(await client.resolve({ coordinatorHostId, path: '/target/project' })).toMatchObject({ workspaceId: 'target-workspace' });
    expect(f.sources.resolve).toHaveBeenCalledWith({ principalId: 'verified-principal', capabilities: ['filesystem:read'] },
      { coordinatorHostId, path: '/target/project' }, expect.any(AbortSignal));
    const shell = await f.transport(new URL('https://original.invalid/api/harness/managed-execution/v1/shell/exec'), {
      method: 'POST', headers: { Authorization: 'Bearer trusted' }, body: JSON.stringify({ coordinatorHostId, command: 'do not run', toolCallId: 'call' }),
    });
    expect(shell.status).toBe(403);
    const forged = await f.transport(new URL('https://original.invalid/api/harness/managed-execution/v1/sources/observe'), {
      method: 'POST', headers: { Authorization: 'Bearer trusted' }, body: JSON.stringify({ ...request, principalId: 'forged', capabilities: ['process:control'] }),
    });
    expect(forged.status).toBe(200);
    expect(vi.mocked(f.sources.observe).mock.calls[0]![0]).toEqual({ principalId: 'verified-principal', capabilities: ['filesystem:read'] });
  });

  it('pins the original configured endpoint and rejects reacquisition after its configuration changes', async () => {
    const f = fixture();
    const client = await f.registry.source(f.owner);
    f.changeEndpoint();
    await client.observe(request);
    expect(f.urls.every(url => url.startsWith('https://original.invalid/'))).toBe(true);
    await expect(f.registry.source(f.owner)).rejects.toThrow('original managed source connection');
    expect(f.urls.some(url => url.includes('replacement.invalid'))).toBe(false);
    await expect(client.observe({ ...request, coordinatorHostId: 'forged' })).rejects.toThrow('another coordinator');
  });

  it('keeps an accepted executor independent from HTTP cancellation and observes only its original receipt', async () => {
    const f = fixture();
    let entered!: () => void, complete!: () => void;
    const running = new Promise<void>(resolve => { entered = resolve; });
    const drained = new Promise<void>(resolve => { complete = resolve; });
    vi.mocked(f.sources.execute).mockImplementation(async (_principal, _input, signal) => {
      expect(signal).toBeUndefined(); entered(); await drained; return { ...receipt, executorStopped: true };
    });
    const client = await f.registry.source(f.owner);
    const controller = new AbortController();
    const call = { ...request, call: { runId: 'run', operationId: 'operation', origin: { kind: 'model_step' as const, request_id: 'model-request' }, callId: 'call', name: 'file_write', schemaVersion: '1', arguments: {} } };
    const result = client.execute(call, controller.signal);
    await running;
    controller.abort();
    await expect(result).rejects.toBeInstanceOf(DOMException);
    expect(await client.observe(request)).toMatchObject({ accepted: true, executorStopped: false });
    expect(await client.cancel(request)).toMatchObject({ accepted: true, executorStopped: false });
    expect(f.sources.execute).toHaveBeenCalledTimes(1);
    expect(f.sources.cancel).toHaveBeenCalledTimes(1);
    complete();
    await drained;
  });

  it('rejects changed response Host identity instead of claiming an absent or stopped operation', async () => {
    const f = fixture();
    const client = await f.registry.source(f.owner);
    f.fetch.mockImplementationOnce(async () => Response.json({ accepted: false, executorStopped: true },
      { headers: { 'x-varin-managed-host': 'replacement' } }));
    await expect(client.observe(request)).rejects.toThrow('identity changed');
  });

  it('uses explicit service cancellation and preserves a completed receipt if the control request fails', async () => {
    const f = fixture(); let entered!: () => void, finish!: () => void;
    const running = new Promise<void>(resolve => { entered = resolve; });
    const completed = new Promise<void>(resolve => { finish = resolve; });
    vi.mocked(f.sources.service).mockImplementation(async (_principal, _input, signal) => {
      expect(signal).toBeUndefined(); entered(); await completed; return { pathScopes: ['original'] };
    });
    vi.mocked(f.sources.cancelService).mockImplementation(async (_principal, input) => {
      expect(input.requestId).toBe('service-request'); finish(); throw new Error('Control response lost');
    });
    const client = await f.registry.source(f.owner); const controller = new AbortController();
    const work = client.service({ ...request, requestId: 'service-request', operation: { kind: 'validate' } }, controller.signal);
    await running; controller.abort();
    expect(await work).toEqual({ pathScopes: ['original'] });
    expect(f.sources.cancelService).toHaveBeenCalledTimes(1);
    expect(f.fetch.mock.calls.filter(([url]) => String(url).endsWith('/sources/service'))[0]![1]?.signal).toBeUndefined();
  });

  it('does not accept a cancellation reply for another request as drain evidence', async () => {
    const f = fixture();
    vi.mocked(f.sources.cancelService).mockResolvedValue({ requestId: 'different-request', resourceEpoch: request.resourceEpoch, status: 'drained' });
    const client = await f.registry.source(f.owner);
    await expect(client.cancelService({ ...request, requestId: 'original-request' })).rejects.toThrow('cancellation is unconfirmed');
  });

  it('keeps original cancellation and receipt routes available after read access is withdrawn without admitting a new read', async () => {
    const permissions = ['filesystem:read']; const f = fixture(permissions);
    await f.registry.source(f.owner);
    permissions.splice(0);
    // Recovery can reconnect the original authenticated endpoint even after
    // withdrawal; the receipt owner still receives the actual principal.
    const client = await f.registry.source(f.owner);
    expect(await client.observe(request)).toEqual(receipt);
    expect(await client.cancel(request)).toEqual(receipt);
    expect(await client.cancelService({ ...request, requestId: 'original' })).toMatchObject({ status: 'drained' });
    expect(f.sources.cancel).toHaveBeenCalledWith({ principalId: 'verified-principal', capabilities: [] }, request, undefined);
    await expect(client.resolve({ coordinatorHostId, path: '/target/project' })).rejects.toThrow('capability is unavailable');
    await expect(client.service({ ...request, requestId: 'new-read', operation: { kind: 'read', path: 'file.txt' } })).rejects.toThrow('capability is unavailable');
    await expect(client.execute({ ...request, call: {} as never })).rejects.toThrow('capability is unavailable');
    expect(f.sources.resolve).not.toHaveBeenCalled(); expect(f.sources.service).not.toHaveBeenCalled();
    expect(f.sources.execute).not.toHaveBeenCalled();
  });

  it('releases only the addressed read receipt after access withdrawal and rejects mismatched acknowledgements', async () => {
    const f = fixture([]);
    const client = await f.registry.source(f.owner);
    expect(await client.releaseReceipt(request)).toMatchObject({ operationId: request.operationId, released: true });
    expect(f.sources.releaseReceipt).toHaveBeenCalledWith({ principalId: 'verified-principal', capabilities: [] }, request, undefined);
    for (const invalid of [
      { operationId: 'another-operation' }, { resourceEpoch: 'another-epoch' },
      { executionOwner: { kind: 'external', identity: 'source', epoch: 'another-epoch' } }, { released: 'yes' },
    ]) {
      vi.mocked(f.sources.releaseReceipt).mockResolvedValueOnce({ operationId: request.operationId, resourceEpoch: request.resourceEpoch,
        executionOwner: receipt.executionOwner, released: true, ...invalid } as never);
      await expect(client.releaseReceipt(request)).rejects.toThrow('receipt release is unconfirmed');
    }
  });
});
