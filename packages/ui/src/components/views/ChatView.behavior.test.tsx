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
vi.mock('@/components/thread/ThreadConversation', () => ({ ThreadConversation: () => <p>Conversation</p> }));
vi.mock('@/components/thread/ExternalConversation', () => ({ ExternalConversationView: () => <p>External conversation</p> }));
vi.mock('@/components/thread/ThreadDraftConversation', () => ({ ThreadDraftConversation: () => <p>Draft</p> }));
vi.mock('@/components/chat/ChatErrorBoundary', () => ({ ChatErrorBoundary: ({ children }: React.PropsWithChildren) => children }));
vi.mock('@/components/ui/button', () => ({ Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button> }));

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  useThreadStore.setState({ selectedIdentity: null, selectedDraftKey: null, threads: [], catalogLoaded: true });
  vi.clearAllMocks();
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

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
