import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ChatView } from './ChatView';
import { useThreadStore } from '@/stores/useThreadStore';
import { WorkbenchShellActiveContext } from '@/lib/workbench/shell-activity';
import { startThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';

vi.mock('@/lib/agent-runtime/threadNavigation', () => ({ startThreadFromNavigation: vi.fn(async () => 'navigation-draft') }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ threads: {} }) }));
vi.mock('@/hooks/useSelectedThreadWorkspace', () => ({ useSelectedThreadWorkspace: () => ({ directory: '/repo' }) }));
vi.mock('@/stores/useExternalAgentStore', () => ({ useExternalAgentStore: (select: (state: { selectedId: null }) => unknown) => select({ selectedId: null }) }));
const scene = vi.hoisted(() => ({ failure: false }));
vi.mock('@/components/thread/ThreadConversation', () => ({ ThreadConversation: () => {
  if (scene.failure) throw new Error('Original conversation render failed');
  return <p>Conversation</p>;
} }));
vi.mock('@/components/thread/ExternalConversation', () => ({ ExternalConversationView: () => <p>External conversation</p> }));
vi.mock('@/components/thread/ThreadDraftConversation', () => ({ ThreadDraftConversation: () => <p>Draft</p> }));
vi.mock('@/components/ui/button', () => ({ Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button> }));

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  scene.failure = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  useThreadStore.setState({ hostKey: 'host-a', selectedIdentity: null, selectedDraftKey: null, threads: [], catalogLoaded: true });
  vi.clearAllMocks();
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('a staged empty chat waits for promotion, then initializes a local draft without another Profile switch', async () => {
  const render = (active: boolean) => root.render(<WorkbenchShellActiveContext.Provider value={active}><ChatView active /></WorkbenchShellActiveContext.Provider>);
  await act(async () => render(false));
  expect(useThreadStore.getState().selectedDraftKey).toBeNull();
  expect(startThreadFromNavigation).not.toHaveBeenCalled();
  await act(async () => render(true));
  const draft = useThreadStore.getState().selectedDraftKey;
  expect(draft).toBeTruthy();
  expect(container.textContent).toBe('Draft');
  expect(startThreadFromNavigation).not.toHaveBeenCalled();
  await act(async () => render(true));
  expect(useThreadStore.getState().selectedDraftKey).toBe(draft);
});

test('local initialization preserves an existing draft and explicit new-chat navigation', async () => {
  const draft = useThreadStore.getState().openDraft();
  await act(async () => root.render(<ChatView />));
  expect(useThreadStore.getState().selectedDraftKey).toBe(draft);
  await act(async () => {
    useThreadStore.setState({ selectedDraftKey: null });
    root.render(<ChatView autoOpenDraft={false} />);
  });
  expect(startThreadFromNavigation).not.toHaveBeenCalled();
  await act(async () => container.querySelector('button')!.click());
  expect(startThreadFromNavigation).toHaveBeenCalledOnce();
});


test.each(['thread', 'branch', 'host'] as const)('a failed conversation does not trap navigation to another %s', async change => {
  const identity = { runtime: 'agent' as const, threadId: 'thread-a', branchId: 'branch-a' };
  scene.failure = true;
  useThreadStore.setState({ selectedIdentity: identity });
  await act(async () => root.render(<ChatView />));
  expect(container.textContent).toContain('Original conversation render failed');
  scene.failure = false;
  await act(async () => {
    useThreadStore.setState(change === 'host' ? { hostKey: 'host-b' } : {
      selectedIdentity: { ...identity, ...(change === 'thread' ? { threadId: 'thread-b' } : { branchId: 'branch-b' }) },
    });
  });
  expect(container.textContent).toBe('Conversation');
});
