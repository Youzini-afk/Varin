import { describe, expect, it, vi } from 'vitest';
import type { ThreadPrepareSource, ThreadSource } from '@varin/application-client';
import type { KernelClient, KernelGrantHandle, KernelGrantIssueInput } from '../kernel/kernel-client.js';
import type { LaunchSource, SourceAuthorityOpenParams, SourceAuthorityBindParams, SourceAuthorityResult, SourceHandoffClaimParams } from '../kernel/protocol.generated.js';
import { createManagedSourceService } from './managed-source-service.js';
import { ManagedSourceDrainedError } from './managed-source-drain.js';
import { createSourceQueryService } from '../kernel/source-query-service.js';
import type { ManagedSourceBindRequest, ManagedSourcePrincipal, ManagedSourceServiceHandler, ManagedSourceCleanupScope } from './managed-remote-types.js';

const principal: ManagedSourcePrincipal = { principalId: 'verified', capabilities: ['filesystem:read'] };
const source: ThreadSource = { resourceOwner: { kind: 'managed_host', hostId: 'target', connectionId: 'connection', endpointIdentity: 'endpoint' },
  workspaceId: 'workspace', executionWorkspaceId: 'workspace', branchId: 'branch', revision: 0, mode: 'fixed_branch', tools: [] };
const request: ManagedSourceBindRequest = { coordinatorHostId: 'coordinator', scope: { kind: 'source_read', threadId: 'thread', branchId: 'history', key: 'context' },
  source, purpose: 'read', retention: 'caller' };

function fixture() {
  const state = { trusted: true, authority: null as SourceAuthorityResult | null };
  const events: string[] = [];
  const grants = new Map<string, KernelGrantHandle>();
  const readBranch = vi.fn(async () => ({ workspaceId: 'workspace', branchId: 'branch', view: 'revision', revision: 0, root: 'fixed-root' }));
  const fileMaterialize = vi.fn(), fileRootRegister = vi.fn();
  const issueGrant = vi.fn(async (input: KernelGrantIssueInput) => {
    events.push('grant');
    const grant = { ...input, kernelEpoch: 'target-epoch' } as KernelGrantHandle;
    grants.set(input.grantId, grant); return grant;
  });
  const claimManagedChildSource = vi.fn(async (input: SourceHandoffClaimParams) => {
    events.push('claim-handoff');
    const grant = { grantId: input.grantId, threadId: input.scope.threadId, kernelEpoch: 'target-epoch' } as KernelGrantHandle;
    grants.set(input.grantId, grant); return grant;
  });
  const sourceRequest = vi.fn(async (method: string, input: unknown): Promise<unknown> => {
    events.push(method);
    if (method === 'source.capabilities') return { tools: [], grantCapabilities: ['storage.read'], clientCapabilities: ['filesystem:read'], unavailable: [] };
    if (method === 'source.authority.open') {
      const params = input as SourceAuthorityOpenParams;
      state.authority = { authorityId: 'authority', resourceEpoch: 'target-epoch', executionOwner: { kind: 'external', identity: 'source', epoch: 'target-epoch' },
        source: params.source, scope: params.scope, phase: 'preparing', purpose: params.purpose, operationId: params.operationId ?? null, grantId: params.grantId,
        toolBinding: null, physicalRoot: null, firstPreparation: true, materializationOperationId: 'materialize', mcpHolders: [], mcpDeliveries: [], mcpChildren: [], mcpDerivation: null };
      return state.authority;
    }
    if (method === 'source.authority.bind') {
      const params = input as SourceAuthorityBindParams;
      state.authority = { ...state.authority!, phase: 'ready', toolBinding: params.toolBinding, physicalRoot: params.physicalRoot };
      return state.authority;
    }
    if (method === 'source.authority.inspect') return state.authority;
    if (method === 'source.authority.seal') { state.authority = { ...state.authority!, phase: (state.authority!.mcpHolders.some(holder => !holder.released) || state.authority!.mcpDeliveries.some(delivery => !delivery.released) || state.authority!.mcpChildren.some(child => !child.released)) ? 'retaining' : 'draining' }; return state.authority; }
    if (method === 'source.authority.inspect_scope') return [state.authority];
    if (method === 'source.service.call') return { pathScopes: ['allowed'] };
    if (method === 'source.authority.release') return { authorityId: 'authority', phase: 'retired', grantIds: ['private-grant'] };
    if (method === 'source.authority.release_scope') return { released: [{ authorityId: 'authority', phase: 'retired', grantIds: ['private-grant'] }], pendingAuthorities: [] };
    throw new Error(`Unexpected native method ${method}`);
  });
  const kernel = { kernelEpoch: 'target-epoch', isReady: true, subscribeExit: () => () => {},
    assertGrantForScope: (grant: KernelGrantHandle) => grant,
    start: async () => ({ hostId: 'target' }), issueGrant, claimManagedChildSource, sourceRequest,
    sourceAuthorityGrant: (authority: SourceAuthorityResult) => {
      const grant = grants.get(authority.grantId); if (!grant) throw new Error('Original permit missing'); return grant;
    }, scoped: () => ({ readBranch, fileMaterialize, fileRootRegister, getOperation: async () => null, workingResultGet: async () => null }), retireGrant: vi.fn(async () => ({})),
  } as unknown as KernelClient;
  const prepareSource = vi.fn(async (input: ThreadPrepareSource) => ({ path: '/target/project', source: { ...source, resourceOwner: input.resourceOwner } }));
  const serviceOperation = vi.fn<ManagedSourceServiceHandler>(async () => { state.trusted = false; return { committed: true }; });
  const releaseSource = vi.fn<(scope: ManagedSourceCleanupScope) => Promise<void | { mcpExecutorStopped: boolean }>>(async () => { events.push('drain-views'); });
  const mcpInteractionContinuation = vi.fn(async () => ({ ok: true as const, value: null, executorStopped: true as const }));
  const releaseMcpView = vi.fn(async () => ({ ok: true as const, value: null, executorStopped: true as const }));
  const recovery = vi.fn(async () => ({ status: 'failed' as const,
    failure: { code: 'operation-not-found' as const, message: 'Original journal is unavailable', retryable: false } }));
  const readCodeExchange = vi.fn(async () => ({ operationId: 'exchange', sourceThreadId: 'sender', targetThreadId: 'target', state: 'applied', files: [] }));
  const validateLiveSource = vi.fn(async () => {});
  const service = createManagedSourceService({ kernel, hostId: 'target', releaseMcpView, mcpInteractionContinuation, documents: {
    admitWorkspaceRegistration: async () => {
      events.push('registration'); if (!state.trusted) throw new Error('Trust withdrawn');
      return { workspaceId: 'workspace', canonicalPath: '/target/project', hostId: 'target' };
    },
  } as never, validateLiveSource, prepareSource, serviceOperation, releaseSource, recovery, readCodeExchange });
  return { service, kernel, state, events, validateLiveSource, sourceRequest, issueGrant, claimManagedChildSource, readBranch, fileMaterialize, fileRootRegister, prepareSource, serviceOperation, releaseSource, releaseMcpView, mcpInteractionContinuation, recovery, readCodeExchange };
}

async function bindMcp(f: ReturnType<typeof fixture>) {
  const root = { hostId: 'target', rootId: 'mcp-root', canonicalRoot: '/target/project' };
  f.fileRootRegister.mockResolvedValue(root);
  return f.service.bind({ ...principal, capabilities: [...principal.capabilities, 'terminal:use', 'process:control'] },
    { ...request, purpose: 'mcp_owner', retention: 'run', scope: { kind: 'run', threadId: 'thread', runId: 'run', epoch: 1 },
      source: { resourceOwner: source.resourceOwner, workspaceId: source.workspaceId, executionWorkspaceId: source.executionWorkspaceId, mode: 'live_root', tools: [], liveRoot: root } });
}

describe('managed Source target admission orchestration', () => {
  it('reads a completed file exchange through its original receipt with read permission and no new source grant', async () => {
    const f = fixture();
    const originalSource: LaunchSource = { resource_owner: source.resourceOwner, workspace_id: 'workspace', execution_workspace_id: 'workspace',
      mode: 'fixed_branch', branch_id: 'branch', revision: 0, live_root: null };
    const receipt = { coordinatorHostId: 'coordinator', source: originalSource, threadId: 'sender', runId: 'finished-run', operationId: 'exchange' };
    const input = { ...receipt, path: 'search.ts' };
    f.sourceRequest.mockResolvedValueOnce({ state: 'applied' });
    expect(await f.service.codeExchange(principal, input)).toMatchObject({ operationId: 'exchange' });
    expect(f.sourceRequest).toHaveBeenCalledWith('source.integration.receipt', { ...receipt, principalId: principal.principalId }, undefined);
    expect(f.readCodeExchange).toHaveBeenCalledWith(input, undefined);
    expect(f.issueGrant).not.toHaveBeenCalled();
    expect(f.prepareSource).not.toHaveBeenCalled();
    expect(f.serviceOperation).not.toHaveBeenCalled();
    f.readCodeExchange.mockClear();
    await expect(f.service.codeExchange({ ...principal, capabilities: [] }, input)).rejects.toThrow();
    f.sourceRequest.mockRejectedValueOnce(new Error('No matching original source authority'));
    await expect(f.service.codeExchange(principal, { ...input, operationId: 'another' })).rejects.toThrow('original source authority');
    expect(f.readCodeExchange).not.toHaveBeenCalled();
  });

  it('routes a newly authorized Recovery to its original owner without reopening an execution Source', async () => {
    const f = fixture();
    const input = { coordinatorHostId: 'coordinator', binding: { operationId: 'original-recovery', workspaceId: 'workspace',
      conversation: { kind: 'thread' as const, threadId: 'thread', branchId: 'history' }, turns: [] }, action: { kind: 'read' as const } };
    await expect(f.service.recovery(principal, input)).rejects.toThrow();
    expect(f.recovery).not.toHaveBeenCalled();
    const writer = { ...principal, capabilities: ['filesystem:read', 'filesystem:write'] };
    expect(await f.service.recovery(writer, input)).toMatchObject({ status: 'failed', failure: { code: 'operation-not-found' } });
    expect(f.recovery).toHaveBeenCalledWith(writer, input, undefined);
    expect(f.sourceRequest).not.toHaveBeenCalled();
    expect(f.issueGrant).not.toHaveBeenCalled();
    expect(f.serviceOperation).not.toHaveBeenCalled();
  });

  it('namespaces preparation by the verified principal and coordinator while using the original local preparer', async () => {
    const f = fixture();
    const input: ThreadPrepareSource = { runtime: 'agent', threadId: 'thread', branchId: 'history', key: 'same-key',
      resourceOwner: source.resourceOwner, workspaceId: 'workspace', mode: 'fixed_branch', content: { mode: 'saved-files' }, captureScopes: [] };
    const prepared = await f.service.prepare(principal, { coordinatorHostId: 'coordinator', input });
    await f.service.prepare({ ...principal, principalId: 'other' }, { coordinatorHostId: 'coordinator', input });
    expect(f.prepareSource.mock.calls[0]![0]).toMatchObject({ resourceOwner: { kind: 'local' }, threadId: 'thread', workspaceId: 'workspace' });
    expect(f.prepareSource.mock.calls[0]![0].key).not.toBe(f.prepareSource.mock.calls[1]![0].key);
    expect(prepared.source.resourceOwner).toEqual(source.resourceOwner);
    expect(f.issueGrant).not.toHaveBeenCalled();
  });

  it('reads a materialized selection baseline before a Run without inventing an Operation or creating a directory', async () => {
    const f = fixture();
    const result = await f.service.bind(principal, { ...request, source: { ...source, mode: 'materialized' } });
    expect(result.source.mode).toBe('materialized'); expect(result.physicalRoot).toBeNull();
    const grant = f.issueGrant.mock.calls[0]![0];
    expect(grant.runId).toBeUndefined(); expect(grant.operationId).toBeUndefined();
    expect(f.readBranch).toHaveBeenCalledWith({ branchId: 'branch', revision: 0, includeEntries: false }, undefined);
    expect(f.fileMaterialize).not.toHaveBeenCalled(); expect(f.fileRootRegister).not.toHaveBeenCalled();
    expect(f.events.indexOf('source.authority.open')).toBeLessThan(f.events.indexOf('source.authority.bind'));
    expect(result).not.toHaveProperty('grantId');
  });

  it('retains an original domain receipt when trust changes after the effect completes', async () => {
    const f = fixture(); const binding = await f.service.bind(principal, request);
    const result = await f.service.service(principal, { coordinatorHostId: 'coordinator', authorityId: binding.authorityId,
      resourceEpoch: binding.resourceEpoch, requestId: 'publication', operation: { kind: 'child_result_publish', execution: {} as never } });
    expect(result).toEqual({ committed: true });
    expect(f.serviceOperation).toHaveBeenCalledTimes(1);
    await expect(f.service.authorize(principal, { coordinatorHostId: 'coordinator', authorityId: binding.authorityId,
      resourceEpoch: binding.resourceEpoch, call: {} as never })).rejects.toThrow('Trust withdrawn');
    expect(f.sourceRequest.mock.calls.some(([method]) => method === 'source.resource.authorize')).toBe(false);
  });

  it('uses the original restricted handoff claim for a child physical capture without creating a Run environment', async () => {
    const f = fixture();
    const root = { hostId: 'target', rootId: 'original-root', canonicalRoot: '/target/original-environment' };
    const result = await f.service.bind(principal, { ...request, source: { ...source, mode: 'materialized' },
      handoff: { operation_id: 'child-source-handoff:dispatch',
        source: { resource_owner: source.resourceOwner, workspace_id: 'workspace', execution_workspace_id: 'workspace',
          mode: 'materialized', branch_id: 'branch', revision: 0, live_root: null },
        root: { kind: 'physical', root }, resource_authority: { authority_id: 'parent-authority', resource_epoch: 'target-epoch' } } });
    expect(f.claimManagedChildSource).toHaveBeenCalledWith(expect.objectContaining({ principalId: principal.principalId,
      coordinatorHostId: 'coordinator', scope: request.scope }), undefined);
    expect(f.issueGrant).not.toHaveBeenCalled(); expect(f.fileMaterialize).not.toHaveBeenCalled();
    expect(f.readBranch).not.toHaveBeenCalled();
    expect(result.physicalRoot).toEqual(root);
    expect(f.state.authority?.toolBinding).toBeNull();
  });

  it('binds frozen result metadata without reopening or recreating the original materialized directory', async () => {
    const f = fixture();
    const result = await f.service.bind(principal, { ...request, source: { ...source, mode: 'materialized' },
      scope: { kind: 'run', threadId: 'thread', runId: 'original-child-run', epoch: 2 }, purpose: 'result', retention: 'run' });
    expect(result.physicalRoot).toBeNull();
    expect(f.fileMaterialize).not.toHaveBeenCalled(); expect(f.fileRootRegister).not.toHaveBeenCalled();
    expect(f.state.authority?.toolBinding).toMatchObject({ runId: 'original-child-run', sourceMode: 'materialized', enabledTools: [],
      materializedSource: { branchId: 'branch', revision: 0 } });
    expect(f.state.authority?.toolBinding).not.toHaveProperty('rootId');
  });

  it('drains the original language references before native release without reopening withdrawn source content', async () => {
    const f = fixture(); const binding = await f.service.bind(principal, request); f.state.trusted = false;
    const before = f.events.length;
    const receipt = await f.service.release(principal, { coordinatorHostId: 'coordinator', authorityId: binding.authorityId,
      resourceEpoch: binding.resourceEpoch, mode: 'retire' });
    expect(f.events.slice(before)).toEqual(['source.authority.inspect', 'drain-views', 'source.authority.release']);
    expect(f.releaseSource).toHaveBeenCalledWith(expect.objectContaining({ authorityId: binding.authorityId, scope: expect.objectContaining({ threadId: 'thread' }) }), { retainMcpHolders: false });
    expect(receipt).toEqual({ authorityId: binding.authorityId, phase: 'retired' });
  });

  it('joins the actual cancelled service promise before acknowledging drain', async () => {
    const f = fixture(); const binding = await f.service.bind(principal, request);
    let entered!: () => void, leave!: () => void;
    const running = new Promise<void>(resolve => { entered = resolve; });
    const stopped = new Promise<void>(resolve => { leave = resolve; });
    let active!: AbortSignal;
    f.serviceOperation.mockImplementation(async (_scope, _operation, signal) => {
      active = signal!; entered();
      await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
      await stopped;
      throw new ManagedSourceDrainedError(signal!.reason);
    });
    const address = { coordinatorHostId: 'coordinator', authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch, requestId: 'read-1' };
    const work = f.service.service(principal, { ...address, operation: { kind: 'read', path: 'source.ts' } }).catch(error => error);
    await running;
    let acknowledged = false;
    const cancellation = f.service.cancelService(principal, address).then(result => { acknowledged = true; return result; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(active.aborted).toBe(true); expect(acknowledged).toBe(false);
    leave();
    expect(await cancellation).toMatchObject({ status: 'drained' });
    expect(await work).toBeInstanceOf(ManagedSourceDrainedError);
  });

  it.each([
    [{ executor_stopped: true }, 'drained'],
    [{ executor_stopped: false }, 'unknown'],
    [{ executorStopped: true }, 'unknown'],
    [null, 'unknown'],
  ] as const)('keeps the original schedule receipt stop evidence when observing service drainage (%j)', async (receipt, status) => {
    const f = fixture(); const binding = await f.service.bind(principal, request);
    f.serviceOperation.mockResolvedValue(receipt);
    const address = { coordinatorHostId: 'coordinator', authorityId: binding.authorityId,
      resourceEpoch: binding.resourceEpoch, requestId: 'schedule-control' };
    await f.service.service(principal, { ...address, operation: { kind: 'schedule', invocation: {} as never } });
    expect(await f.service.cancelService(principal, address)).toMatchObject({ status });
  });

  it('retains caller-owned Host references during Run retirement and drains them on explicit revocation', async () => {
    const f = fixture(); await f.service.bind(principal, request);
    f.state.authority = { ...f.state.authority!, operationId: 'original-caller-operation' };
    await f.service.releaseScope(principal, { coordinatorHostId: 'coordinator', threadId: 'thread', runId: 'run', mode: 'retire' });
    expect(f.releaseSource).not.toHaveBeenCalled();
    await f.service.releaseScope(principal, { coordinatorHostId: 'coordinator', threadId: 'thread', runId: 'run', mode: 'revoke' });
    expect(f.releaseSource).toHaveBeenCalledTimes(1);
  });

  it('records failed admission as not started and still releases the original source references', async () => {
    const f = fixture(); const binding = await f.service.bind(principal, request); f.state.trusted = false;
    const address = { coordinatorHostId: 'coordinator', authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch, requestId: 'denied-read' };
    await expect(f.service.service(principal, { ...address, operation: { kind: 'read', path: 'source.ts' } })).rejects.toThrow('Trust withdrawn');
    expect(f.serviceOperation).not.toHaveBeenCalled();
    expect(await f.service.cancelService(principal, address)).toMatchObject({ status: 'not_started' });
    await f.service.release(principal, { ...address, mode: 'retire' });
    expect(f.releaseSource).toHaveBeenCalledTimes(1);
    expect(f.sourceRequest.mock.calls.some(([method]) => method === 'source.authority.release')).toBe(true);
  });

  it('keeps a completed query failure while allowing its original service owner and grant to retire', async () => {
    const f = fixture(); const binding = await f.service.bind(principal, request);
    f.serviceOperation.mockRejectedValue(new ManagedSourceDrainedError(new Error('Original read path is missing')));
    const address = { coordinatorHostId: 'coordinator', authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch, requestId: 'missing-read' };
    await expect(f.service.service(principal, { ...address, operation: { kind: 'check_path', path: 'missing/source.ts' } })).rejects.toThrow('Original read path is missing');
    expect(await f.service.cancelService(principal, address)).toMatchObject({ status: 'drained' });
    await f.service.release(principal, { ...address, mode: 'retire' });
    expect(f.releaseSource).toHaveBeenCalledTimes(1);
    expect(f.events.indexOf('drain-views')).toBeLessThan(f.events.indexOf('source.authority.release'));
  });

  it('gets stopped metadata failure evidence from the actual target query owner', async () => {
    const f = fixture(); const binding = await f.service.bind(principal, request);
    const queries = createSourceQueryService({ kernel: f.kernel, documents: {} as never,
      validateLiveSource: async () => {}, storage: {} as never,
      resourceOwners: { dataDirectory: '/unused-query-assets', homeDir: '/unused-query-home' } as never });
    f.serviceOperation.mockImplementation(queries);
    f.releaseSource.mockImplementation(async scope => { f.events.push('drain-views'); await queries.release(scope); });
    f.readBranch.mockRejectedValue(new Error('Original fixed path is unavailable'));
    const address = { coordinatorHostId: 'coordinator', authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch, requestId: 'actual-query-failure' };
    await expect(f.service.service(principal, { ...address, operation: { kind: 'check_path', path: 'missing.ts' } })).rejects.toBeInstanceOf(ManagedSourceDrainedError);
    expect(await f.service.cancelService(principal, address)).toMatchObject({ status: 'drained' });
    await f.service.release(principal, { ...address, mode: 'retire' });
    expect(f.releaseSource).toHaveBeenCalledTimes(1);
    await queries.dispose();
  });

  it('does not acknowledge metadata cancellation before the original non-abandoned reader completes', async () => {
    const f = fixture(); const binding = await f.service.bind(principal, request);
    const queries = createSourceQueryService({ kernel: f.kernel, documents: {} as never,
      validateLiveSource: async () => {}, storage: {} as never,
      resourceOwners: { dataDirectory: '/unused-query-assets', homeDir: '/unused-query-home' } as never });
    f.serviceOperation.mockImplementation(queries);
    let entered!: () => void, finish!: () => void, nativeSignal!: AbortSignal;
    const active = new Promise<void>(resolve => { entered = resolve; });
    const stopped = new Promise<void>(resolve => { finish = resolve; });
    f.readBranch.mockImplementation(async (...args: unknown[]) => {
      nativeSignal = args[1] as AbortSignal; entered(); await stopped;
      return { workspaceId: 'workspace', branchId: 'branch', view: 'revision', revision: 0, root: 'fixed-root' };
    });
    const address = { coordinatorHostId: 'coordinator', authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch, requestId: 'cancelled-metadata' };
    const work = f.service.service(principal, { ...address, operation: { kind: 'check_path', path: 'source.ts' } }).catch(error => error);
    await active;
    let acknowledged = false;
    const cancel = f.service.cancelService(principal, address).then(value => { acknowledged = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(acknowledged).toBe(false); expect(nativeSignal.aborted).toBe(false);
    finish();
    expect(await work).toBeInstanceOf(ManagedSourceDrainedError);
    expect(await cancel).toMatchObject({ status: 'drained' });
    await queries.dispose();
  });

  it('joins language admission before releasing its views while unrelated source reads continue', async () => {
    const f = fixture();
    const binding = await f.service.bind(principal, { ...request, purpose: 'source', retention: 'run',
      scope: { kind: 'run', threadId: 'thread', runId: 'run', epoch: 1 } });
    let entered!: () => void, finish!: () => void, first = true;
    const atAdmission = new Promise<void>(resolve => { entered = resolve; });
    const admitted = new Promise<void>(resolve => { finish = resolve; });
    const supervisor = { retainSourceView: vi.fn(), releaseSourceViews: vi.fn(async () => {}) };
    const queries = createSourceQueryService({ kernel: f.kernel, documents: {
      async admitWorkspaceRegistration() {
        if (first) { first = false; entered(); await admitted; }
        return { workspaceId: 'workspace', canonicalPath: '/target/project', hostId: 'target' };
      },
    } as never, validateLiveSource: async () => {}, storage: {} as never, languageSupervisor: supervisor as never,
    resourceOwners: { dataDirectory: '/unused-query-assets', homeDir: '/unused-query-home' } as never });
    f.serviceOperation.mockImplementation(queries);
    const address = { coordinatorHostId: 'coordinator', authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch };
    const language = f.service.service(principal, { ...address, requestId: 'language-preparing',
      operation: { kind: 'language', query: { method: 'hover', path: 'source.ts', line: 0, character: 0 } } }).catch(error => error);
    await atAdmission;
    let released = false;
    const release = f.service.service(principal, { ...address, requestId: 'language-release', operation: { kind: 'language_release' } })
      .then(value => { released = true; return value; });
    await f.service.service(principal, { ...address, requestId: 'unrelated-read', operation: { kind: 'check_path', path: 'other.ts' } });
    expect(released).toBe(false); expect(supervisor.releaseSourceViews).not.toHaveBeenCalled();
    expect(supervisor.retainSourceView).not.toHaveBeenCalled();
    finish();
    expect(await language).toMatchObject({ name: 'AbortError' }); await release;
    expect(supervisor.releaseSourceViews).toHaveBeenCalledWith({ runId: 'run', grantId: f.state.authority!.grantId });
    await queries.dispose();
  });

  for (const releaseFails of [false, true]) it(`keeps original compute cancellation ${releaseFails ? 'unknown when release fails' : 'pending until terminal and release'}`, async () => {
    const f = fixture(); const binding = await f.service.bind(principal, request);
    const queries = createSourceQueryService({ kernel: f.kernel, documents: {} as never,
      validateLiveSource: async () => {}, storage: {} as never,
      resourceOwners: { dataDirectory: '/unused-query-assets', homeDir: '/unused-query-home' } as never });
    f.serviceOperation.mockImplementation(queries);
    let started!: () => void, releasing!: () => void, finishRelease!: () => void, jobId = '', cancelled = false;
    const active = new Promise<void>(resolve => { started = resolve; });
    const atRelease = new Promise<void>(resolve => { releasing = resolve; });
    const released = new Promise<void>(resolve => { finishRelease = resolve; });
    const page = () => ({ jobId, workspaceId: 'workspace', kernelEpoch: 'target-epoch', root: 'fixed-root',
      status: cancelled ? 'cancelled' : 'running', records: [], nextCursor: 0, endCursor: 0, scannedFiles: 0 });
    const computeRelease = vi.fn(async () => { releasing(); await released; if (releaseFails) throw new Error('Original compute release failed'); return {}; });
    Object.defineProperty(f.kernel, 'scoped', { value: () => ({ readBranch: f.readBranch, getOperation: async () => null,
      computeStart: async (input: { jobId: string }) => { jobId = input.jobId; started(); return page(); },
      computeRead: async () => page(), computeCancel: async () => { cancelled = true; return {}; }, computeRelease }) });
    const address = { coordinatorHostId: 'coordinator', authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch, requestId: 'compute-cancel' };
    const work = f.service.service(principal, { ...address, operation: { kind: 'compute', input: { jobId: 'transport-only',
      operation: 'bytes', lane: 'foreground', paths: ['source.ts'] } } }).catch(error => error);
    await active;
    let acknowledged = false;
    const cancel = f.service.cancelService(principal, address).then(value => { acknowledged = true; return value; });
    await atRelease;
    expect(cancelled).toBe(true); expect(acknowledged).toBe(false);
    finishRelease();
    const failure = await work;
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof ManagedSourceDrainedError).toBe(!releaseFails);
    expect(await cancel).toMatchObject({ status: releaseFails ? 'unknown' : 'drained' });
    expect(computeRelease).toHaveBeenCalledTimes(1);
    await queries.dispose();
  });

  it('joins one active transport attempt and retains only settlement after its response is delivered', async () => {
    const f = fixture(); const binding = await f.service.bind(principal, request);
    let finish!: () => void, entered!: () => void;
    const running = new Promise<void>(resolve => { entered = resolve; });
    const completed = new Promise<void>(resolve => { finish = resolve; });
    const result = { content: 'original bytes' };
    f.serviceOperation.mockImplementation(async () => { entered(); await completed; return result; });
    const input = { coordinatorHostId: 'coordinator', authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch,
      requestId: 'read-attempt', operation: { kind: 'read' as const, path: 'source.ts' } };
    const first = f.service.service(principal, input); await running;
    const second = f.service.service(principal, input); finish();
    expect(await first).toBe(result); expect(await second).toBe(result);
    expect(f.serviceOperation).toHaveBeenCalledTimes(1);
    expect(await f.service.cancelService(principal, input)).toMatchObject({ status: 'drained' });
    await expect(f.service.service(principal, input)).rejects.toThrow('observe its original domain receipt');
    expect(f.serviceOperation).toHaveBeenCalledTimes(1);
  });

  it('retains cancel-before-dispatch and never turns an unknown domain receipt into stopped work', async () => {
    const f = fixture(); const binding = await f.service.bind(principal, request);
    const address = { coordinatorHostId: 'coordinator', authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch, requestId: 'before' };
    expect(await f.service.cancelService(principal, address)).toMatchObject({ status: 'not_started' });
    await expect(f.service.service(principal, { ...address, operation: { kind: 'read', path: 'source.ts' } })).rejects.toBeInstanceOf(DOMException);
    expect(f.serviceOperation).not.toHaveBeenCalled();
    f.serviceOperation.mockResolvedValue({ effect: 'unknown', executorStopped: false });
    await f.service.service(principal, { ...address, requestId: 'unknown', operation: { kind: 'child_result_publish', execution: {} as never } });
    expect(await f.service.cancelService(principal, { ...address, requestId: 'unknown' })).toMatchObject({ status: 'unknown' });
    await expect(f.service.release(principal, { ...address, mode: 'retire' })).rejects.toThrow('termination is unconfirmed');
    expect(f.sourceRequest.mock.calls.some(([method]) => method === 'source.authority.release')).toBe(false);
  });
  it('fences the original MCP creation before exact release, including release before admission', async () => {
    const f = fixture(), binding = await bindMcp(f);
    const address = { coordinatorHostId: 'coordinator', authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch };
    const snapshot = { ...address, requestId: 'creation', operation: { kind: 'mcp' as const,
      action: { kind: 'snapshot' as const, handleId: 'view', creationRequestId: 'creation' } } };
    const release = { ...address, requestId: 'cleanup', operation: { kind: 'mcp' as const,
      action: { kind: 'release' as const, handleId: 'view', creationRequestId: 'creation' } } };
    f.serviceOperation.mockResolvedValue({ ok: true, value: null, executorStopped: true });
    // No current read/trust grant is required to close the old handle.
    f.state.trusted = false;
    f.kernel.sourceAuthorityGrant = () => { throw new Error('Original grant inactive'); };
    await f.service.service({ ...principal, capabilities: [] }, release);
    await expect(f.service.service(principal, snapshot)).rejects.toBeInstanceOf(DOMException);
    expect(f.serviceOperation).not.toHaveBeenCalled();
    expect(f.releaseMcpView).toHaveBeenCalledTimes(1);

    const g = fixture(), opened = await bindMcp(g);
    let entered!: () => void, drain!: () => void;
    const active = new Promise<void>(resolve => { entered = resolve; });
    const stopped = new Promise<void>(resolve => { drain = resolve; });
    const effects: string[] = [];
    g.serviceOperation.mockImplementation(async (_scope, operation, signal) => {
      if (operation.kind !== 'mcp') throw new Error('expected MCP');
      if (operation.action.kind === 'snapshot') {
        entered(); await stopped; expect(signal?.aborted).toBe(true); effects.push('creation drained');
      } else effects.push('released');
      return { ok: true, value: null, executorStopped: true };
    });
    g.releaseMcpView.mockImplementation(async () => { effects.push('released'); return { ok: true, value: null, executorStopped: true }; });
    const creating = g.service.service(principal, { ...snapshot, authorityId: opened.authorityId }); await active;
    const closing = g.service.service(principal, { ...release, authorityId: opened.authorityId });
    await Promise.resolve(); expect(effects).toEqual([]);
    drain(); await Promise.all([creating, closing]); expect(effects).toEqual(['creation drained', 'released']);
  });

  it('starts original transport close before joining an in-flight reverse response on revoke', async () => {
    const f = fixture(), binding = await bindMcp(f);
    const address = { coordinatorHostId: 'coordinator', authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch };
    let sent!: () => void, stopped!: () => void;
    const sdkSettlement = new Promise<void>(resolve => { sent = resolve; });
    const transportStopped = new Promise<void>(resolve => { stopped = resolve; });
    f.mcpInteractionContinuation.mockImplementation(async () => {
      await sdkSettlement; // Abort of the HTTP waiter cannot settle this real callback.
      return { ok: true, value: null, executorStopped: true };
    });
    f.releaseSource.mockImplementation(async () => {
      f.events.push('transport-close-started');
      await transportStopped;
      return { mcpExecutorStopped: true };
    });
    const responding = f.service.service(principal, { ...address, requestId: 'original-response', operation: {
      kind: 'mcp', action: { kind: 'interaction_respond', deliveryId: 'delivery', binding: {} as never,
        response: { kind: 'result', value: { action: 'accept' } } },
    } });
    await vi.waitFor(() => expect(f.mcpInteractionContinuation).toHaveBeenCalledOnce());
    const closing = f.service.release(principal, { ...address, mode: 'revoke' });
    try {
      await vi.waitFor(() => expect(f.events).toContain('transport-close-started'));
      expect(f.sourceRequest.mock.calls.some(([method]) => method === 'source.authority.release')).toBe(false);
      sent(); await responding;
      expect(f.sourceRequest.mock.calls.some(([method]) => method === 'source.authority.release')).toBe(false);
      stopped(); await closing;
      expect(f.sourceRequest.mock.calls.some(([method]) => method === 'source.authority.release')).toBe(true);
    } finally { sent(); stopped(); await Promise.allSettled([responding, closing]); }
  });

  it.each([true, false])('uses only original native MCP stop proof to drain unknown executor work (%s)', async nativeStopped => {
    const f = fixture(), binding = await bindMcp(f);
    const receipt = { ok: false, executorStopped: false, error: { code: 'response-lost', dispatched: true, settlement: 'unknown' } };
    f.serviceOperation.mockResolvedValue(receipt);
    f.releaseSource.mockImplementation(async () => { f.events.push('drain-views'); return { mcpExecutorStopped: nativeStopped }; });
    const address = { coordinatorHostId: 'coordinator', authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch };
    const response = await f.service.service(principal, { ...address, requestId: 'entered-call', operation: { kind: 'mcp', action: {
      kind: 'call', handleId: 'view', name: 'write', schemaVersion: 'v1', arguments: {},
    } } });
    expect(await f.service.cancelService(principal, { ...address, requestId: 'entered-call' })).toMatchObject({ status: 'unknown' });
    f.kernel.sourceAuthorityGrant = () => { throw new Error('Original grant is inactive'); };
    const releasing = f.service.release(principal, { ...address, mode: 'retire' });
    if (nativeStopped) await releasing;
    else await expect(releasing).rejects.toThrow('termination is unconfirmed');
    expect(f.releaseSource).toHaveBeenCalledTimes(1);
    expect(f.sourceRequest.mock.calls.some(([method]) => method === 'source.authority.release')).toBe(nativeStopped);
    expect(response).toEqual(receipt); expect(receipt.executorStopped).toBe(false); // The unknown effect was never rewritten.
    expect(f.serviceOperation).toHaveBeenCalledTimes(1);
  });

});

describe('managed pending skill discovery', () => {
  it('uses target registration and read principal without opening a Thread/source grant', async () => {
    const f = fixture();
    const draftSourceSkills = vi.fn(async () => ({ snapshotId: 'draft', skills: [] }));
    const resolveWorkspace = vi.fn(async () => ({ workspaceId: 'workspace', hostId: 'target' }));
    const admitWorkspaceRegistration = vi.fn(async () => ({ workspaceId: 'workspace', hostId: 'target', canonicalPath: '/target/project' }));
    const service = createManagedSourceService({ kernel: f.kernel, hostId: 'target',
      documents: { resolveWorkspace, admitWorkspaceRegistration } as never,
      validateLiveSource: async () => {}, prepareSource: f.prepareSource, draftSourceSkills });
    expect(await service.skills(principal, { coordinatorHostId: 'coordinator', path: '/target/project' })).toEqual({ snapshotId: 'draft', skills: [] });
    expect(draftSourceSkills).toHaveBeenCalledWith('workspace', undefined);
    expect(f.issueGrant).not.toHaveBeenCalled();
    expect(f.sourceRequest).not.toHaveBeenCalled();
    await expect(service.skills({ principalId: 'verified', capabilities: [] }, { coordinatorHostId: 'coordinator', path: '/target/project' })).rejects.toThrow();
    expect(resolveWorkspace).toHaveBeenCalledTimes(1);
    admitWorkspaceRegistration.mockResolvedValueOnce({ workspaceId: 'workspace', hostId: 'other', canonicalPath: '/target/project' });
    await expect(service.skills(principal, { coordinatorHostId: 'coordinator', path: '/target/project' })).rejects.toThrow();
    expect(draftSourceSkills).toHaveBeenCalledTimes(1);
  });
});

it.each(['attachment_cleanup', 'attachment_discard'] as const)('requires write-capable result authority for destructive %s', async kind => {
  const f = fixture();
  const binding = await f.service.bind(principal, { ...request, scope: { kind: 'run', threadId: 'thread', runId: 'run', epoch: 1 }, purpose: 'source', retention: 'run' });
  const input = { coordinatorHostId: 'coordinator', authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch,
    requestId: 'cleanup-read-only', operation: kind === 'attachment_cleanup' ? { kind } : { kind, operationId: 'original-operation', ref: 'attachment:original', path: 'original.csv' } };
  await expect(f.service.service(principal, input)).rejects.toThrow();
  const writer = { ...principal, capabilities: ['filesystem:read', 'filesystem:write'] };
  await expect(f.service.service(writer, { ...input, requestId: 'cleanup-wrong-purpose' })).rejects.toThrow();
  expect(f.serviceOperation).not.toHaveBeenCalled();
});


it.each(['live_root', 'fixed_branch', 'materialized'] as const)('recalls result attachment metadata after the original %s content disappears, while retaining trust checks', async mode => {
  const f = fixture();
  f.validateLiveSource.mockRejectedValue(new Error('Original live directory was deleted'));
  f.readBranch.mockRejectedValue(new Error('Original branch revision was collected'));
  const selected: ThreadSource = mode === 'live_root' ? { resourceOwner: source.resourceOwner, workspaceId: 'workspace', executionWorkspaceId: 'workspace',
    mode, liveRoot: { hostId: 'target', rootId: 'original-root', canonicalRoot: '/deleted/original' }, tools: [] } : { ...source, mode };
  const binding = await f.service.bind(principal, { ...request, source: selected,
    scope: { kind: 'run', threadId: 'thread', runId: 'original-run', epoch: 1 }, purpose: 'result', retention: 'run' });
  f.serviceOperation.mockResolvedValue(null);
  const input = { coordinatorHostId: 'coordinator', authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch,
    requestId: 'recover', operation: { kind: 'attachment_recover' as const, operationId: 'original-operation', ref: 'attachment:original', path: 'original.csv' } };
  expect(await f.service.service(principal, input)).toBeNull();
  expect(f.validateLiveSource).not.toHaveBeenCalled();
  expect(f.readBranch).not.toHaveBeenCalled();
  expect(f.fileRootRegister).not.toHaveBeenCalled();
  expect(f.serviceOperation).toHaveBeenCalledWith(expect.objectContaining({ scope: expect.objectContaining({ runId: 'original-run' }), physicalRoot: null }), input.operation, expect.any(AbortSignal));
  await expect(f.service.service(principal, { ...input, requestId: 'capture', operation: { ...input.operation, kind: 'attachment_capture' } })).rejects.toThrow();
  for (const operation of [{ kind: 'read' as const, path: 'secret.txt' }, { kind: 'document_read' as const, path: 'secret.docx', operationId: 'read' }, { kind: 'compute' as const, input: {} as never }]) {
    await expect(f.service.service(principal, { ...input, requestId: operation.kind, operation })).rejects.toThrow();
  }
  f.state.trusted = false;
  await expect(f.service.service(principal, { ...input, requestId: 'untrusted-recover' })).rejects.toThrow('Trust withdrawn');
});

it('keeps failed capture cleanup pending when no durable original writer drain is available', async () => {
  const f = fixture();
  const writer = { ...principal, capabilities: ['filesystem:read', 'filesystem:write'] };
  const binding = await f.service.bind(writer, { ...request, scope: { kind: 'run', threadId: 'thread', runId: 'run', epoch: 1 }, purpose: 'result', retention: 'run' });
  await expect(f.service.service(writer, { coordinatorHostId: 'coordinator', authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch,
    requestId: 'discard-failed-capture', operation: { kind: 'attachment_discard', operationId: 'terminal-operation', ref: 'attachment:original', path: 'original.csv' } }))
    .rejects.toThrow('writer termination is unconfirmed');
  expect(f.serviceOperation).not.toHaveBeenCalled();
});

it('discards only its completed original capture and fences late recapture without retiring the Run', async () => {
  const f = fixture();
  const writer = { ...principal, capabilities: ['filesystem:read', 'filesystem:write'] };
  const scope = { kind: 'run' as const, threadId: 'thread', runId: 'run', epoch: 1 };
  const captured = { operationId: 'handoff', ref: 'attachment:original', path: 'original.csv' };
  const binding = await f.service.bind(writer, { ...request, scope, purpose: 'source', retention: 'run' });
  const address = { coordinatorHostId: 'coordinator', authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch };
  f.serviceOperation.mockResolvedValue({ attachment: { ref: captured.ref }, contentHash: 'original' });
  await f.service.service(writer, { ...address, requestId: 'capture:original', operation: { kind: 'attachment_capture', ...captured } });
  await f.service.bind(writer, { ...request, scope, purpose: 'result', retention: 'run' });
  for (const change of [{ operationId: 'other' }, { path: 'other.csv' }, { ref: 'attachment:other' }]) {
    await expect(f.service.service(writer, { ...address, requestId: JSON.stringify(change), operation: { kind: 'attachment_discard', ...captured, ...change } })).rejects.toThrow('writer termination is unconfirmed');
  }
  for (const changed of [{ actor: { ...writer, principalId: 'foreign' }, coordinatorHostId: 'coordinator' }, { actor: writer, coordinatorHostId: 'foreign' }]) {
    await expect(f.service.service(changed.actor, { ...address, coordinatorHostId: changed.coordinatorHostId, requestId: `foreign:${changed.actor.principalId}:${changed.coordinatorHostId}`,
      operation: { kind: 'attachment_discard', ...captured } })).rejects.toThrow('writer termination is unconfirmed');
  }
  const exactAuthority = f.state.authority!;
  for (const changed of [{ scope: { ...scope, runId: 'other-run' } }, { scope: { ...scope, epoch: 2 } }, { source: { ...exactAuthority.source, revision: 1 } }]) {
    f.state.authority = { ...exactAuthority, ...changed };
    await expect(f.service.service(writer, { ...address, requestId: `scope:${JSON.stringify(changed)}`, operation: { kind: 'attachment_discard', ...captured } })).rejects.toThrow('writer termination is unconfirmed');
  }
  f.state.authority = exactAuthority;
  f.serviceOperation.mockResolvedValue(undefined);
  await f.service.service(writer, { ...address, requestId: 'discard:original', operation: { kind: 'attachment_discard', ...captured } });
  expect(f.serviceOperation).toHaveBeenLastCalledWith(expect.objectContaining({ scope }), { kind: 'attachment_discard', ...captured }, expect.any(AbortSignal));
  expect(f.sourceRequest.mock.calls.some(([method]) => method === 'source.authority.release_scope')).toBe(false);
  await f.service.bind(writer, { ...request, scope, purpose: 'source', retention: 'run' });
  await expect(f.service.service(writer, { ...address, requestId: 'late-capture', operation: { kind: 'attachment_capture', ...captured } })).rejects.toThrow('closed for cleanup');
});

it('waits for the exact original capture response and keeps uncertain termination pending', async () => {
  const f = fixture();
  const writer = { ...principal, capabilities: ['filesystem:read', 'filesystem:write'] };
  const scope = { kind: 'run' as const, threadId: 'thread', runId: 'run', epoch: 1 };
  const captured = { operationId: 'handoff', ref: 'attachment:original', path: 'original.csv' };
  const binding = await f.service.bind(writer, { ...request, scope, purpose: 'source', retention: 'run' });
  const address = { coordinatorHostId: 'coordinator', authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch };
  let reject!: (error: Error) => void;
  const original = new Promise<never>((_resolve, no) => { reject = no; });
  f.serviceOperation.mockReturnValue(original);
  const capturing = f.service.service(writer, { ...address, requestId: 'capture:original', operation: { kind: 'attachment_capture', ...captured } });
  void capturing.catch(() => undefined);
  await vi.waitFor(() => expect(f.serviceOperation).toHaveBeenCalledTimes(1));
  await f.service.bind(writer, { ...request, scope, purpose: 'result', retention: 'run' });
  const discarded = f.service.service(writer, { ...address, requestId: 'discard:original', operation: { kind: 'attachment_discard', ...captured } });
  void discarded.catch(() => undefined);
  await vi.waitFor(() => expect(f.serviceOperation.mock.calls[0]![2]!.aborted).toBe(true));
  expect(f.serviceOperation).toHaveBeenCalledTimes(1);
  reject(new Error('Original native capture reply was lost'));
  await expect(capturing).rejects.toThrow('reply was lost');
  await expect(discarded).rejects.toThrow('writer termination is unconfirmed');
  expect(f.serviceOperation).toHaveBeenCalledTimes(1);
});

it('metadata read scopes reopen only an existing materialized environment and never create one for a completed Run', async () => {
  const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { originalMaterializationLocation } = await import('../kernel/source-launch.js');
  const root = await mkdtemp(join(tmpdir(), 'varin-source-metadata-'));
  try {
    const f = fixture();
    Object.assign(f.kernel, { handshake: { hostId: 'target', storageRoot: root } });
    const location = await originalMaterializationLocation(root, source.workspaceId, 'finished-run');
    await mkdir(location.targetPath, { recursive: true });
    const getOperation = vi.fn(async (id: string) => id.startsWith('branch-') ? null : ({ state: 'committed', result: { status: 'materialized' } }));
    f.fileRootRegister.mockResolvedValue({ rootId: 'original-environment', canonicalRoot: location.targetPath });
    vi.spyOn(f.kernel, 'scoped').mockReturnValue({ readBranch: f.readBranch, getOperation,
      fileRootRegister: f.fileRootRegister, fileMaterialize: f.fileMaterialize } as never);
    const selected = { ...request, source: { ...source, mode: 'materialized' as const, environmentRunId: 'finished-run' } };
    expect((await f.service.bind(principal, selected)).physicalRoot).toMatchObject({ rootId: 'original-environment', canonicalRoot: location.targetPath });
    expect(f.fileMaterialize).not.toHaveBeenCalled();
    getOperation.mockResolvedValue(null as never);
    expect((await f.service.bind(principal, { ...selected, source: { ...selected.source, environmentRunId: 'never-started' } })).physicalRoot).toBeNull();
    expect(f.fileRootRegister).toHaveBeenCalledTimes(1);
    expect(f.fileMaterialize).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});
