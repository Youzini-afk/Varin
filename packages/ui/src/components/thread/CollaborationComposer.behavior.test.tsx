import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getRuntimeEndpointGeneration, type ThreadIdentity, type ThreadsAPI } from '@varin/application-client';
import { CollaborationComposer } from './CollaborationComposer';
import { selectThreadFiles } from '@/lib/agent-runtime/fileAttachments';
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
  const upload = vi.fn<ThreadsAPI['attachments']['upload']>().mockResolvedValue({ ref: 'attachment:partial-original', filename: 'payload.zip', mimeType: 'application/zip', byteLength: 3 });
  const api = { messages: { send }, attachments: { upload } } as unknown as ThreadsAPI;
  selectThreadFiles('group', [new File(['zip'], 'payload.zip')]);
  useThreadDraftStore
    .getState()
    .patch('group', { text: 'Check the selected worktree', collaboration: { targets: [rootIdentity, target], afterCurrent: true } });
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
  expect(original.afterCurrent).toBe(true);
  expect(original.attachments).toEqual([{ ref: 'attachment:partial-original' }]);
  expect(useThreadDraftStore.getState().drafts.group.files).toHaveLength(1);
  expect(container.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(true);
  // A remounted panel reads the same draft attempt, rather than constructing another command.
  await act(async () => {
    root.render(null);
  });
  await act(async () => render());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="chat.messages.retry"]')!.click());
  expect(send).toHaveBeenCalledTimes(3);
  expect(upload).toHaveBeenCalledOnce();
  expect(useThreadDraftStore.getState().drafts.group.files).toEqual([]);
  expect(send.mock.calls[2]![1]).toEqual(original);
  expect(useThreadDraftStore.getState().drafts.group?.text).toBe('');
});

it('prepares binary attachments once and sends attachment-only messages to every selected recipient', async () => {
  const send = vi.fn<NonNullable<ThreadsAPI['messages']>['send']>().mockResolvedValue({ messageId: 'accepted' } as never);
  let complete!: (value: import('@varin/protocol').Attachment) => void;
  const upload = vi.fn<ThreadsAPI['attachments']['upload']>().mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const api = { messages: { send }, attachments: { upload } } as unknown as ThreadsAPI;
  useThreadDraftStore.getState().patch('files', { collaboration: { targets: [rootIdentity, target] } });
  await act(async () => root.render(<CollaborationComposer api={api} identity={rootIdentity} draftKey="files" members={[]} onSent={() => {}} moreMembers={false} loadMembers={() => {}} />));
  const file = new File([new Uint8Array([0, 255, 3])], 'original.weird');
  await act(async () => {
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(picker, 'files', { value: [file] }); picker.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="collaboration.send"]')!.click());
  expect(upload).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled();
  expect(upload.mock.calls[0]![1].data).toBe(file);
  expect(container.textContent).toContain('chat.attachments.preparing');
  await act(async () => complete({ ref: 'attachment:fixed', filename: file.name, mimeType: 'application/octet-stream', byteLength: file.size }));
  expect(send.mock.calls.map(([, request]) => ({ text: request.text, attachments: request.attachments, target: request.targetThreadId }))).toEqual([
    { text: '', attachments: [{ ref: 'attachment:fixed' }], target: 'root' }, { text: '', attachments: [{ ref: 'attachment:fixed' }], target: 'worker' },
  ]);
  expect(useThreadDraftStore.getState().drafts.files.files).toEqual([]);
});

it('sends visible source paths and fixed references as the original caller, and freezes retries across source changes', async () => {
  const selectedAttachments = [
    { id: 'path', host: getRuntimeEndpointGeneration(), filename: 'data.csv', sourceKey: 'caller-source', selection: { path: 'research/data.csv' } },
    { id: 'ref', host: getRuntimeEndpointGeneration(), filename: 'result.txt', selection: { ref: 'attachment:fixed-result' } },
  ];
  const send = vi.fn<NonNullable<ThreadsAPI['messages']>['send']>().mockRejectedValueOnce(new Error('receipt unknown')).mockResolvedValue({ messageId: 'accepted' } as never);
  const upload = vi.fn(); const api = { messages: { send }, attachments: { upload } } as unknown as ThreadsAPI;
  useThreadDraftStore.getState().patch('source-files', { selectedAttachments });
  const render = (scope: string) => root.render(<CollaborationComposer api={api} identity={rootIdentity} draftKey="source-files" referenceScope={scope} direct={target} members={[]} onSent={() => {}} moreMembers={false} loadMembers={() => {}} />);
  await act(async () => render('caller-source'));
  expect(container.textContent).toContain('data.csv'); expect(container.textContent).toContain('result.txt');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="collaboration.send"]')!.click());
  const original = send.mock.calls[0]![1];
  expect(send.mock.calls[0]![0]).toEqual(rootIdentity);
  expect(original).toMatchObject({ targetThreadId: target.threadId, targetBranchId: target.branchId, text: '', attachments: [{ path: 'research/data.csv' }, { ref: 'attachment:fixed-result' }] });
  expect(upload).not.toHaveBeenCalled(); expect(useThreadDraftStore.getState().drafts['source-files'].selectedAttachments).toEqual(selectedAttachments);
  await act(async () => root.render(null)); await act(async () => render('changed-caller-source'));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="chat.messages.retry"]')!.click());
  expect(send.mock.calls[1]![1]).toEqual(original);
  expect(useThreadDraftStore.getState().drafts['source-files'].selectedAttachments).toEqual([]);
});
it('rejects a source change during upload before sending paths, while retaining the original upload receipt and selections', async () => {
  let complete!: (value: import('@varin/protocol').Attachment) => void;
  const send = vi.fn(), upload = vi.fn<ThreadsAPI['attachments']['upload']>().mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const api = { messages: { send }, attachments: { upload } } as unknown as ThreadsAPI;
  selectThreadFiles('scope-change', [new File(['payload'], 'file.txt')]);
  useThreadDraftStore.getState().patch('scope-change', { selectedAttachments: [{ id: 'path', host: getRuntimeEndpointGeneration(), filename: 'data.csv', sourceKey: 'source-one', selection: { path: 'research/data.csv' } }] });
  const render = (scope: string) => root.render(<CollaborationComposer api={api} identity={rootIdentity} draftKey="scope-change" referenceScope={scope} direct={target} members={[]} onSent={() => {}} moreMembers={false} loadMembers={() => {}} />);
  await act(async () => render('source-one')); await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="collaboration.send"]')!.click());
  await act(async () => render('source-two'));
  await act(async () => complete({ ref: 'attachment:uploaded-original', filename: 'file.txt', mimeType: 'text/plain', byteLength: 7 }));
  expect(send).not.toHaveBeenCalled(); expect(container.textContent).toContain('earlier source');
  expect(useThreadDraftStore.getState().drafts['scope-change']).toMatchObject({ selectedAttachments: [{ id: 'path' }], files: [{ attachment: { ref: 'attachment:uploaded-original' } }], collaboration: { sending: false } });
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="collaboration.send"]')!.click());
  expect(upload).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
});
