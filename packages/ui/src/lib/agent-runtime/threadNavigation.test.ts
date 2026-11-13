import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultVarinWorkbenchProfileDocument, type VarinWorkbenchProfileDocument } from '@varin/extension-contract';
import type { BotSummary, RuntimeAPIs, ThreadsAPI } from '@varin/application-client';
import type { ThreadSummary } from '@varin/protocol';
import { bindThreadStore, useThreadStore } from '@/stores/useThreadStore';
import { openBotEntryFor, returnToBot, useBotNavigation } from '@/lib/bots';
import { registerRuntimeAPIs } from '@/lib/runtime-api/registry';
import { openThreadFromNavigation, startThreadFromNavigation } from './threadNavigation';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { useUIStore } from '@/stores/useUIStore';
import { buildDeepLink, parseDeepLink } from '@/apps/deepLinks';
import { followThreadDeepLink } from '@/apps/threadDeepLinkNavigation';
const state = vi.hoisted(() => ({ host: 1, document: undefined as VarinWorkbenchProfileDocument | undefined, select: vi.fn(), directory: vi.fn() }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), getRuntimeEndpointGeneration: () => state.host }));
vi.mock('@/lib/extensions/catalog-store', () => ({ getVarinExtensionCatalogState: () => ({ snapshot: { workbench: { authoritative: true, document: state.document } } }) }));
vi.mock('@/lib/extensions/workbench-shell-transition', () => ({ selectActiveWorkbenchProfile: state.select }));
vi.mock('@/lib/extensions/surface-runtime', () => ({ varinSurfaceRuntime: { surface: 'web' } }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: { getState: () => ({ currentDirectory: '/previous-project', setDirectory: state.directory }) } }));
const summary = (id: string, botId: string | null): ThreadSummary => ({ thread_id: id, main_branch_id: `${id}:main`, title: id, revision: 1, created_at_ms: 0, updated_at_ms: 0,
  pinned: false, archived: false, deleted_at_ms: null, activity_cursor: 0, read_cursor: 0, unread: false, bot_id: botId, parent_thread_id: null, observer_project_ids: [],
  branches: ['main', 'review'].map(branch => ({ branch_id: `${id}:${branch}`, head: null, active_run_id: null, latest_run: null })) });
const bot: BotSummary = { revision: 1, id: 'bot-owner', name: 'Bot', entry: { runtime: 'agent', threadId: 'root', branchId: 'root:main' }, archived: false, homeDir: '/bots/owner', coordinatorHostId: 'host', instructions: null, model: null, createdAt: '', updatedAt: '' };
let unbind: (() => void) | undefined;
const get = vi.fn();
const inspectMany = vi.fn<ThreadsAPI['inspectMany']>();
beforeEach(async () => {
  useUIStore.getState().closeMainSurfaces();
  state.host = 1; state.document = defaultVarinWorkbenchProfileDocument();
  state.document.activeProfileId = 'default';
  state.select.mockReset().mockImplementation(async (profile: string) => { state.document!.activeProfileId = profile; });
  state.directory.mockReset(); get.mockReset().mockResolvedValue(bot);
  useBotNavigation.setState({ botId: null, entry: null, model: null, archived: undefined });
  const catalog = [summary('ordinary', null), summary('child', bot.id)];
  inspectMany.mockReset().mockImplementation(async ids => catalog.filter(thread => ids.includes(thread.thread_id)));
  const threads = { list: async () => catalog, inspectMany, observe: async (_cursor: number, _listener: unknown, { signal }: { signal: AbortSignal }) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })) } as unknown as ThreadsAPI;
  registerRuntimeAPIs({ bots: { get } } as unknown as RuntimeAPIs);
  unbind = bindThreadStore(threads); await useThreadStore.getState().loadCatalog();
  await new Promise(resolve => setTimeout(resolve, 0));
  await useThreadStore.getState().selectThread({ threadId: 'ordinary' });
});
afterEach(() => { unbind?.(); registerRuntimeAPIs(null); });
it('opens global drafts without a project and attaches only an explicitly chosen project', async () => {
  const global = await startThreadFromNavigation();
  expect(useThreadDraftStore.getState().drafts[global].workspacePath).toBeUndefined();
  expect(state.directory).not.toHaveBeenCalled();
  const project = await startThreadFromNavigation({ directory: '/chosen-project' });
  expect(useThreadDraftStore.getState().drafts[project].workspacePath).toBe('/chosen-project');
  expect(state.directory).toHaveBeenCalledWith('/chosen-project');
  const chatOnly = await startThreadFromNavigation({ directory: null });
  expect(useThreadDraftStore.getState().drafts[chatOnly].workspacePath).toBeUndefined();
});
it('opens a direct Bot conversation in the current workbench using its exact native identity', async () => {
  const hostKey = JSON.stringify(['https://host.test', 'host']);
  const intent = parseDeepLink(buildDeepLink({ type: 'thread', hostKey, threadId: 'child', branchId: 'child:review' }));
  if (intent?.type !== 'thread') throw new Error('Thread link required');
  await followThreadDeepLink(intent, { currentHostKey: () => hostKey, currentRuntimeKey: () => 'host', endpointGeneration: () => state.host,
    isCurrent: () => true, connectHost: async () => true, loadCatalog: () => useThreadStore.getState().loadCatalog(), openThread: openThreadFromNavigation, openInstances: vi.fn() });
  expect(state.select).not.toHaveBeenCalled();
  expect(useBotNavigation.getState().entry).toBeNull();
  expect(useThreadStore.getState().selectedIdentity).toMatchObject({ threadId: 'child', branchId: 'child:review' });
  expect(state.directory).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});
it('leaves the Bot shell before selecting an ordinary deep link, without remaining on the restored old branch', async () => {
  state.document!.activeProfileId = 'varin.bot';
  await openThreadFromNavigation({ threadId: 'ordinary', branchId: 'ordinary:review' });
  expect(state.select).toHaveBeenCalledWith('default', undefined, expect.objectContaining({ beforeCommit: expect.any(Function) }));
  expect(useThreadStore.getState().selectedIdentity).toMatchObject({ threadId: 'ordinary', branchId: 'ordinary:review' });
  expect(get).not.toHaveBeenCalled();
});
it('keeps readable history when its Bot profile is missing and still rejects a foreign branch', async () => {
  get.mockResolvedValue(null);
  await expect(openThreadFromNavigation({ threadId: 'child', branchId: 'child:review' })).resolves.toMatchObject({ threadId: 'child', branchId: 'child:review' });
  expect(inspectMany).not.toHaveBeenCalled();
  await expect(openThreadFromNavigation({ threadId: 'child', branchId: 'foreign' })).rejects.toThrow('branch is unavailable');
  expect(inspectMany).toHaveBeenCalledExactlyOnceWith(['child']);
  expect(useThreadStore.getState().selectedIdentity).toMatchObject({ threadId: 'child', branchId: 'child:review' });
  expect(state.select).not.toHaveBeenCalled(); expect(useBotNavigation.getState().entry).toBeNull();
});
it('fences a delayed Bot lookup after a Host switch or newer ordinary navigation', async () => {
  state.document!.activeProfileId = 'varin.bot';
  let finish!: (bot: BotSummary) => void; get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const old = openThreadFromNavigation({ threadId: 'child', branchId: 'child:review' });
  await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
  await openThreadFromNavigation({ threadId: 'ordinary', branchId: 'ordinary:review' });
  finish(bot); await expect(old).rejects.toThrow('superseded');
  expect(useBotNavigation.getState().entry).toBeNull();
  state.document!.activeProfileId = 'varin.bot';
  get.mockImplementationOnce(async () => { state.host++; return bot; });
  await expect(openThreadFromNavigation({ threadId: 'child' })).rejects.toThrow('superseded');
});

it('prevents a prepared workbench switch from committing over a newer Bot navigation', async () => {
  state.document!.activeProfileId = 'varin.bot';
  let commit!: () => Promise<void>;
  let finish!: () => void;
  state.select.mockImplementationOnce(async (_profile: string, _workspace: string | undefined, options: { beforeCommit(): Promise<void> }) => {
    commit = options.beforeCommit;
    await new Promise<void>(resolve => { finish = resolve; });
    await commit();
  });
  const old = openThreadFromNavigation({ threadId: 'ordinary', branchId: 'ordinary:main' });
  await vi.waitFor(() => expect(state.select).toHaveBeenCalledOnce());
  await openThreadFromNavigation({ threadId: 'child', branchId: 'child:review' });
  finish(); await expect(old).rejects.toThrow('superseded');
  expect(useBotNavigation.getState().entry?.branchId).toBe('child:review');
  expect(useThreadStore.getState().selectedIdentity).toEqual({ runtime: 'agent', threadId: 'child', branchId: 'child:review' });
});

it('keeps a newer main surface when a pending conversation lookup finishes', async () => {
  state.document!.activeProfileId = 'varin.bot';
  let finish!: (bot: BotSummary) => void;
  get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const old = openThreadFromNavigation({ threadId: 'child', branchId: 'child:review' });
  await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
  useUIStore.getState().setScheduledTasksDialogOpen(true);
  finish(bot);
  await expect(old).rejects.toThrow('superseded');
  expect(state.select).not.toHaveBeenCalled();
  expect(useBotNavigation.getState().entry).toBeNull();
  expect(useUIStore.getState().isScheduledTasksDialogOpen).toBe(true);
});

it('does not start a Bot shell switch after a newer page supersedes entry resolution', async () => {
  let finish!: (value: { bot: BotSummary; entry: BotSummary['entry']; model: null }) => void;
  registerRuntimeAPIs({ bots: { get, entry: () => new Promise(resolve => { finish = resolve; }) } } as unknown as RuntimeAPIs);
  const old = openBotEntryFor(bot.id);
  useUIStore.getState().setArchivePageOpen(true);
  finish({ bot, entry: bot.entry, model: null });
  await old;
  expect(state.select).not.toHaveBeenCalled();
  expect(useBotNavigation.getState().entry).toBeNull();
  expect(useUIStore.getState().isArchivePageOpen).toBe(true);
});

it('prevents a prepared return-to-Bot shell from committing over a newer page', async () => {
  let finish!: () => void;
  state.select.mockImplementationOnce(async (profile: string, _workspace: string | undefined, options: { beforeCommit(): Promise<void> }) => {
    await new Promise<void>(resolve => { finish = resolve; });
    await options.beforeCommit();
    state.document!.activeProfileId = profile;
  });
  const old = returnToBot({ botId: bot.id, botName: bot.name, session: bot.entry, sessionTitle: 'Bot', workThreadId: 'child' });
  useUIStore.getState().setScheduledTasksDialogOpen(true);
  finish();
  await expect(old).rejects.toThrow('superseded');
  expect(state.document!.activeProfileId).toBe('default');
  expect(useBotNavigation.getState().entry).toBeNull();
  expect(useUIStore.getState().isScheduledTasksDialogOpen).toBe(true);
});


it('freezes a remote project source but an explicit different source never inherits its model/default project', async () => {
  const owner = { kind: 'managed_host' as const, hostId: 'remote', connectionId: 'saved', endpointIdentity: 'endpoint' };
  useProjectsStore.setState({ projects: [{ id: 'remote-project', path: '/same', source: { resourceOwner: owner, workspaceId: 'remote-workspace' } }] });
  const key = await startThreadFromNavigation({ projectId: 'remote-project', organization: { containerId: 'project-container' } });
  const draft = useThreadDraftStore.getState().drafts[key];
  expect(draft.projectId).toBe('remote-project'); expect(draft.workspacePath).toBeUndefined();
  expect(draft.sourceSelection).toMatchObject({ resourceOwner: owner, path: '/same' });
  expect(state.directory).not.toHaveBeenCalled();
  useProjectsStore.setState({ projects: [{ id: 'remote-project', path: '/changed', source: { resourceOwner: owner, workspaceId: 'remote-workspace' } }] });
  expect(useThreadDraftStore.getState().drafts[key].sourceSelection?.path).toBe('/same');
  const override = await startThreadFromNavigation({ projectId: 'remote-project', organization: { containerId: 'project-container' },
    sourceSelection: { resourceOwner: { kind: 'local' }, path: '/explicit', mode: 'live_root', contentMode: 'saved-files', captureScopes: [] } });
  expect(useThreadDraftStore.getState().drafts[override]).toMatchObject({ workspacePath: '/explicit', organization: { containerId: 'project-container' } });
  expect(useThreadDraftStore.getState().drafts[override].projectId).toBeUndefined();
  expect(state.directory).toHaveBeenLastCalledWith('/explicit');
});

it('freezes native adoption identity and keeps previously live drafts live after enable', async()=>{
  const resourceOwner={kind:'managed_host' as const,hostId:'remote',connectionId:'connection',endpointIdentity:'endpoint'};
  const project={id:'project',path:'/physical',source:{resourceOwner,workspaceId:'registered'}};
  useProjectsStore.setState({projects:[project]});
  const live=await startThreadFromNavigation({projectId:'project',organization:{containerId:'node'}});
  const versionedWorkspace={workspaceId:'registered',executionWorkspaceId:'view',branchId:'adopted',adoptionOperationId:'admission',state:'ready' as const};
  useProjectsStore.setState({projects:[{...project,versionedWorkspace}]});
  const native=await startThreadFromNavigation({projectId:'project',organization:{containerId:'node'}});
  useProjectsStore.setState({projects:[{...project,versionedWorkspace:{...versionedWorkspace,state:'disabled'}}]});
  expect(useThreadDraftStore.getState().drafts[live].sourceSelection?.selection).toEqual({mode:'live_root'});
  expect(useThreadDraftStore.getState().drafts[native].sourceSelection).toMatchObject({mode:'native_workspace',selection:{mode:'native_workspace',workspaceId:'registered',executionWorkspaceId:'view',branchId:'adopted',adoptionOperationId:'admission'}});
  expect(state.directory).not.toHaveBeenCalled();
});

it('keeps an owner-created sibling worktree project while freezing its independent live source', async () => {
  const resourceOwner = { kind: 'managed_host' as const, hostId: 'target', connectionId: 'original', endpointIdentity: 'endpoint' };
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/repo', source: { resourceOwner, workspaceId: 'parent-root' } }] });
  const sourceSelection = { resourceOwner, path: '/worktrees/new', expectedWorkspaceId: 'new-root', mode: 'live_root' as const, selection: { mode: 'live_root' as const }, contentMode: 'saved-files' as const, captureScopes: [] };
  const key = await startThreadFromNavigation({ projectId: 'project', organization: { containerId: 'project-node' }, worktreeProject: true, sourceSelection });
  expect(useThreadDraftStore.getState().drafts[key]).toMatchObject({ projectId: 'project', sourceSelection });
  const otherOwner = await startThreadFromNavigation({ projectId: 'project', organization: { containerId: 'project-node' }, worktreeProject: true,
    sourceSelection: { ...sourceSelection, resourceOwner: { kind: 'local' } } });
  expect(useThreadDraftStore.getState().drafts[otherOwner].projectId).toBeUndefined();
});
