import { describe, expect, it, vi } from 'vitest';
import type { ThreadPrepareSource, ThreadSource } from '@varin/application-client';
import type { KernelClient, KernelGrantHandle, KernelGrantIssueInput } from '../kernel/kernel-client.js';
import type { SourceAuthorityOpenParams, SourceAuthorityBindParams, SourceAuthorityResult, SourceHandoffClaimParams } from '../kernel/protocol.generated.js';
import { createManagedSourceService } from './managed-source-service.js';
import { ManagedSourceDrainedError } from './managed-source-drain.js';
import { createSourceQueryService } from '../kernel/source-query-service.js';
import type { ManagedSourceBindRequest, ManagedSourcePrincipal, ManagedSourceServiceHandler, ManagedSourceLocalScope, ManagedSourceCleanupScope } from './managed-remote-types.js';

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
  const sourceRequest = vi.fn(async (method: string, input: unknown) => {
    events.push(method);
    if (method === 'source.capabilities') return { tools: [], grantCapabilities: ['storage.read'], clientCapabilities: ['filesystem:read'], unavailable: [] };
    if (method === 'source.authority.open') {
      const params = input as SourceAuthorityOpenParams;
      state.authority = { authorityId: 'authority', resourceEpoch: 'target-epoch', executionOwner: { kind: 'external', identity: 'source', epoch: 'target-epoch' },
        source: params.source, scope: params.scope, phase: 'preparing', purpose: params.purpose, operationId: params.operationId ?? null, grantId: params.grantId,
        toolBinding: null, physicalRoot: null, firstPreparation: true, materializationOperationId: 'materialize', mcpHolders: [] };
      return state.authority;
    }
    if (method === 'source.authority.bind') {
      const params = input as SourceAuthorityBindParams;
      state.authority = { ...state.authority!, phase: 'ready', toolBinding: params.toolBinding, physicalRoot: params.physicalRoot };
      return state.authority;
    }
    if (method === 'source.authority.inspect') return state.authority;
    if (method === 'source.authority.seal') { state.authority = { ...state.authority!, phase: state.authority!.mcpHolders.some(holder => !holder.released) ? 'retaining' : 'draining' }; return state.authority; }
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
    }, scoped: () => ({ readBranch, fileMaterialize, fileRootRegister }), retireGrant: vi.fn(async () => ({})),
  } as unknown as KernelClient;
  const prepareSource = vi.fn(async (input: ThreadPrepareSource) => ({ path: '/target/project', source: { ...source, resourceOwner: input.resourceOwner } }));
  const serviceOperation = vi.fn<ManagedSourceServiceHandler>(async () => { state.trusted = false; return { committed: true }; });
  const releaseSource = vi.fn<(scope: ManagedSourceCleanupScope) => Promise<void | { mcpExecutorStopped: boolean }>>(async () => { events.push('drain-views'); });
  const releaseMcpView = vi.fn(async () => ({ ok: true as const, value: null, executorStopped: true as const }));
  const service = createManagedSourceService({ kernel, hostId: 'target', releaseMcpView, documents: {
    admitWorkspaceRegistration: async () => {
      events.push('registration'); if (!state.trusted) throw new Error('Trust withdrawn');
      return { workspaceId: 'workspace', canonicalPath: '/target/project', hostId: 'target' };
    },
  } as never, validateLiveSource: async () => {}, prepareSource, serviceOperation, releaseSource });
  return { service, kernel, state, events, sourceRequest, issueGrant, claimManagedChildSource, readBranch, fileMaterialize, fileRootRegister, prepareSource, serviceOperation, releaseSource, releaseMcpView };
}

async function bindMcp(f: ReturnType<typeof fixture>) {
  const root = { hostId: 'target', rootId: 'mcp-root', canonicalRoot: '/target/project' };
  f.fileRootRegister.mockResolvedValue(root);
  return f.service.bind({ ...principal, capabilities: [...principal.capabilities, 'terminal:use', 'process:control'] },
    { ...request, purpose: 'mcp_owner', retention: 'run', scope: { kind: 'run', threadId: 'thread', runId: 'run', epoch: 1 },
      source: { resourceOwner: source.resourceOwner, workspaceId: source.workspaceId, executionWorkspaceId: source.executionWorkspaceId, mode: 'live_root', tools: [], liveRoot: root } });
}

describe('managed Source target admission orchestration', () => {
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
    expect(f.releaseSource).toHaveBeenCalledWith(expect.objectContaining({ authorityId: binding.authorityId, scope: expect.objectContaining({ threadId: 'thread' }) }));
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
      resourceOwners: { agentDir: '/unused-query-assets', homeDir: '/unused-query-home' } as never });
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
      resourceOwners: { agentDir: '/unused-query-assets', homeDir: '/unused-query-home' } as never });
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
    resourceOwners: { agentDir: '/unused-query-assets', homeDir: '/unused-query-home' } as never });
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
      resourceOwners: { agentDir: '/unused-query-assets', homeDir: '/unused-query-home' } as never });
    f.serviceOperation.mockImplementation(queries);
    let started!: () => void, releasing!: () => void, finishRelease!: () => void, jobId = '', cancelled = false;
    const active = new Promise<void>(resolve => { started = resolve; });
    const atRelease = new Promise<void>(resolve => { releasing = resolve; });
    const released = new Promise<void>(resolve => { finishRelease = resolve; });
    const page = () => ({ jobId, workspaceId: 'workspace', kernelEpoch: 'target-epoch', root: 'fixed-root',
      status: cancelled ? 'cancelled' : 'running', records: [], nextCursor: 0, endCursor: 0, scannedFiles: 0 });
    const computeRelease = vi.fn(async () => { releasing(); await released; if (releaseFails) throw new Error('Original compute release failed'); return {}; });
    Object.defineProperty(f.kernel, 'scoped', { value: () => ({ readBranch: f.readBranch,
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
