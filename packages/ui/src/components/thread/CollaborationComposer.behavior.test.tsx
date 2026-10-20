import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ThreadIdentity, ThreadsAPI } from '@varin/application-client';
import { CollaborationComposer } from './CollaborationComposer';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
const rootIdentity: ThreadIdentity = { runtime: 'agent', threadId: 'root', branchId: 'root-branch' };
const target: ThreadIdentity = { runtime: 'agent', threadId: 'worker', branchId: 'worktree-branch' };
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('Element', window.Element);
  vi.stubGlobal('Node', window.Node);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  useThreadDraftStore.setState({ drafts: {} });
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
it('retains exact recipient branches and retries only unconfirmed recipients with their original keys', async () => {
  const send = vi.fn<NonNullable<ThreadsAPI['messages']>['send']>().mockImplementation(async (_identity, request) => {
    if (
      request.targetThreadId === 'worker' &&
      send.mock.calls.filter(([, input]) => input.targetThreadId === 'worker').length === 1
    )
      throw new Error('response lost');
    return { messageId: `accepted-${request.targetThreadId}` } as Awaited<
      ReturnType<NonNullable<ThreadsAPI['messages']>['send']>
    >;
  });
  const api = { messages: { send } } as unknown as ThreadsAPI;
  useThreadDraftStore
    .getState()
    .patch('group', { text: 'Check the selected worktree', collaboration: { targets: [rootIdentity, target] } });
  const render = () =>
    root.render(
      <CollaborationComposer
        api={api}
        identity={rootIdentity}
        draftKey="group"
        members={[]}
        onSent={() => {}}
        moreMembers={false}
        loadMembers={() => {}}
      />,
    );
  await act(async () => render());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="collaboration.send"]')!.click());
  expect(send.mock.calls.map(([origin, input]) => [origin, input.targetThreadId, input.targetBranchId])).toEqual([
    [rootIdentity, 'root', 'root-branch'],
    [rootIdentity, 'worker', 'worktree-branch'],
  ]);
  const original = send.mock.calls[1]![1];
  expect(container.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(true);
  // A remounted panel reads the same draft attempt, rather than constructing another command.
  await act(async () => {
    root.render(null);
  });
  await act(async () => render());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="chat.messages.retry"]')!.click());
  expect(send).toHaveBeenCalledTimes(3);
  expect(send.mock.calls[2]![1]).toEqual(original);
  expect(useThreadDraftStore.getState().drafts.group?.text).toBe('');
});
