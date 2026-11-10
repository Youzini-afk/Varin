import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { ContentReference, ThreadHistoryItem, ThreadsAPI } from '@varin/application-client';
import { ChatUserReferences } from './ChatUserReferences';
import { HistoryPresentation } from './historyPresentation';
import { ContentReferencePreview } from './ContentReferencePreview';
import { ReferenceNavigationContext, type ReferenceNavigation } from './ReferenceNavigation';
import { decorateBoundReferences } from './chatBoundReferenceMarkers';
import { captureChatSelection } from './chatSelection';
import type { ChatUserMessage } from './types';
import { dict } from '@/lib/i18n/messages/en';
import { useFirstMessagePreview } from '@/components/thread/useFirstMessagePreview';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import type { MessageHandoff } from './messageHandoff';
import { flattenAnnotations, type ImageAnnotationDocument } from '@/lib/images/annotations';

vi.mock('@/lib/images/annotations', async original => ({ ...await original<typeof import('@/lib/images/annotations')>(), flattenAnnotations: vi.fn() }));

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof dict, params?: Record<string, unknown>) =>
  (dict[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? name)) }) }));
vi.mock('./ChatContextMenu', () => ({ ChatTextSource: ({ children }: React.PropsWithChildren) => children }));
vi.mock('./ChatCollapsibleUserContent', () => ({ ChatCollapsibleUserContent: ({ children }: React.PropsWithChildren) => children }));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: React.PropsWithChildren<{ open: boolean }>) => open ? <section role="dialog">{children}</section> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <header>{children}</header>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));
vi.mock('@/components/ui/button', () => ({ Button: ({ children, variant: _, ...props }: React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }>) => <button {...props}>{children}</button> }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p> }));
vi.mock('@/lib/agent-runtime/threadNavigation', () => ({ openThreadFromNavigation: vi.fn(async (value: unknown) => value) }));

const identity = { runtime: 'agent' as const, threadId: 'original-thread', branchId: 'original-branch' };
const first: ContentReference = { ref: 'reference:internal-first', number: 4, label: 'Varin', title: 'First answer', text: 'Frozen first paragraph.\n\nFrozen second paragraph.',
  source: { kind: 'chat', thread: identity, passages: [
    { entryId: 'first-message', start: 17, text: 'Frozen first paragraph.' },
    { entryId: 'second-message', start: 38, text: 'Frozen second paragraph.' },
  ] } };
const retained: ContentReference = { ref: 'reference:without-marker', number: 7, title: 'Retained attachment', text: 'Still sent without a marker', source: { kind: 'chat', thread: identity, passages: [] } };
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.mocked(flattenAnnotations).mockReset();
  useThreadDraftStore.setState({ drafts: {} });
  const { document, window } = parseHTML('<html><body></body></html>');
  for (const [key, value] of Object.entries({ document, window, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, NodeFilter: { SHOW_TEXT: 4 }, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(key, value);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const click = async (button: Element) => act(async () => { button.dispatchEvent(new window.Event('click', { bubbles: true })); });
function project(text: string): ChatUserMessage {
  const from = text.indexOf('[引用点4]');
  const history: ThreadHistoryItem[] = [{ id: 'user-message', parent: null, thread_id: identity.threadId, run_id: 'run', source: 'user', provider: null,
    content: { userText: text, text: 'A different model-only projection', contentReferences: [first, retained], contentReferenceOccurrences: [
      { kind: 'content', ref: first.ref, start: from, end: from + '[引用点4]'.length },
    ] } as unknown as ThreadHistoryItem['content'] }];
  const entry = new HistoryPresentation('frozen-history').project(history, undefined).entries[0]!;
  if (entry.type !== 'message' || entry.message.role !== 'user') throw new Error('Missing projected user message');
  return entry.message;
}
it('reopens the admitted user wording with one bound occurrence, preserving literal lookalikes and markerless attachments', async () => {
  const text = 'Discuss [引用点4] then the literal [引用点4].';
  const message = project(text);
  await act(async () => root.render(<ChatUserReferences message={message} messageId="user-message" plain />));
  const inline = container.querySelector('.markdown-content')!;
  expect(inline.textContent).toBe(text);
  expect(inline.querySelectorAll('button')).toHaveLength(1);
  expect(container.textContent).toContain('Reference 7');
  expect(container.textContent).not.toContain('model-only');
  expect(container.textContent).not.toContain(first.ref);
  const selection = captureChatSelection({ intersectsNode: () => true } as unknown as Range,
    new Map([[inline as HTMLElement, { entryId: 'user-message', text, offset: 0 }]]), text);
  expect(selection.complete).toBe(true);
  expect(selection.passages).toEqual([{ entryId: 'user-message', start: 0, text }]);
  await click(inline.querySelector('button')!);
  expect(container.querySelector('[role="dialog"] blockquote')?.textContent).toBe(first.text);
});
it('keeps the frozen quote readable after source navigation fails, and selects each exact source independently', async () => {
  const revealSource = vi.fn(async () => { throw new Error('Source was deleted'); });
  const navigation: ReferenceNavigation = { identity, revealSource };
  const onClose = vi.fn();
  await act(async () => root.render(<ReferenceNavigationContext.Provider value={navigation}>
    <ContentReferencePreview reference={first} onClose={onClose} />
  </ReferenceNavigationContext.Provider>));
  const buttons = [...container.querySelectorAll('button')];
  expect(buttons.map(button => button.textContent)).toEqual(['Locate source 1', 'Locate source 2']);
  await click(buttons[1]!);
  expect(revealSource).toHaveBeenCalledExactlyOnceWith({ thread: identity, entryId: 'second-message', start: 38, end: 62, text: 'Frozen second paragraph.' });
  expect(onClose).not.toHaveBeenCalled();
  expect(container.querySelector('blockquote')?.textContent).toBe(first.text);
  expect(container.querySelector('[role="status"]')?.textContent).toContain('saved quote is unchanged');
});
it('decorates exact Markdown source ranges without binding a literal duplicate or removing surrounding formatting', () => {
  const source = '**First** [引用点4] then [引用点4] and `x`.';
  const root = document.createElement('div'); root.innerHTML = '<p><strong>First</strong> [引用点4] then [引用点4] and <code>x</code>.</p>';
  const start = source.indexOf('[引用点4]');
  const presentation = { markers: [{ occurrence: { kind: 'content' as const, ref: first.ref, start, end: start + 6 }, label: '[引用点4]', description: 'Reference 4 · Varin' }], open() {} };
  decorateBoundReferences(root, source, presentation);
  expect(root.querySelector('strong')?.textContent).toBe('First');
  expect(root.querySelector('code')?.textContent).toBe('x');
  expect(root.querySelectorAll('button')).toHaveLength(1);
  expect(root.querySelector('button')?.textContent).toBe('[引用点4]');
  expect(root.textContent).toBe('First [引用点4] then [引用点4] and x.');
  decorateBoundReferences(root, source, presentation);
  expect(root.querySelectorAll('button')).toHaveLength(1);
  decorateBoundReferences(root, source, null);
  expect(root.querySelectorAll('button')).toHaveLength(0);
});
it('retains separate occurrences of one quote across rendered text segments and skips invalid overlap', () => {
  const source = '[引用点4] and [引用点4]';
  const root = document.createElement('div'); root.innerHTML = '<p><span>[</span><span>引用点4</span><span>]</span> and [引用点4]</p>';
  const markers = [0, 11].map(start => ({ occurrence: { kind: 'content' as const, ref: first.ref, start, end: start + 6 }, label: '[引用点4]', description: 'Reference 4' }));
  decorateBoundReferences(root, source, { markers, open() {} });
  expect([...root.querySelectorAll('button')].map(button => button.textContent)).toEqual(['[引用点4]', '[引用点4]']);
  expect(root.textContent).toBe(source);
});


it('uses the retained input attachment reader after the original file source disappears', async () => {
  const target = { ...identity, threadId: 'target-with-retained-input' };
  const read = vi.fn(async () => new Blob(['Original file bytes, not the changed source.'], { type: 'text/plain' }));
  const api = { attachments: { read, upload: vi.fn() } } as Pick<ThreadsAPI, 'attachments'>;
  const reference: ContentReference = { ref: 'quote:file', number: 2, title: 'old.txt', attachmentRef: 'attachment:retained-original',
    source: { kind: 'file', thread: identity, path: '/deleted/original/old.txt' } };
  await act(async () => root.render(<ContentReferencePreview reference={reference} api={api} identity={target} onClose={() => {}} />));
  expect(read).toHaveBeenCalledExactlyOnceWith(target, { ref: 'attachment:retained-original' }, expect.any(AbortSignal));
  const preview = [...container.querySelectorAll('button')].find(button => button.getAttribute('aria-label')?.includes('old.txt') && button.textContent?.includes('old.txt'));
  expect(preview).toBeTruthy();
  await click(preview!);
  expect(container.textContent).toContain('Original file bytes, not the changed source.');
  expect(read).toHaveBeenCalledTimes(1);
  expect(container.textContent).not.toContain('/deleted/original/old.txt');
});

it('previews external retained attachments through their own reader without a synthetic native thread', async () => {
  const readAttachment = vi.fn(async () => new Blob(['External accepted snapshot'], { type: 'text/plain' }));
  const reference: ContentReference = { ref: 'quote:external-file', title: 'accepted.txt', attachment: { ref: 'external-attachment:accepted' },
    source: { kind: 'file', thread: identity, path: '/no-longer-present' } };
  await act(async () => root.render(<ContentReferencePreview reference={reference} readAttachment={readAttachment} onClose={() => {}} />));
  expect(readAttachment).toHaveBeenCalledExactlyOnceWith('external-attachment:accepted', expect.any(AbortSignal));
  const preview = [...container.querySelectorAll('button')].find(button => button.getAttribute('aria-label')?.includes('accepted.txt'));
  await click(preview!);
  expect(container.textContent).toContain('External accepted snapshot');
  expect(readAttachment).toHaveBeenCalledTimes(1);
});

it('retains original wording and file-image marker bindings through the first accepted receipt until history arrives', async () => {
  const editorText = 'Look at [Image 2]';
  useThreadDraftStore.getState().patch('first-message', { firstMessageReceipt: {
    key: 'first-send', inputId: 'accepted-user', text: `${editorText}\n\nModel-only editor context`, editorText,
    images: [], files: [], selectedAttachments: [{ id: 'picked-file', host: 1, filename: 'original.png', selection: { ref: 'attachment:original' },
      attachment: { ref: 'attachment:original', filename: 'original.png', mimeType: 'image/png', byteLength: 3 } }],
    attachmentImageReferences: { 'attachment:original': 2 },
    contentReferenceOccurrences: [{ kind: 'image', reference: 2, start: 8, end: editorText.length }],
  } });
  const preview = vi.fn();
  const handoff = { preview } as unknown as MessageHandoff;
  function FirstMessage({ hasHistory = false }: { hasHistory?: boolean }) {
    const result = useFirstMessagePreview('first-message', hasHistory, handoff);
    return result.message ? <ChatUserReferences message={result.message} messageId="accepted-user" plain /> : null;
  }
  await act(async () => root.render(<FirstMessage />));
  expect(container.querySelector('.markdown-content')?.textContent).toBe(editorText);
  expect(container.querySelector('.markdown-content button')?.textContent).toBe('[Image 2]');
  expect(container.textContent).not.toContain('Model-only');
  expect(preview).toHaveBeenCalledExactlyOnceWith('first-send', expect.any(Number));
  await act(async () => root.render(<FirstMessage hasHistory />));
  expect(container.textContent).toBe('');
  expect(useThreadDraftStore.getState().drafts['first-message'].firstMessageReceipt).toBeUndefined();
});

it('shows only frozen flattened pixels while an optimistic annotated image is preparing', async () => {
  const annotation: ImageAnnotationDocument = { source: { data: 'b3JpZ2luYWw=', mimeType: 'image/png' }, width: 1, height: 1, marks: [], past: [], future: [] };
  let finish!: (value: { data: string; mimeType: string }) => void;
  vi.mocked(flattenAnnotations).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const message: ChatUserMessage = { role: 'user', timestamp: 1, content: [{ type: 'image', data: annotation.source.data, mimeType: 'image/png', reference: 2, annotation }] };
  await act(async () => root.render(<ChatUserReferences message={message} messageId="pending-image" plain />));
  expect(container.querySelector('img')).toBeNull();
  await act(async () => finish({ data: 'ZWRpdGVk', mimeType: 'image/png' }));
  expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,ZWRpdGVk');
  await act(async () => root.render(<ChatUserReferences message={{ ...message }} messageId="pending-image" plain />));
  expect(flattenAnnotations).toHaveBeenCalledExactlyOnceWith(annotation);
});
