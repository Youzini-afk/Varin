import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { BotRequestError, type ThreadMemoryAPI, type ThreadMemorySelection as Selection } from '@varin/application-client';
import { ThreadMemorySelection } from './ThreadMemorySelection';
vi.mock('@/components/ui/dialog', () => {
  const Section = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return { Dialog: ({ children }: { children: React.ReactNode }) => <section role="dialog">{children}</section>, DialogContent: Section, DialogHeader: Section, DialogTitle: Section };
});
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>'); vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const click = async (label: string) => { const button = [...container.querySelectorAll('button')].find(value => value.textContent === label); expect(button).toBeTruthy(); await act(async () => button!.click()); };
const identity: Selection = { runtime: 'agent', threadId: 'original-thread', branchId: 'original-branch', headId: 'original-head' };
it('freezes history identity and original retry, reviews memory before save and undoes the exact receipt', async () => {
  const owner = { scope: 'bot' as const, ownerId: 'original-bot' };
  const preview = vi.fn<ThreadMemoryAPI['preview']>().mockRejectedValueOnce(new BotRequestError(409, 'pending', 'Original request is pending', 'observe'))
    .mockImplementation(async request => ({ owner, requestKey: request.requestKey, drafts: [{ content: 'A lasting decision', trigger: 'When choosing storage', nature: 'decision', sources: request.sources.map(source => ({ ...source, revision: 'source-revision' })) }] }));
  const save = vi.fn<ThreadMemoryAPI['save']>(async request => ({ owner, created: true, item: { id: 42, content: request.draft.content, trigger: request.draft.trigger, status: 'accepted' } }));
  const undo = vi.fn<ThreadMemoryAPI['undo']>(async () => ({ undone: true })); const api = { preview, save, undo };
  const render = async (headId: string) => act(async () => root.render(<ThreadMemorySelection api={api} identity={{ ...identity, headId }} itemId="original-item" text="Use durable storage." />));
  await render(identity.headId); expect(preview).not.toHaveBeenCalled();
  await click('Preview memory'); expect(container.textContent).toContain('Original request is pending');
  await render('new-appended-head'); await click('Retry preview');
  expect(preview.mock.calls[1]?.[0]).toEqual(preview.mock.calls[0]?.[0]);
  expect(preview.mock.calls[1]?.[0]).toMatchObject({ ...identity, sources: [{ itemId: 'original-item', start: 0, text: 'Use durable storage.' }] });
  expect(save).not.toHaveBeenCalled(); await click('Save memory');
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ ...identity, target: 'owner', expectedOwner: owner, draft: expect.objectContaining({ sources: [{ itemId: 'original-item', start: 0, text: 'Use durable storage.', revision: 'source-revision' }] }) }));
  await click('Undo'); expect(undo).toHaveBeenCalledWith({ ...identity, target: 'owner', expectedOwner: owner, id: 42,
    expected: { content: 'A lasting decision', trigger: 'When choosing storage', status: 'accepted', invalidAt: null } });
});
it('discards a preview when the original Thread changes', async () => {
  let finish!: (result: Awaited<ReturnType<ThreadMemoryAPI['preview']>>) => void;
  const preview = vi.fn<ThreadMemoryAPI['preview']>(() => new Promise(resolve => { finish = resolve; }));
  const api: ThreadMemoryAPI = { preview, save: vi.fn(), undo: vi.fn() };
  await act(async () => root.render(<ThreadMemorySelection api={api} identity={identity} itemId="item" text="Original text" />)); await click('Preview memory');
  await act(async () => root.render(<ThreadMemorySelection api={api} identity={{ ...identity, branchId: 'new-branch' }} itemId="item" text="Original text" />));
  await act(async () => finish({ owner: { scope: 'bot', ownerId: 'old-bot' }, requestKey: preview.mock.calls[0]![0].requestKey, drafts: [] }));
  expect(container.querySelector('[role=dialog]')).toBeNull(); expect(preview.mock.calls[0]?.[1]?.aborted).toBe(true);
});
