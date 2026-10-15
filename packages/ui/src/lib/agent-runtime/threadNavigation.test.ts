import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultVarinWorkbenchProfileDocument, type VarinWorkbenchProfileDocument } from '@varin/extension-contract';
import type { BotSummary, RuntimeAPIs, ThreadsAPI } from '@varin/application-client';
import type { ThreadSummary } from '@varin/protocol';
import { bindThreadStore, useThreadStore } from '@/stores/useThreadStore';
import { useBotNavigation } from '@/lib/bots';
import { registerRuntimeAPIs } from '@/lib/runtime-api/registry';
import { openThreadFromNavigation } from './threadNavigation';
import { buildDeepLink, parseDeepLink } from '@/apps/deepLinks';
import { followThreadDeepLink } from '@/apps/threadDeepLinkNavigation';
const state = vi.hoisted(() => ({ host: 1, document: undefined as VarinWorkbenchProfileDocument | undefined, select: vi.fn(), directory: vi.fn() }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), getRuntimeEndpointGeneration: () => state.host }));
vi.mock('@/lib/extensions/catalog-store', () => ({ getVarinExtensionCatalogState: () => ({ snapshot: { workbench: { authoritative: true, document: state.document } } }) }));
vi.mock('@/lib/extensions/workbench-shell-transition', () => ({ selectActiveWorkbenchProfile: state.select }));
vi.mock('@/lib/extensions/surface-runtime', () => ({ varinSurfaceRuntime: { surface: 'web' } }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: { getState: () => ({ setDirectory: state.directory }) } }));
const summary = (id: string, botId: string | null): ThreadSummary => ({ thread_id: id, main_branch_id: `${id}:main`, title: id, revision: 1, created_at_ms: 0, updated_at_ms: 0,
  pinned: false, archived: false, deleted_at_ms: null, activity_cursor: 0, read_cursor: 0, unread: false, bot_id: botId, parent_thread_id: null, observer_project_ids: [],
  branches: ['main', 'review'].map(branch => ({ branch_id: `${id}:${branch}`, head: null, active_run_id: null, latest_run: null })) });
const bot: BotSummary = { id: 'bot-owner', name: 'Bot', entry: { runtime: 'agent', threadId: 'root', branchId: 'root:main' }, archived: false, homeDir: '/bots/owner', coordinatorHostId: 'host', instructions: null, model: null, createdAt: '', updatedAt: '' };
let unbind: (() => void) | undefined;
const get = vi.fn();
beforeEach(async () => {
  state.host = 1; state.document = defaultVarinWorkbenchProfileDocument();
  state.select.mockReset().mockImplementation(async (profile: string) => { state.document!.activeProfileId = profile; });
  state.directory.mockReset(); get.mockReset().mockResolvedValue(bot);
  useBotNavigation.setState({ botId: null, entry: null, model: null, archived: undefined });
  const threads = { list: async () => [summary('ordinary', null), summary('child', bot.id)], observe: async (_cursor: number, _listener: unknown, { signal }: { signal: AbortSignal }) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })) } as unknown as ThreadsAPI;
  registerRuntimeAPIs({ bots: { get } } as unknown as RuntimeAPIs);
  unbind = bindThreadStore(threads); await useThreadStore.getState().loadCatalog();
  await new Promise(resolve => setTimeout(resolve, 0));
  await useThreadStore.getState().selectThread({ threadId: 'ordinary' });
});
afterEach(() => { unbind?.(); registerRuntimeAPIs(null); });
it('follows Bot notification links using Catalog ownership and the exact target branch while retaining ordinary selection', async () => {
  const hostKey = JSON.stringify(['https://host.test', 'host']);
  const intent = parseDeepLink(buildDeepLink({ type: 'thread', hostKey, threadId: 'child', branchId: 'child:review' }));
  if (intent?.type !== 'thread') throw new Error('Thread link required');
  await followThreadDeepLink(intent, { currentHostKey: () => hostKey, currentRuntimeKey: () => 'host', endpointGeneration: () => state.host,
    isCurrent: () => true, connectHost: async () => true, loadCatalog: () => useThreadStore.getState().loadCatalog(), openThread: openThreadFromNavigation, openInstances: vi.fn() });
  expect(state.select).toHaveBeenCalledWith('varin.bot', undefined, expect.objectContaining({ enableShell: true, beforeCommit: expect.any(Function) }));
  expect(useBotNavigation.getState()).toMatchObject({ botId: bot.id, entry: { threadId: 'child', branchId: 'child:review' } });
  expect(useThreadStore.getState().selectedIdentity?.threadId).toBe('ordinary');
  expect(get).toHaveBeenCalledWith(bot.id, undefined);
});
it('leaves the Bot shell before selecting an ordinary deep link, without remaining on the restored old branch', async () => {
  state.document!.activeProfileId = 'varin.bot';
  await openThreadFromNavigation({ threadId: 'ordinary', branchId: 'ordinary:review' });
  expect(state.select).toHaveBeenCalledWith('default', undefined, expect.objectContaining({ beforeCommit: expect.any(Function) }));
  expect(useThreadStore.getState().selectedIdentity).toMatchObject({ threadId: 'ordinary', branchId: 'ordinary:review' });
  expect(get).not.toHaveBeenCalled();
});
it('never falls back to ordinary presentation for a missing Bot or invalid Bot branch', async () => {
  get.mockResolvedValue(null);
  await expect(openThreadFromNavigation({ threadId: 'child', branchId: 'child:review' })).rejects.toThrow('Bot is unavailable');
  await expect(openThreadFromNavigation({ threadId: 'child', branchId: 'foreign' })).rejects.toThrow('branch is unavailable');
  expect(state.select).not.toHaveBeenCalled(); expect(useBotNavigation.getState().entry).toBeNull();
});
it('fences a delayed Bot lookup after a Host switch or newer ordinary navigation', async () => {
  let finish!: (bot: BotSummary) => void; get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const old = openThreadFromNavigation({ threadId: 'child', branchId: 'child:review' });
  await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
  await openThreadFromNavigation({ threadId: 'ordinary', branchId: 'ordinary:review' });
  finish(bot); await expect(old).rejects.toThrow('superseded');
  expect(useBotNavigation.getState().entry).toBeNull();
  get.mockImplementationOnce(async () => { state.host++; return bot; });
  await expect(openThreadFromNavigation({ threadId: 'child' })).rejects.toThrow('superseded');
});

it('prevents a prepared Bot shell from committing over a newer ordinary navigation', async () => {
  let commit!: () => Promise<void>;
  let finish!: () => void;
  state.select.mockImplementationOnce(async (_profile: string, _workspace: string | undefined, options: { beforeCommit(): Promise<void> }) => {
    commit = options.beforeCommit;
    await new Promise<void>(resolve => { finish = resolve; });
    await commit();
  });
  const old = openThreadFromNavigation({ threadId: 'child', branchId: 'child:review' });
  await vi.waitFor(() => expect(state.select).toHaveBeenCalledOnce());
  await openThreadFromNavigation({ threadId: 'ordinary', branchId: 'ordinary:review' });
  finish(); await expect(old).rejects.toThrow('superseded');
  expect(useBotNavigation.getState().entry).toBeNull();
  expect(useThreadStore.getState().selectedIdentity?.branchId).toBe('ordinary:review');
});
