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

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof dict, params?: Record<string, unknown>) =>
  (dict[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? name)) }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));
vi.mock('@/lib/extensions/workbench-registry', () => ({ useWorkbenchMatchRenderers: () => [], renderFirstWorkbenchMatch: () => undefined }));

// The isolated Rust audit's FixedBranch read returned data with no OutputBody
// text parts. Keep that owner envelope intact through the history consumer.
const auditRead = {
  content: { byteLength: 92, eof: true, hash: 'sha256-audit', nextOffset: 92, offset: 0,
    text: 'Varin native runtime UI audit fixture.\nThis file belongs only to the isolated QA workspace.\n' },
  missing: false, path: 'audit-note.txt', source: { branchId: 'source:audit', revision: 0 },
};

function history(data: JsonValue, outcome: Outcome = 'succeeded', name = 'file_read'): ThreadHistoryItem[] {
  return [
    { id: 'history:call', parent: null, thread_id: 'thread:audit', run_id: 'run:audit', source: 'assistant', provider: null,
      content: { id: 'model-item:7:request:read', content: { kind: 'tool_call', call: { call_id: 'read', name, schema_version: '1', arguments: { path: 'audit-note.txt' } } } } },
    { id: 'history:result', parent: 'history:call', thread_id: 'thread:audit', run_id: 'run:audit', source: 'tool', provider: null,
      content: { content: { kind: 'tool_result', result: { request_id: 'request', call_id: 'read',
        completion: { kind: 'result', outcome, effect: 'none', content: { data, parts: [] } } } } } },
  ];
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  for (const [name, value] of Object.entries({ document, window, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value);
  useUIStore.setState({ chatRenderMode: 'live' });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function render(data: JsonValue, outcome?: Outcome, name?: string) {
  const projected = new HistoryPresentation('audit').project(history(data, outcome, name), undefined);
  const presentation: ConversationPresentation = { identity: { runtime: 'agent', threadId: 'thread:audit', branchId: 'branch:audit' },
    head: 'history:result', toolExecutions: projected.toolExecutions, api: {} as ConversationPresentation['api'], quote() {},
    openFile: async () => { throw new Error('File navigation must retain its separate source owner'); },
    fileTarget: async () => { throw new Error('File navigation must retain its separate source owner'); } };
  await act(async () => root.render(<ConversationContext.Provider value={presentation}>
    <ChatTimelineEntryList cwd="/isolated-audit" entries={projected.entries} sessionId="audit" toolExecutions={projected.toolExecutions} />
  </ConversationContext.Provider>));
  return container.querySelector<HTMLElement>('section[aria-label="File contents: audit-note.txt"]');
}

it('renders the native file body as readable text while retaining original arguments and details', async () => {
  const reader = await render(auditRead);
  expect(reader?.querySelector('code')?.textContent).toBe(auditRead.content.text);
  expect(reader?.textContent).toContain('Read 92 of 92 bytes · offset 0');
  const tool = container.querySelector('[data-conversation-tool-disclosure]')!;
  expect(tool.textContent).toContain('arguments');
  const raw = [...tool.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === 'details');
  expect(raw?.querySelector('pre')?.textContent).toBe(JSON.stringify(auditRead, null, 2));
  expect(tool.querySelector('summary')?.textContent).toContain('audit-note.txt');
  expect(tool.querySelector('summary')?.textContent).toContain('Completed');
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
