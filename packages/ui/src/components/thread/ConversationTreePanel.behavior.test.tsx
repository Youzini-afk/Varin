import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ThreadConversationTree, ThreadsAPI } from '@varin/application-client';
import { ConversationTreePanel } from './ConversationTreePanel';
import { useConversationTreeStore } from '@/stores/useConversationTreeStore';
import { useThreadStore, threadComposerKey, threadHostKey } from '@/stores/useThreadStore';
import { openThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { WorkbenchProfileContext } from '@/lib/workbench/profile-context';
import { useBotNavigation } from '@/lib/bots';

const services = vi.hoisted(() => ({ api: undefined as unknown as ThreadsAPI }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ threads: services.api }) }));
vi.mock('@/lib/agent-runtime/threadNavigation', () => ({ openThreadFromNavigation: vi.fn(async target => {
  const identity = { runtime: 'agent', ...target };
  useThreadStore.setState({ selectedIdentity: identity });
  return identity;
}) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/AgentAvatar', () => ({ AgentAvatar: () => null }));
vi.mock('@/components/ui/collapsible', () => {
  const Open = React.createContext(false);
  return {
    Collapsible: ({ children, open }: React.PropsWithChildren<{ open: boolean }>) => <Open.Provider value={open}>{children}</Open.Provider>,
    CollapsibleContent: ({ children }: React.PropsWithChildren) => React.useContext(Open) ? <div>{children}</div> : null,
  };
});
vi.mock('../conversation/ConversationTimeline', () => ({ ConversationTimeline: () => <div>Expanded conversation</div> }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@varin/application-client', async original => ({
  ...await original<typeof import('@varin/application-client')>(),
  getRuntimeKey: () => 'tree-fixture-host', getRuntimeEndpointGeneration: () => 1,
}));

const identity = { runtime: 'agent' as const, threadId: 'thread', branchId: 'main' };
const tree: ThreadConversationTree = {
  threadId: 'thread', mainBranchId: 'main', children: [],
  routes: [
    { branchId: 'main', headId: 'main-end', nodeId: 'main-turn', sourceBranchId: null, forkHeadId: null, preserved: false, activeRunId: null },
    { branchId: 'saved', headId: 'saved-end', nodeId: 'saved-turn', sourceBranchId: 'main', forkHeadId: 'start-end', preserved: true, activeRunId: null },
  ],
  nodes: [
    { id: 'start', parentId: null, runId: 'first', firstItemId: 'start', lastItemId: 'start-end', branchId: 'main', itemCount: 2 },
    { id: 'main-turn', parentId: 'start', runId: 'second', firstItemId: 'main-turn', lastItemId: 'main-end', branchId: 'main', itemCount: 2 },
    { id: 'saved-turn', parentId: 'start', runId: 'old-second', firstItemId: 'saved-turn', lastItemId: 'saved-end', branchId: 'saved', itemCount: 2 },
  ],
};
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window);
  vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', undefined);
  useConversationTreeStore.setState({ views: {}, navigation: {} });
  useBotNavigation.setState({ botId: null, entry: null, model: null });
  useThreadStore.setState({ selectedIdentity: identity, threads: [] });
  services.api = {
    conversationTree: vi.fn(async () => tree),
    treePreview: vi.fn(async (_identity, range) => ({ user: range.firstItemId, assistant: 'A response', activity: '' })),
    observe: vi.fn(async (_cursor, _listener, { signal }) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve()))),
    historyPage: vi.fn(async () => ({ head: 'saved-end', previous: null, items: [] })),
    fork: vi.fn(async () => ({ ...identity, branchId: 'new-branch' })),
    navigate: vi.fn(),
  } as unknown as ThreadsAPI;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<ConversationTreePanel />));
const row = (id: string) => container.querySelector<HTMLElement>(`[data-tree-node="${id}"]`)!;

it('opens another route at its original message without recovering or submitting work', async () => {
  await render();
  expect(services.api.historyPage).not.toHaveBeenCalled();
  await act(async () => row('saved-turn').querySelector<HTMLButtonElement>('button')!.click());
  expect(openThreadFromNavigation).toHaveBeenCalledWith({ ...identity, branchId: 'saved' });
  const key = threadComposerKey(threadHostKey(), { ...identity, branchId: 'saved' });
  expect(useConversationTreeStore.getState().navigation[key]).toMatchObject({ kind: 'reveal', entryId: 'saved-turn', runId: 'old-second' });
  expect(services.api.navigate).not.toHaveBeenCalled(); expect(services.api.fork).not.toHaveBeenCalled();
  await act(async () => row('saved-turn').querySelector<HTMLButtonElement>('[aria-label="chat.tree.expand"]')!.click());
  expect(services.api.historyPage).toHaveBeenCalledWith({ ...identity, branchId: 'saved' }, { headId: 'saved-end', beforeId: undefined }, expect.any(AbortSignal));
  expect(container.textContent).toContain('Expanded conversation');
});

it('continues a chosen route with an immutable fork and preserves disclosure choices after reopening', async () => {
  const catalog = vi.spyOn(useThreadStore.getState(), 'loadCatalog').mockResolvedValue();
  await render();
  await act(async () => row('saved-turn').querySelector<HTMLButtonElement>('button')!.click());
  await act(async () => row('saved-turn').querySelector<HTMLButtonElement>('[aria-label="chat.tree.expand"]')!.click());
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'chat.tree.continue')!.click());
  expect(services.api.fork).toHaveBeenCalledWith({ ...identity, branchId: 'saved', headId: 'saved-end', key: expect.any(String) });
  expect(catalog).toHaveBeenCalled();
  await act(async () => root.render(<ConversationTreePanel active={false} />));
  useThreadStore.setState({ selectedIdentity: identity });
  await render();
  expect(row('saved-turn').querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
});

it('uses the Bot selection in Bot mode and shows an empty tree when switching to a workbench draft', async () => {
  useThreadStore.setState({ selectedIdentity: { ...identity, threadId: 'ordinary-work' } });
  useBotNavigation.setState({ botId: 'bot', entry: identity });
  await act(async () => root.render(<WorkbenchProfileContext.Provider value="varin.bot"><ConversationTreePanel /></WorkbenchProfileContext.Provider>));
  expect(services.api.conversationTree).toHaveBeenCalledWith(identity, expect.any(AbortSignal));
  expect(container.querySelectorAll('[data-tree-node]')).toHaveLength(3);

  await act(async () => {
    useThreadStore.setState({ selectedIdentity: null });
    root.render(<ConversationTreePanel />);
  });
  expect(container.querySelector('[data-tree-node]')).toBeNull();
  expect(container.textContent).toBe('chat.tree.openConversation');
  expect(services.api.conversationTree).toHaveBeenCalledTimes(1);
});
