import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import type { ThreadIdentity } from '@varin/application-client';
import { useThreadStore } from '@/stores/useThreadStore';
import { ThreadFamilyPanel } from './ThreadFamilyPanel';

vi.mock('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({ threads: { family: {}, messages: {}, collaboration: {} } }),
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/thread/ThreadCollaboration', () => ({
  ThreadCollaboration: ({ identity, initialMember }: { identity: ThreadIdentity; initialMember?: ThreadIdentity }) =>
    <p>{identity.threadId}/{identity.branchId}{initialMember && ` → ${initialMember.threadId}/${initialMember.branchId}`}</p>,
}));

it('keeps the room attached to the selected chat and scopes member links to their source branch', async () => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.getElementById('root')!;
  const root = createRoot(container);
  const selectedIdentity = useThreadStore.getState().selectedIdentity;
  const source = { runtime: 'agent' as const, threadId: 'audit-a', branchId: 'first' };
  const member = { ...source, threadId: 'audit-a-child', branchId: 'child-branch' };
  try {
    useThreadStore.setState({ selectedIdentity: source });
    await act(async () => root.render(<ThreadFamilyPanel source={source} member={member} />));
    expect(container.textContent).toBe('audit-a/first → audit-a-child/child-branch');

    await act(async () => useThreadStore.setState({ selectedIdentity: { ...source, branchId: 'fork' } }));
    expect(container.textContent).toBe('audit-a/fork');

    await act(async () => useThreadStore.setState({ selectedIdentity: { ...source, threadId: 'audit-b' } }));
    expect(container.textContent).toBe('audit-b/first');

    await act(async () => useThreadStore.setState({ selectedIdentity: null }));
    expect(container.textContent).toBe('collaboration.openConversation');
  } finally {
    await act(async () => root.unmount());
    useThreadStore.setState({ selectedIdentity });
    vi.unstubAllGlobals();
  }
});
