import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { getRuntimeEndpointGeneration, type ThreadIdentity, type ThreadSnapshot, type ThreadsAPI } from '@varin/application-client';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { ComposerDirectedInput } from './ComposerDirectedInput';
import { ThreadHandoffForm } from './ThreadHandoffForm';
import { directedComposerKey } from './composerWorkflowState';
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
const identity: ThreadIdentity = { runtime: 'agent', threadId: 'source', branchId: 'branch' };
const snapshot = { historyPage: { head: 'original-head', previous: null }, history: [
  { id: 'chosen', source: 'user', content: { text: 'Selected context' } }, { id: 'private-unselected', source: 'user', content: { text: 'Unselected conversation' } },
] } as unknown as ThreadSnapshot;
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  for (const [name, value] of Object.entries({ document, window, HTMLElement: window.HTMLElement,
    Node: window.Node, MutationObserver: window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value);
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('getComputedStyle', () => ({ lineHeight: '20px' }));
  Object.assign(document, { getSelection: () => null, hasFocus: () => false });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  useThreadDraftStore.setState({ drafts: {} });
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
const click = async (label: string) => { const button = [...container.querySelectorAll('button')].find(value => value.textContent === label); expect(button).toBeTruthy(); await act(async () => button!.click()); };
const choose = async (label: string, value: string) => { const select = container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; await act(async () => { Object.defineProperty(select, 'value', { value, configurable: true }); select.dispatchEvent(new window.Event('change', { bubbles: true })); }); };
const check = async (index: number) => { const checkbox = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[index]!; await act(async () => { checkbox.checked = true; checkbox.dispatchEvent(new window.Event('click', { bubbles: true })); }); };
function fixture() {
  const attachment = { ref: 'attachment:fixed', filename: 'source.txt', mimeType: 'text/plain', byteLength: 5 };
  useThreadDraftStore.getState().patch('ordinary', { text: 'Ordinary draft stays', files: [{ id: 'upload-key', filename: attachment.filename, mimeType: attachment.mimeType, data: new Blob(['bytes']), status: 'selected' }] });
  const upload = vi.fn<ThreadsAPI['attachments']['upload']>(async () => attachment), dispatch = vi.fn().mockRejectedValueOnce(new Error('dispatch receipt unknown')).mockResolvedValue({ operationId: 'op', executionId: 'ex', threadId: 'new-task', branchId: 'new-branch', actor: { kind: 'user' }, acceptedCursor: 3 });
  const api = { attachments: { upload }, family: { list: vi.fn(async () => ({ rootThreadId: 'source', members: [{ threadId: 'recipient', name: 'Existing Agent', branches: [{ branchId: 'target-branch' }], state: 'completed' }] })) }, collaboration: { dispatch, dispatchCatalog: vi.fn(async () => ({ runId: 'parent-run', headId: 'original-head', models: [{ id: 'chosen:model', name: 'Model', channelName: 'Channel', thinkingLevels: [], defaultThinkingLevel: 'off' }], projects: [] })) } } as unknown as ThreadsAPI;
  return { api, upload, dispatch };
}
it('new task confirms only explicit background/files, preserves partial upload success and retries original dispatch after remount', async () => {
  const { api, upload, dispatch } = fixture();
  useThreadDraftStore.getState().patch('ordinary', draft => ({ files: [...draft.files!, { id: 'second-key', filename: 'second.txt', mimeType: 'text/plain', data: new Blob(['second']), status: 'selected' }] }));
  let secondAttempts = 0;
  upload.mockImplementation(async (_identity, request) => {
    if (request.key === 'second-key' && ++secondAttempts === 1) throw new Error('Second file upload failed');
    return request.key === 'second-key' ? { ref: 'attachment:second', filename: 'second.txt', mimeType: 'text/plain', byteLength: 6 } : { ref: 'attachment:fixed', filename: 'source.txt', mimeType: 'text/plain', byteLength: 5 };
  });
  const render = () => root.render(<ThreadHandoffForm api={api} identity={identity} snapshot={snapshot} draftKey="ordinary" initialText="Draft the requested section" onRecipient={() => {}} onDone={() => {}} />);
  await act(async () => render()); expect(dispatch).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
  await choose('composer.handoff.target', 'new'); await choose('composer.command.model', 'chosen:model');
  await check(0); await check(2); await click('composer.confirm');
  expect(dispatch).not.toHaveBeenCalled(); expect(upload).toHaveBeenCalledTimes(2);
  await click('composer.confirm');
  const original = dispatch.mock.calls[0]![0];
  expect(original).toMatchObject({ ...identity, expectedHead: 'original-head', text: 'Draft the requested section', model: 'chosen:model', projectId: null,
    background: [{ threadId: 'source', branchId: 'branch', headId: 'original-head', itemIds: ['chosen'] }], attachments: [{ ref: 'attachment:fixed' }, { ref: 'attachment:second' }] });
  expect(JSON.stringify(original)).not.toContain('private-unselected'); expect(upload).toHaveBeenCalledTimes(3);
  await act(async () => root.render(null)); await act(async () => render());
  expect(container.textContent).toContain('original-head'); expect(container.textContent).toContain('attachment:fixed');
  await click('composer.menu.retry');
  expect(dispatch.mock.calls[1]![0]).toEqual(original); expect(upload).toHaveBeenCalledTimes(3);
  expect(useThreadDraftStore.getState().drafts.ordinary).toMatchObject({ text: 'Ordinary draft stays', files: [{ id: 'upload-key' }, { id: 'second-key' }] });
});
it('existing Agent preparation changes only its own draft and does not send or dispatch before explicit send', async () => {
  const { api, dispatch, upload } = fixture(), select = vi.fn(), done = vi.fn();
  await act(async () => root.render(<ThreadHandoffForm api={api} identity={identity} snapshot={snapshot} draftKey="ordinary" initialText="Instructions" onRecipient={select} onDone={done} />));
  const recipient = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Existing Agent'))!;
  await act(async () => recipient.click()); await check(0); await click('composer.workflow.prepareMessage');
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ identity: { runtime: 'agent', threadId: 'recipient', branchId: 'target-branch' } }));
  expect(done).toHaveBeenCalledTimes(1); expect(dispatch).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
  const directed = useThreadDraftStore.getState().drafts[directedComposerKey('ordinary', { runtime: 'agent', threadId: 'recipient', branchId: 'target-branch' })];
  expect(directed?.text).toContain('Selected context'); expect(directed?.text).not.toContain('Unselected conversation');
  expect(useThreadDraftStore.getState().drafts.ordinary?.text).toBe('Ordinary draft stays');
});

it('hands off selected source paths and fixed references without uploads, and rejects stale source selections before dispatch', async () => {
  const { api, dispatch, upload } = fixture();
  useThreadDraftStore.getState().patch('ordinary', { files: [], selectedAttachments: [
    { id: 'path', host: getRuntimeEndpointGeneration(), filename: 'selected.csv', sourceKey: 'original-source', selection: { path: 'data/selected.csv' } },
    { id: 'ref', host: getRuntimeEndpointGeneration(), filename: 'prior.txt', selection: { ref: 'attachment:original-result' } },
  ] });
  const render = (scope: string) => root.render(<ThreadHandoffForm api={api} identity={identity} snapshot={snapshot} draftKey="ordinary" referenceScope={scope} initialText="Use these files" onRecipient={() => {}} onDone={() => {}} />);
  await act(async () => render('wrong-source')); await choose('composer.handoff.target', 'new'); await choose('composer.command.model', 'chosen:model');
  await check(2); expect(container.textContent).toContain('selected.csv'); await click('composer.confirm');
  expect(dispatch).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled(); expect(container.textContent).toContain('earlier source');
  await act(async () => render('original-source')); await click('composer.confirm');
  expect(dispatch.mock.calls[0]![0]).toMatchObject({ ...identity, attachments: [{ path: 'data/selected.csv' }, { ref: 'attachment:original-result' }] });
  expect(upload).not.toHaveBeenCalled();
  expect(useThreadDraftStore.getState().drafts.ordinary.selectedAttachments).toHaveLength(2);
});
it('prepares and sends chosen path attachments to an existing Agent using only the original caller source', async () => {
  const { api, dispatch, upload } = fixture(), select = vi.fn();
  const send = vi.fn<NonNullable<ThreadsAPI['messages']>['send']>().mockResolvedValue({ messageId: 'accepted' } as never);
  const withSend = { ...api, messages: { send } } as unknown as ThreadsAPI;
  useThreadDraftStore.getState().patch('ordinary', { files: [], selectedAttachments: [{ id: 'path', host: getRuntimeEndpointGeneration(), filename: 'source.md', sourceKey: 'caller-source', selection: { path: 'docs/source.md' } }] });
  await act(async () => root.render(<ThreadHandoffForm api={withSend} identity={identity} snapshot={snapshot} draftKey="ordinary" referenceScope="caller-source" initialText="Use the selected file" onRecipient={select} onDone={() => {}} />));
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Existing Agent'))!.click());
  await check(2); await click('composer.workflow.prepareMessage');
  const recipient = select.mock.calls[0]![0];
  const targetKey = directedComposerKey('ordinary', recipient.identity);
  expect(useThreadDraftStore.getState().drafts[targetKey].selectedAttachments).toEqual(useThreadDraftStore.getState().drafts.ordinary.selectedAttachments);
  expect(send).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
  await act(async () => root.render(<ComposerDirectedInput api={withSend} identity={identity} draftKey="ordinary" referenceScope="caller-source" recipient={recipient} select={() => {}} onSent={() => {}} />));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="collaboration.send"]')!.click());
  expect(send.mock.calls[0]).toEqual([identity, expect.objectContaining({ targetThreadId: 'recipient', targetBranchId: 'target-branch', attachments: [{ path: 'docs/source.md' }] })]);
  expect(useThreadDraftStore.getState().drafts.ordinary.selectedAttachments).toHaveLength(1);
});
