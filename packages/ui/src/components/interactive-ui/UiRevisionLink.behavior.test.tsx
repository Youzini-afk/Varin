import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import { normalizeConversationUi, getRuntimeEndpointGeneration } from '@varin/application-client';
import { UiRevisionLink } from './UiRevisionLink';
import { ConversationContext, type ConversationPresentation } from '@/components/conversation/ConversationContext';
import { uiSession, updateUiSession } from '@/lib/interactive-ui/sessions';
const latest = vi.hoisted(() => vi.fn());
vi.mock('@/lib/interactive-ui/latest-revision', () => ({ latestUiRevision: latest }));
vi.mock('@/lib/interactive-ui/useDeclarativeUi', () => ({ useDeclarativeUi: () => ({ values: {}, state: { controls: {} }, resetKeys: [], error: '', setValue() {}, setControl() {} }) }));
vi.mock('@/lib/interactive-ui/native-object-actions', () => ({ useNativeObjectActions: () => ({}) }));
vi.mock('./NativeObjectContent', () => ({ NativeObjectContent: () => null }));
vi.mock('./InlineUiViews', () => ({ InlineUiSlot: () => <div data-background-slot /> }));
vi.mock('./InteractiveUiCard', () => ({ UiWorkView: () => <div data-html-view /> }));
vi.mock('@/components/ui/dialog', () => ({ Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <section role="dialog">{children}</section>, DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2> }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ SimpleMarkdownRenderer: () => null }));
vi.mock('@/lib/i18n', () => { const t = (key: string) => key; return { useI18n: () => ({ t }) }; });
vi.mock('@/lib/interactive-ui/work-projection', () => ({ restoreUiWork: async (session: Parameters<typeof updateUiSession>[0], ref: string) => {
  updateUiSession(session, { source: { ref }, content: normalizeConversationUi({ type: 'choice', label: 'Nested choice', options: ['A', 'B'] }),
    files: {}, assets: {}, entry: '', title: 'Child', committed: true, status: '' });
} }));

it('keeps a latest declarative embed and its form inside the dialog rather than the background timeline portal', async () => {
  const { window, document } = parseHTML('<html><body><main></main></body></html>');
  for (const [key, value] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(key, value);
  const identity = { runtime: 'agent' as const, threadId: `latest-dialog:${crypto.randomUUID()}`, branchId: 'main' };
  const original = uiSession(`original:${identity.threadId}`, identity, getRuntimeEndpointGeneration());
  original.display = { source: { ref: 'ui:original@1' }, files: {}, assets: {}, entry: '', title: 'Original', committed: true, status: '' };
  const revision = uiSession(`${original.key}:revision:2`, identity, original.host);
  revision.display = { source: { ref: 'ui:original@2' }, content: normalizeConversationUi({ type: 'embed', ref: 'ui:child@1' }), files: {}, assets: {}, entry: '', title: 'Latest', committed: true, status: '' };
  latest.mockResolvedValue(revision);
  const conversation = { identity, uiInlineViews: true, toolExecutions: {}, api: {} } as ConversationPresentation;
  const root = createRoot(document.querySelector('main')!);
  try {
    await act(async () => root.render(<ConversationContext.Provider value={conversation}><UiRevisionLink session={original} /></ConversationContext.Provider>));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => document.querySelector('button')!.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Nested choice');
    expect(dialog.querySelectorAll('input')).toHaveLength(2);
    expect(document.querySelector('[data-background-slot]')).toBeNull();
    expect(dialog.querySelectorAll('form')).toHaveLength(1);
    expect(dialog.querySelector('form form')).toBeNull();
    expect(dialog.querySelector('[data-conversation-ui-fragment]')?.tagName).toBe('DIV');
    expect(original.display.source.ref).toBe('ui:original@1');
    expect(conversation.uiInlineViews).toBe(true);
  } finally { act(() => root.unmount()); vi.unstubAllGlobals(); }
});
