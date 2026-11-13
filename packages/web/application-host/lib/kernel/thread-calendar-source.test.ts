import { expect, it, vi } from 'vitest';
import type { ThreadPrepareSource, ThreadSource } from '@varin/application-client';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { CalendarPreparation, CalendarSource, InitialContext, ModelSessionConfiguration } from './protocol.generated.js';
import type { ContextPreparer } from './thread-context.js';
import type { ExistingHostCredentialOwner } from './credential-owner.js';
import { ThreadAdapter } from './thread-adapter.js';
import { createThreadSourceDirectory, createThreadSourcePreparer } from './thread-sources.js';
import { createManagedSourceConsumers } from './managed-source-consumers.js';

const identity = { runtime: 'agent' as const, threadId: 'thread:calendar', branchId: 'branch:calendar' };
const owner = { kind: 'managed_host' as const, hostId: 'host:B', connectionId: 'connection:B', endpointIdentity: 'endpoint:B' };
const scope = { reference: 'model', authority: 'fixture', account: 'fixture', generation: 1 };
function fixture(selection: CalendarSource) {
  const work = { occurrence: { id: 'occurrence:original', revision: 3, thread_id: identity.threadId, branch_id: identity.branchId },
    definition: { project_id: 'project:A', target: { kind: 'new_work', source: selection, sourceMode: 'materialized',
      model: { providerId: 'fixture', modelId: 'model' }, goal: null } }, instruction: 'Original calendar instruction', owner_epoch: 4 } as CalendarPreparation;
  const runtime = { thread: vi.fn(async () => ({ thread_id: identity.threadId, branches: [{ branch_id: identity.branchId }] })),
    admitCalendar: vi.fn(async () => ({ id: work.occurrence.id, run_id: 'run:original' })) };
  const credentialOwner = { scope: async () => scope, release: vi.fn() } as unknown as ExistingHostCredentialOwner;
  const configuration: ModelSessionConfiguration = { model: 'model', providerFamily: 'fixture', endpoint: 'https://fixture.invalid',
    credentialEnvironment: null, allowAnonymous: true, acceptsImages: false, configurationGeneration: 1, maxOutputTokens: null };
  const models = { resolveModel: vi.fn(async () => ({ configuration, credentialOwner })),
    rebindModel: vi.fn(async () => credentialOwner) };
  const prepare = vi.fn(async (input: ThreadPrepareSource) => ({ path: '/B/project', source: {
    mode: input.mode, resourceOwner: input.resourceOwner, workspaceId: input.workspaceId, executionWorkspaceId: input.workspaceId,
    branchId: `source:${input.key}`, revision: 0, tools: [],
  } as ThreadSource }));
  const admit = vi.fn(async () => {});
  const context = Object.assign(vi.fn(async () => ({ effectiveSystemPrompt: 'original', instructionSources: [], memoryCheckpoint: null } as InitialContext)),
    { main: vi.fn(async () => { throw new Error('Calendar project scope must not be inferred from file location'); }) }) as unknown as ContextPreparer;
  const adapter = new ThreadAdapter(runtime as unknown as AgentRuntimeClient, models, admit,
    () => {}, prepare, context);
  const resolve = vi.fn(async () => ({ resourceOwner: { kind: 'local' as const }, workspaceId: 'workspace:A', path: '/A/project' }));
  adapter.bindSourceDirectory({ list: async () => ({ targets: [], unavailable: [] }), resolve });
  const launch = vi.spyOn(adapter, 'continueLaunch').mockResolvedValue();
  return { work, runtime, models, prepare, admit, context, adapter, resolve, launch };
}

it('cold managed calendar work retains its exact registered B source and its real A project context', async () => {
  const f = fixture({ kind: 'workspace', resourceOwner: owner, workspaceId: 'workspace:B' });
  const stop = new AbortController();
  await f.adapter.prepareCalendarWork(f.work, '/A/path-that-does-not-exist', stop.signal);
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.prepare).toHaveBeenCalledWith({ ...identity, key: 'occurrence:original', resourceOwner: owner, workspaceId: 'workspace:B',
    mode: 'materialized', content: { mode: 'saved-files' }, captureScopes: [] }, stop.signal);
  const source = (await f.prepare.mock.results[0]!.value).source;
  expect(f.admit).toHaveBeenCalledWith(source, identity, undefined, stop.signal);
  expect(f.context).toHaveBeenCalledWith(identity, source, { mode: 'agent', threadRole: 'main', projectId: 'project:A' }, stop.signal);
  expect(f.context.main).not.toHaveBeenCalled();
  expect(f.runtime.admitCalendar).toHaveBeenCalledWith(expect.objectContaining({ occurrenceId: 'occurrence:original', expectedRevision: 3,
    ownerEpoch: 4, launch: expect.objectContaining({ source: expect.objectContaining({ resourceOwner: owner, workspaceId: 'workspace:B' }) }) }), stop.signal);
  stop.abort();
  expect(f.launch).toHaveBeenCalledWith('run:original', expect.not.objectContaining({ signal: expect.anything() }));
});

it('project source resolves only the explicit local project while a selected local workspace bypasses that resolution', async () => {
  const project = fixture({ kind: 'project' });
  const signal = new AbortController().signal;
  await project.adapter.prepareCalendarWork(project.work, '/A/project', signal);
  expect(project.resolve).toHaveBeenCalledWith({ resourceOwner: { kind: 'local' }, path: '/A/project' }, signal);
  expect(project.prepare.mock.calls[0]![0].workspaceId).toBe('workspace:A');
  const workspace = fixture({ kind: 'workspace', resourceOwner: { kind: 'local' }, workspaceId: 'workspace:other' });
  await workspace.adapter.prepareCalendarWork(workspace.work, '/A/project', signal);
  expect(workspace.resolve).not.toHaveBeenCalled();
  expect(workspace.prepare.mock.calls[0]![0].workspaceId).toBe('workspace:other');
});

it('an unavailable managed owner never falls back to the local project or admits another source', async () => {
  const f = fixture({ kind: 'workspace', resourceOwner: owner, workspaceId: 'workspace:B' });
  const error = new Error('Original B is unavailable');
  f.prepare.mockRejectedValue(error);
  await expect(f.adapter.prepareCalendarWork(f.work, '/A/project', new AbortController().signal)).rejects.toMatchObject({ code: 'calendar_preparation:source_preparation:unavailable', cause: error });
  expect(f.prepare).toHaveBeenCalledTimes(1);
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.context).not.toHaveBeenCalled();
  expect(f.runtime.admitCalendar).not.toHaveBeenCalled();
});

it('cancelled original source admission cannot proceed to context or calendar admission', async () => {
  const f = fixture({ kind: 'workspace', resourceOwner: owner, workspaceId: 'workspace:B' });
  const stop = new AbortController();
  f.admit.mockImplementation(async () => { stop.abort(new Error('Calendar stopped')); });
  await expect(f.adapter.prepareCalendarWork(f.work, '/A/project', stop.signal)).rejects.toThrow('Calendar stopped');
  expect(f.context).not.toHaveBeenCalled();
  expect(f.runtime.admitCalendar).not.toHaveBeenCalled();
});


it('the shared directory and source preparer reach the selected B port without any local directory or fake Thread', async () => {
  let hostId = owner.hostId;
  const remoteResolve = vi.fn(async () => ({ hostId, workspaceId: 'workspace:B', canonicalRoot: '/B/project' }));
  const remotePrepare = vi.fn(async ({ input }: { input: ThreadPrepareSource }) => ({ path: '/B/project', source: {
    resourceOwner: input.resourceOwner, workspaceId: input.workspaceId, executionWorkspaceId: input.workspaceId,
    mode: input.mode, branchId: 'source:calendar', revision: 0, tools: [],
  } as ThreadSource }));
  const client = { resolve: remoteResolve, prepare: remotePrepare };
  const registry = { sourceTargets: async () => ({ targets: [{ resourceOwner: owner, label: 'B', capabilities: ['sources'] }],
    unavailable: [{ connectionId: 'offline', label: 'Offline', message: 'Unavailable' }] }), source: vi.fn(async () => client) };
  const consumers = createManagedSourceConsumers({ coordinatorHostId: () => 'host:A',
    registry: registry as unknown as Parameters<typeof createManagedSourceConsumers>[0]['registry'],
    withRunAuthority: async () => { throw new Error('Directory/capture must not start a Run'); } });
  const local = vi.fn(async () => { throw new Error('No local workspace exists'); });
  const directory = createThreadSourceDirectory({ documents: { resolveWorkspace: local, admitWorkspaceRegistration: local }, remote: consumers.threads });
  const signal = new AbortController().signal;
  const targets = await directory.list(signal);
  expect(targets.targets.map(target => target.resourceOwner)).toEqual([{ kind: 'local' }, owner]);
  expect(targets.unavailable).toHaveLength(1);
  const selected = await directory.resolve({ resourceOwner: owner, path: '/B/project' }, signal);
  expect(remoteResolve).toHaveBeenCalledWith({ coordinatorHostId: 'host:A', path: '/B/project' }, signal);
  const prepare = createThreadSourcePreparer({ remote: consumers.threads, documents: {} as never,
    inspectInventory: local, workingStates: {} as never, sourceTools: local });
  await prepare({ ...identity, key: 'occurrence:original', resourceOwner: selected.resourceOwner, workspaceId: selected.workspaceId,
    mode: 'materialized', content: { mode: 'saved-files' }, captureScopes: [] }, signal);
  expect(remotePrepare).toHaveBeenCalledWith(expect.objectContaining({ coordinatorHostId: 'host:A', input: expect.objectContaining({
    resourceOwner: owner, workspaceId: 'workspace:B', key: 'occurrence:original',
  }) }), expect.any(AbortSignal));
  expect(local).not.toHaveBeenCalled();
  hostId = 'host:replacement';
  await expect(directory.resolve({ resourceOwner: owner, path: '/B/project' }, signal)).rejects.toThrow('changed Host');
});

it('cold materialized calendar uses the production native source backend and reports its unavailable stage', async () => {
  const f = fixture({ kind: 'project' });
  const { createHash } = await import('node:crypto');
  const { normalizeThreadSourcePreparation } = await import('./thread-sources.js');
  const { KernelClientError } = await import('./kernel-error.js');
  const original = { ...identity, key: f.work.occurrence.id, resourceOwner: { kind: 'local' as const },
    workspaceId: 'workspace:A', mode: 'materialized' as const, content: { mode: 'saved-files' as const }, captureScopes: [] };
  const normalized = normalizeThreadSourcePreparation(original);
  const captureIdentity = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  const key = createHash('sha256').update(JSON.stringify([identity.threadId, identity.branchId, original.key])).digest('hex');
  const branchId = `source:${key}`;
  const store = {
    readOriginalSource: async () => ({ root: 'original-root', provenance: { consistency: 'fixed-root', selection: { captureIdentity } } }),
    pinBranch: async () => ({ workspaceId: original.workspaceId, branchId, revision: 0, root: 'original-root', release: async () => {} }),
  };
  const native = { retainPrepared: vi.fn(async () => {}), open: vi.fn(async () => ({ grant: 'original-grant' })),
    acquire: vi.fn(async () => ({ path: '/native/calendar' })) };
  const prepare = createThreadSourcePreparer({
    documents: { admitWorkspaceRegistration: async () => ({ canonicalPath: '/A/project' }) } as never,
    workingStates: { withBranchStore: async (_id: string, _reason: string, work: (value: typeof store) => unknown) => work(store) } as never,
    nativeWorkspaces: native as never, inspectInventory: async () => { throw new Error('Original source must not be recaptured'); },
    sourceTools: async () => ['file.read'],
  });
  f.prepare.mockImplementation(prepare);
  await f.adapter.prepareCalendarWork(f.work, '/A/project', new AbortController().signal);
  expect(native.open).toHaveBeenCalledOnce();
  expect(native.acquire).toHaveBeenCalledWith(expect.objectContaining({ workspace_id: original.workspaceId, branch_id: branchId }),
    'original-grant', expect.any(AbortSignal));
  expect(f.runtime.admitCalendar).toHaveBeenCalledWith(expect.objectContaining({ launch: expect.objectContaining({
    source: expect.objectContaining({ mode: 'native_workspace', workspaceId: original.workspaceId, branchId }),
  }) }), expect.any(AbortSignal));
  f.runtime.admitCalendar.mockClear();
  native.open.mockRejectedValueOnce(new KernelClientError({ code: 'workspace_backend_unavailable', message: 'Private backend diagnostics' }));
  await expect(f.adapter.prepareCalendarWork(f.work, '/A/project', new AbortController().signal)).rejects.toMatchObject({
    code: 'calendar_preparation:source_preparation:workspace_backend_unavailable',
  });
  expect(f.runtime.admitCalendar).not.toHaveBeenCalled();
});

it.each(['identity', 'source_resolution', 'source_admission', 'model', 'context', 'admission'] as const)(
  'retains the failing %s preparation stage without exposing exception contents', async stage => {
    const f = fixture({ kind: 'project' });
    const failure = new Error('Private prompt, path and provider token');
    const operation = { identity: f.runtime.thread, source_resolution: f.resolve, source_admission: f.admit,
      model: f.models.resolveModel, context: vi.mocked(f.context), admission: f.runtime.admitCalendar }[stage];
    operation.mockRejectedValueOnce(failure);
    await expect(f.adapter.prepareCalendarWork(f.work, '/A/project', new AbortController().signal)).rejects.toMatchObject({
      code: `calendar_preparation:${stage}:unavailable`, message: `calendar_preparation:${stage}:unavailable`, cause: failure,
    });
  });

it('managed preparation accepts the original native backend but cannot upgrade frozen live selection or replace workspace', async () => {
  const remotePrepare = vi.fn(async (request: { input: ThreadPrepareSource }) => ({ path: '/B/native', source: {
    resourceOwner: owner, workspaceId: request.input.workspaceId, executionWorkspaceId: 'native-execution',
    mode: 'native_workspace' as const, branchId: 'native-branch', tools: [],
  } }));
  const consumers = createManagedSourceConsumers({ coordinatorHostId: () => 'host:A',
    registry: { source: async () => ({ prepare: remotePrepare }) } as never,
    withRunAuthority: async () => { throw new Error('Preparation must not start a Run'); } });
  const input: ThreadPrepareSource = { ...identity, resourceOwner: owner, workspaceId: 'workspace:B', key: 'calendar-native',
    mode: 'materialized', content: { mode: 'saved-files' }, captureScopes: [] };
  expect((await consumers.threads.prepare(input)).source.mode).toBe('native_workspace');
  expect((await consumers.threads.prepare({ ...input, mode: 'live_root' })).source.mode).toBe('native_workspace');
  await expect(consumers.threads.prepare({ ...input, mode: 'fixed_branch' })).rejects.toThrow('changed the original selection');
  await expect(consumers.threads.prepare({ ...input, mode: 'live_root', selection: { mode: 'live_root' } })).rejects.toThrow('changed the original selection');
  remotePrepare.mockResolvedValueOnce({ path: '/B/other', source: { resourceOwner: owner, workspaceId: 'foreign',
    executionWorkspaceId: 'native-execution', mode: 'native_workspace', branchId: 'native-branch', tools: [] } });
  await expect(consumers.threads.prepare(input)).rejects.toThrow('changed the original selection');
});

it('calendar admission forwards only the binding returned by its original registered source owner', async () => {
  const f = fixture({ kind: 'workspace', resourceOwner: { kind: 'local' }, workspaceId: 'registered-subtree' });
  if (f.work.definition.target.kind !== 'new_work') throw new Error('Expected new work');
  f.work.definition.target.sourceMode = 'live_root';
  const reference = { workspace_id: 'owning-workspace', execution_workspace_id: 'original-execution', branch_id: 'original-branch', native_scope: 'selected/subtree' };
  const nativeSource: ThreadSource = { resourceOwner: { kind: 'local' }, workspaceId: reference.workspace_id,
    executionWorkspaceId: reference.execution_workspace_id, branchId: reference.branch_id, nativeScope: reference.native_scope,
    mode: 'native_workspace', tools: [] };
  const prepare = createThreadSourcePreparer({
    documents: { admitWorkspaceRegistration: async () => ({ canonicalPath: '/original', nativeSource: reference }) } as never,
    nativeWorkspaces: { prepare: async () => ({ path: '/native/selected/subtree', source: nativeSource }) } as never,
    workingStates: {} as never, inspectInventory: async () => { throw new Error('Live view is not a capture'); }, sourceTools: async () => [],
  });
  f.prepare.mockImplementation(prepare);
  await f.adapter.prepareCalendarWork(f.work, '/project', new AbortController().signal);
  expect(f.runtime.admitCalendar).toHaveBeenCalledWith(expect.objectContaining({ occurrenceId: f.work.occurrence.id,
    sourcePreparation: expect.objectContaining({ threadId: identity.threadId, branchId: identity.branchId, key: f.work.occurrence.id,
      workspaceId: 'registered-subtree', nativeSource: expect.objectContaining(reference),
      preparedSource: expect.objectContaining({ native_scope: 'selected/subtree', workspace_id: 'owning-workspace' }) }),
    launch: expect.objectContaining({ source: expect.objectContaining({ workspaceId: 'owning-workspace', nativeScope: 'selected/subtree' }) }),
  }), expect.any(AbortSignal));
});
