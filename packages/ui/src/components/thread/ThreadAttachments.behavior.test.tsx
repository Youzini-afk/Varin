import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ThreadAttachments, ThreadFileDrafts } from './ThreadAttachments';
import { ChatAgentMessageBubble } from '../conversation/ChatAgentMessageBubble';
import { ThreadContent } from './ThreadContent';
import { historyParts } from '@/lib/agent-runtime/thread-content';
import type { Attachment } from '@varin/protocol';
import type { ThreadIdentity, ThreadsAPI } from '@varin/application-client';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { selectThreadFiles } from '@/lib/agent-runtime/fileAttachments';
import type { ImageAnnotationBinding } from '@/components/images/ImageViewer';
const viewer = vi.hoisted(() => ({ binding: undefined as ImageAnnotationBinding | undefined }));
vi.mock('@/components/images/ImageViewer', () => ({ ImageViewer: ({ annotation }: { annotation?: ImageAnnotationBinding }) => {
  viewer.binding = annotation;
  return <div role="dialog">image editor</div>;
} }));
vi.mock('@/lib/i18n', async original => ({ ...await original<typeof import('@/lib/i18n')>(), useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/AgentAvatar', () => ({ AgentAvatar: () => null }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p> }));
vi.mock('@/stores/useThreadStore', () => ({ useThreadStore: (select: (state: object) => unknown) => select({ threads: [] }) }));
vi.mock('@/stores/useExternalAgentStore', () => ({ useExternalAgentStore: (select: (state: object) => unknown) => select({ conversations: [], children: [] }), openConversationFromNavigation: vi.fn() }));
vi.mock('@/components/ui/dialog', () => ({ Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>, DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2> }));
let root: Root, container: HTMLDivElement;
const identity: ThreadIdentity = { runtime: 'agent', threadId: 'reader', branchId: 'branch' };
const attachment: Attachment = { ref: 'attachment:fixed-original', filename: 'report.unknown', mimeType: 'application/octet-stream', byteLength: 3 };
beforeEach(() => {
  viewer.binding = undefined; useThreadDraftStore.setState({ drafts: {} });
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixed-original'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const click = (label: string) => act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)!.click());
it('keeps unsent file cards compact and opens image annotation in the draft before a conversation exists', async () => {
  const files = selectThreadFiles('new-draft', [new File(['image'], 'image.png'), new File(['notes'], 'notes.txt')]);
  const render = () => root.render(<ThreadFileDrafts draftKey="new-draft" files={useThreadDraftStore.getState().drafts['new-draft'].files} locked={false} onRemove={() => {}} />);
  await act(async () => { render(); });
  expect(container.textContent).toContain('notes.txt');
  expect(container.textContent).not.toContain('chat.media.download'); expect(container.textContent).not.toContain('chat.attachments.selected');
  expect(container.querySelector('[aria-label="imageEditor.annotate"]')).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="imageEditor.annotate"]')!.click());
  expect(viewer.binding?.mode).toBe('draft');
  const doc = { source: { data: btoa('image'), mimeType: 'image/png' }, width: 4, height: 4, marks: [], past: [], future: [] };
  await act(async () => { viewer.binding!.save(files[0]!.id, doc); render(); });
  expect(viewer.binding!.get(files[0]!.id)).toBe(doc);
  await act(async () => viewer.binding!.apply(files[0]!.id, { data: btoa('edited'), mimeType: 'image/png' }, doc));
  const updated = useThreadDraftStore.getState().drafts['new-draft'].files!.find(file => file.id === files[0]!.id)!;
  expect(await updated.data.text()).toBe('edited'); expect(updated.imageReference).toBe(1);
});
it('keeps the file available outside a collapsed message, reads original bytes only for an action and copies its reference', async () => {
  const read = vi.fn<ThreadsAPI['attachments']['read']>(async () => new Blob([new Uint8Array([0, 255, 3])]));
  const api = { attachments: { read } } as unknown as ThreadsAPI;
  await act(async () => root.render(<ChatAgentMessageBubble id="message" text="A long body" attachments={<ThreadAttachments api={api} identity={identity} attachments={[attachment]} />}><p>Expanded body</p></ChatAgentMessageBubble>));
  const card = container.querySelector('[data-attachment-ref]')!;
  expect(card.textContent).toContain('report.unknown'); expect(card.closest('[aria-hidden="true"]')).toBeNull();
  expect(container.textContent).not.toContain('Expanded body'); expect(read).not.toHaveBeenCalled();
  await click('chat.attachments.copyRef');
  expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(attachment.ref); expect(read).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="chat.attachments.preview"]')!.click());
  expect(read).toHaveBeenCalledExactlyOnceWith(identity, { ref: attachment.ref }, expect.any(AbortSignal));
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain('chat.attachments.noPreview');
  expect(container.querySelector('iframe')).toBeNull(); expect(container.querySelector('a[target="_blank"]')).toBeNull();
  await click('chat.media.download'); expect(read).toHaveBeenCalledOnce();
  await act(async () => root.render(null)); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixed-original');
});
it('shows typed input and output attachments without interpreting file-looking arbitrary JSON', async () => {
  const read = vi.fn(); const api = { attachments: { read } } as unknown as ThreadsAPI;
  const output = { data: { fileAttachments: [attachment] }, parts: [{ kind: 'text', text: 'Done' }, { kind: 'attachment', attachment }] };
  await act(async () => root.render(<ThreadContent api={api} identity={identity} holder={{ kind: 'history', itemId: 'result' }} messageId="result"
    parts={historyParts({ content: { kind: 'output', output } }, 'agent')} />));
  expect(container.querySelectorAll('[data-attachment-ref]')).toHaveLength(1);
  expect(read).not.toHaveBeenCalled();
  await act(async () => root.render(<ThreadContent api={api} identity={identity} holder={{ kind: 'history', itemId: 'input' }} messageId="input"
    parts={historyParts({ text: 'Read this', fileAttachments: [attachment] }, 'user')} />));
  expect(container.querySelector('[data-attachment-ref]')?.textContent).toContain('report.unknown');
  await act(async () => root.render(<ThreadContent api={api} identity={identity} holder={{ kind: 'history', itemId: 'opaque' }} messageId="opaque"
    parts={historyParts({ data: { fileAttachments: [attachment] } }, 'agent')} />));
  expect(container.querySelector('[data-attachment-ref]')).toBeNull(); expect(read).not.toHaveBeenCalled();
});

it('recreates draft image URLs after StrictMode cleanup and releases the final original on unmount', async () => {
  vi.mocked(URL.createObjectURL).mockReturnValueOnce('blob:first-mount').mockReturnValueOnce('blob:replayed-mount');
  const file = { id: 'local-image', filename: 'image.png', mimeType: 'image/png', data: new Blob(['original']), status: 'selected' as const };
  await act(async () => root.render(<React.StrictMode><ThreadFileDrafts files={[file]} locked={false} onRemove={() => {}} /></React.StrictMode>));
  expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first-mount');
  expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:replayed-mount');
  await act(async () => root.render(null));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:replayed-mount');
});
