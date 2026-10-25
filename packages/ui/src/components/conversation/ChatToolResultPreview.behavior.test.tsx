import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ThreadHistoryItem } from '@varin/application-client';
import type { JsonValue, Outcome } from '@varin/protocol';
import { dict } from '@/lib/i18n/messages/en';
import { useUIStore } from '@/stores/useUIStore';
import { ChatTimelineEntryList } from './ChatTimelineEntries';
import { ConversationContext, type ConversationPresentation } from './ConversationContext';
import { HistoryPresentation } from './historyPresentation';
import { OfficeGrid } from './ChatComputerTools';
import { ThreadQuestion } from '../thread/ThreadQuestion';
import { viewedImages } from './viewedImages';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof dict, params?: Record<string, unknown>) =>
  (dict[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? name)) }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));
vi.mock('@/lib/extensions/workbench-registry', () => ({ useWorkbenchMatchRenderers: () => [], renderFirstWorkbenchMatch: () => undefined }));

// The isolated Rust audit's FixedBranch read returned data with no OutputBody
// text parts. Keep that owner envelope intact through the history consumer.
const auditRead = {
  content: { byteLength: 92, eof: true, hash: 'sha256-audit', nextOffset: 92, offset: 0,
    text: 'Varin native runtime UI audit fixture.\nThis file belongs only to the isolated QA workspace.\n' },
  missing: false, path: 'audit-note.txt', source: { branchId: 'source:audit', revision: 0 },
};

function history(data: JsonValue, outcome: Outcome = 'succeeded', name = 'file_read', args: JsonValue = { path: 'audit-note.txt' }): ThreadHistoryItem[] {
  return [
    { id: 'history:call', parent: null, thread_id: 'thread:audit', run_id: 'run:audit', source: 'assistant', provider: null,
      content: { id: 'model-item:7:request:read', content: { kind: 'tool_call', call: { call_id: 'read', name, schema_version: '1', arguments: args } } } },
    { id: 'history:result', parent: 'history:call', thread_id: 'thread:audit', run_id: 'run:audit', source: 'tool', provider: null,
      content: { content: { kind: 'tool_result', result: { request_id: 'request', call_id: 'read',
        completion: { kind: 'result', outcome, effect: 'none', content: { data, parts: [] } } } } } },
  ];
}

let root: Root;
let container: HTMLDivElement;
const fixtureFetch = vi.fn<typeof fetch>(() => { throw new Error('Tool result previews must not fetch remote resources'); });
beforeEach(() => {
  fixtureFetch.mockClear();
  vi.stubGlobal('fetch', fixtureFetch);
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  for (const [name, value] of Object.entries({ document, window, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value);
  useUIStore.setState({ chatRenderMode: 'live' });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => {
  try {
    act(() => root.unmount());
    expect(fixtureFetch).not.toHaveBeenCalled();
  } finally {
    container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});

async function render(data: JsonValue, outcome?: Outcome, name?: string, args?: JsonValue) {
  const projected = new HistoryPresentation('audit').project(history(data, outcome, name, args), undefined);
  const presentation: ConversationPresentation = { identity: { runtime: 'agent', threadId: 'thread:audit', branchId: 'branch:audit' },
    head: 'history:result', toolExecutions: projected.toolExecutions, api: { materials: {} } as ConversationPresentation['api'], quote() {},
    openFile: async () => { throw new Error('File navigation must retain its separate source owner'); },
    fileTarget: async () => { throw new Error('File navigation must retain its separate source owner'); } };
  await act(async () => root.render(<ConversationContext.Provider value={presentation}>
    <ChatTimelineEntryList cwd="/isolated-audit" entries={projected.entries} sessionId="audit" toolExecutions={projected.toolExecutions} />
  </ConversationContext.Provider>));
  // Expanded output is mounted on demand, including the original receipt.
  const opened = new Set<Element>();
  for (;;) {
    const next = [...container.querySelectorAll<HTMLDetailsElement>('[data-conversation-tool-disclosure]')].find(node => !opened.has(node));
    if (!next) break;
    opened.add(next);
    await act(async () => { next.open = true; next.dispatchEvent(new window.Event('toggle')); });
  }
  return container.querySelector<HTMLElement>('section[aria-label="File contents: audit-note.txt"]');
}

it.each(['live', 'dialogue', 'sorted'] as const)('shows image receipts outside folded activity and reads original media on expansion in %s mode', async mode => {
  useUIStore.setState({ chatRenderMode: mode });
  const media = { media_type: 'image/png', source: { kind: 'operation', operation_id: 'capture' }, content_ref: { content_object: 'sha256-image' } } as const;
  const items = history({}, 'succeeded', 'script_run', { script: 'emitImage(image)' });
  items[1]!.content = { content: { kind: 'tool_result', result: { request_id: 'request', call_id: 'read',
    completion: { kind: 'result', outcome: 'succeeded', effect: 'none', content: { data: {}, parts: [
      { kind: 'text', text: 'Read two images' }, { kind: 'media', media },
      { kind: 'text', text: 'Second image' }, { kind: 'media', media },
    ] } } } } };
  const projected = new HistoryPresentation('images').project(items, undefined);
  const receipt = projected.entries.find(entry => entry.type === 'message' && entry.message.role === 'toolResult');
  if (receipt?.type !== 'message' || receipt.message.role !== 'toolResult') throw new Error('Missing receipt');
  expect(viewedImages('script_run', receipt.message)).toHaveLength(2);
  expect(viewedImages('image_generate', receipt.message)).toEqual([]);
  const mediaRead = vi.fn(async (input: { partIndex: number; chunkIndex: number }) => ({ media,
    partIndex: input.partIndex, chunkIndex: input.chunkIndex, chunkCount: 1, totalBytes: 3, bytesBase64: 'AQID' }));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:observed-image');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const presentation: ConversationPresentation = { identity: { runtime: 'agent', threadId: 'thread:audit', branchId: 'branch:audit' },
    head: 'history:result', toolExecutions: projected.toolExecutions, api: { mediaRead } as unknown as ConversationPresentation['api'], quote() {},
    openFile: async () => { throw new Error('Not a file navigation'); },
    fileTarget: async () => { throw new Error('Not a file navigation'); } };
  await act(async () => root.render(<ConversationContext.Provider value={presentation}>
    <ChatTimelineEntryList cwd="/audit" entries={projected.entries} sessionId={`images:${mode}`} toolExecutions={projected.toolExecutions} />
  </ConversationContext.Provider>));
  const row = container.querySelector<HTMLDetailsElement>('.tool-viewed-images')!;
  expect(row.querySelector('summary')?.textContent).toContain('Images viewed: 2');
  expect(row.open).toBeFalsy(); expect(container.querySelector('img')).toBeNull();
  expect(mediaRead).not.toHaveBeenCalled();
  await act(async () => { row.open = true; row.dispatchEvent(new window.Event('toggle')); });
  expect(container.querySelectorAll('.tool-viewed-image img')).toHaveLength(2);
  expect(mediaRead.mock.calls.map(([input]) => input)).toEqual([1, 3].map(partIndex => ({ ...presentation.identity,
    holder: { kind: 'history', itemId: 'history:result' }, partIndex, chunkIndex: 0, expectedContentRef: 'sha256-image' })));
  expect(row.querySelector('[data-conversation-tool-disclosure^="image-details:"]')).not.toBeNull();
  expect(container.textContent).not.toContain('emitImage(image)');
});

it('renders the native file body as readable text while retaining original arguments and details', async () => {
  const reader = await render(auditRead);
  expect(reader?.querySelector('code')?.textContent).toBe(auditRead.content.text);
  expect(reader?.textContent).toContain('Read 92 of 92 bytes · offset 0');
  const tool = container.querySelector('[data-conversation-tool-disclosure]')!;
  expect(tool.textContent).toContain('Original input');
  const raw = [...tool.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === 'Original result');
  expect(raw?.querySelector('pre')?.textContent).toBe(JSON.stringify(auditRead, null, 2));
  const summary = tool.querySelector('summary')?.textContent;
  expect(summary).toContain('Read file');
  expect(summary).toContain('audit-note.txt');
  // Ordinary success is represented by the receipt, not a repeated status badge.
  expect(summary).not.toContain('Completed');
});

it('keeps file text literal, including HTML, Markdown, whitespace and long lines', async () => {
  const text = '<img src=x onerror="alert(1)">\n# title\n    indentation\n' + 'x'.repeat(800) + '\n';
  const reader = await render({ ...auditRead, content: { byteLength: text.length, offset: 0, nextOffset: text.length, eof: true, text } });
  expect(reader?.querySelector('code')?.textContent).toBe(text);
  expect(reader?.querySelector('img,h1')).toBeNull();
  expect(reader?.querySelector('pre')?.getAttribute('tabindex')).toBe('0');
});

it('distinguishes an empty file, an empty range, a missing path, and non-text bytes', async () => {
  let reader = await render({ ...auditRead, content: { byteLength: 0, offset: 0, nextOffset: 0, eof: true, text: '' } });
  expect(reader?.textContent).toContain('Empty file');
  reader = await render({ ...auditRead, content: { byteLength: 92, offset: 10, nextOffset: 10, eof: false, text: '' } });
  expect(reader?.textContent).toContain('No bytes returned for this range.');
  expect(reader?.textContent).toContain('Partial file');
  reader = await render({ path: auditRead.path, missing: true, source: auditRead.source });
  expect(reader?.textContent).toContain('File not found.');
  expect(reader?.textContent).not.toContain('Empty file');
  reader = await render({ ...auditRead, content: { byteLength: 2, offset: 0, nextOffset: 2, eof: true, bytesBase64: '/wA=' } });
  expect(reader?.textContent).toContain('This byte range is not UTF-8 text.');
  expect(reader?.querySelector('code,img')).toBeNull();
});

it('shows partial byte ranges without claiming they are the whole file or inventing line numbers', async () => {
  const reader = await render({ ...auditRead, content: { byteLength: 100, offset: 92, nextOffset: 100, eof: true, text: 'last row' } });
  expect(reader?.textContent).toContain('Read 8 of 100 bytes · offset 92');
  expect(reader?.textContent).toContain('Partial file');
  expect(reader?.querySelector('code')?.textContent).toBe('last row');
});

it.each([
  [{ kind: 'directory', mode: 493 }, 'This path is a directory.'],
  [{ kind: 'symlink', symlinkTarget: '../actual.txt', mode: 511 }, 'Symbolic link → ../actual.txt'],
  [{ kind: 'unsupported' }, 'This path has no supported file contents.'],
] as const)('renders resource states without presenting them as empty files: %j', async (state, message) => {
  const reader = await render({ path: auditRead.path, source: auditRead.source, missing: false, state });
  expect(reader?.textContent).toContain(message);
  expect(reader?.querySelector('code')).toBeNull();
});

it.each([
  ['failed', 'Failed'], ['cancelled', 'Cancelled'], ['indeterminate', 'Outcome unknown'],
] as const)('preserves the native %s outcome and exposes structured diagnostics', async (outcome, label) => {
  const reader = await render({ error: 'source_unavailable', message: 'The original source is unavailable.' }, outcome);
  expect(reader).toBeNull();
  const tool = container.querySelector('[data-conversation-tool-disclosure]')!;
  expect(tool.querySelector('summary')?.textContent).toContain(label);
  expect([...tool.querySelectorAll('p')].some(node => node.textContent === 'The original source is unavailable.')).toBe(true);
  expect(await render(auditRead, outcome)).toBeNull();
});

it('keeps unsupported or malformed data inspectable without guessing a file or media preview', async () => {
  expect(await render(auditRead, 'succeeded', 'custom_read')).toBeNull();
  expect(await render({ ...auditRead, content: { ...auditRead.content, nextOffset: 200 } })).toBeNull();
  expect(await render({ ...auditRead, missing: null })).toBeNull();
  expect(await render({ content: [{ type: 'text', text: 'obsolete envelope' }] })).toBeNull();
  expect(container.textContent).toContain('obsolete envelope');
});

it('renders nested tool data as inspectable JSON rather than React children', async () => {
  const data = { todos: [{ content: { TODO: 'Review the diff' }, status: { unexpected: true } }], values: [null, 0, false] };
  expect(await render(data, 'succeeded', 'custom_todos')).toBeNull();
  const tool = container.querySelector('[data-conversation-tool-disclosure]')!;
  const details = [...tool.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === 'details');
  expect(details?.querySelector('pre')?.textContent).toBe(JSON.stringify(data, null, 2));
});

it('compares actual Office readback and retains document dirty state after export', async () => {
  await act(async () => root.render(<OfficeGrid values={[[11800, '新的说明']]} before={[[12800, '旧说明']]} range="C3:D3" />));
  expect(container.querySelector('tbody th')?.textContent).toBe('3');
  const compare = [...container.querySelectorAll('button')].find(button => button.textContent === 'Compare before')!;
  await act(async () => compare.click());
  expect(container.querySelector('tbody')?.textContent).toContain('12800');
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Show changes')!.click());
  expect(container.querySelector('tbody')?.textContent).toContain('11800');
  await render({ desktopId: 'original-desktop', result: { ok: true, modified: true, target: 'file:///reports/budget.pdf' } }, 'succeeded', 'computer_office', { op: 'act', act: { kind: 'export', path: '/reports/budget.pdf' } });
  expect(container.textContent).toContain('Unsaved changes');
  expect(container.textContent).toContain('Document exported');
  expect(container.textContent).not.toContain('Document saved');
});

it('keeps long question choices intact and waits for explicit submission', async () => {
  const answer = vi.fn(async () => operation), option = '保留所有原始记录，并在报告中逐项解释原因。'.repeat(12) + '\n包含每个失败任务的处理建议。';
  const operation = { id: 'question', phase: 'waiting', intent: { call: { arguments: { questions: [{ id: 'question', question: '选择报告范围', options: [option, '只列摘要'].map((label,index) => ({ id: String(index), label })) }] } } } } as unknown as import('@varin/protocol').Operation;
  await act(async () => root.render(<ThreadQuestion scopeKey="preview-question" operation={operation} enabled onAnswer={answer} onRead={async () => operation} onCancel={async () => operation} />));
  const choices = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
  expect(choices).toHaveLength(2);
  expect(choices[0]!.parentElement?.textContent).toBe(option);
  await act(async () => { choices[0]!.click(); choices[0]!.dispatchEvent(new window.Event('change', { bubbles: true })); });
  expect(answer).not.toHaveBeenCalled();
  // React's native radio event path is browser-owned; retain a DOM-level assertion here.
  expect(container.querySelector('form')?.querySelectorAll('button[type="submit"]')).toHaveLength(1);
});

it('opens the retained material in the space-reserving panel with its original conversation identity', async () => {
  await render({ status: 'ok', collection: { collectionId: 'collection:one', name: 'Source notes', persisted: false, createdAt: 0, updatedAt: 0,
    members: [{ memberId: 'member:one', kind: 'snapshot', snapshotId: 'snapshot:original', title: 'Original evidence', addedAt: 0 }] } }, 'succeeded', 'materials');
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Original evidence'))!.click());
  const panel = useUIStore.getState().contextPanelByDirectory['/isolated-audit'];
  expect(panel?.isOpen).toBe(true);
  expect(panel?.tabs.find(tab => tab.id === panel.activeTabId)).toMatchObject({ mode: 'material', targetPath: 'snapshot:original', thread: { threadId: 'thread:audit', branchId: 'branch:audit' } });
});
