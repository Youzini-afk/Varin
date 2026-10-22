import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ThreadHistoryItem } from '@varin/application-client';
import type { JsonValue } from '@varin/protocol';
import { dict } from '@/lib/i18n/messages/en';
import { useUIStore } from '@/stores/useUIStore';
import { ChatTimelineEntryList } from './ChatTimelineEntries';
import { HistoryPresentation } from './historyPresentation';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof dict, params?: Record<string, unknown>) =>
  (dict[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? name)) }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));
vi.mock('@/lib/extensions/workbench-registry', () => ({ useWorkbenchMatchRenderers: () => [], renderFirstWorkbenchMatch: () => undefined }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  for (const [name, value] of Object.entries({ document, window, HTMLElement: window.HTMLElement, Element: window.Element,
    Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value);
  useUIStore.setState({ chatRenderMode: 'live', showExpandedBashTools: false });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function call(id: string, name: string, args: JsonValue, data?: JsonValue): ThreadHistoryItem[] {
  const base = { thread_id: 'thread', run_id: 'run', provider: null };
  return [{ ...base, id: id + ':call', parent: null, source: 'assistant', content: { id: 'model-item:7:request:' + id,
    content: { kind: 'tool_call', call: { call_id: id, name, schema_version: '1', arguments: args } } } },
  ...(data === undefined ? [] : [{ ...base, id: id + ':result', parent: id + ':call', source: 'tool' as const, content: {
    content: { kind: 'tool_result', result: { request_id: 'request', call_id: id, completion: {
      kind: 'result', outcome: 'succeeded', effect: 'none', content: { data, parts: [] },
    } } },
  } }])];
}
async function render(history: ThreadHistoryItem[], sessionId = 'headings') {
  const projection = new HistoryPresentation(sessionId).project(history, undefined);
  await act(async () => root.render(<ChatTimelineEntryList cwd="/workspace" sessionId={sessionId}
    entries={projection.entries} toolExecutions={projection.toolExecutions} />));
}
const summaries = () => [...container.querySelectorAll<HTMLDetailsElement>('details[data-conversation-tool-disclosure^="tool:"]')]
  .map(node => ({ open: node.open, text: node.querySelector('summary')!.textContent! }));

it('shows the target, actual input and returned state before opening native process calls', async () => {
  const processId = 'request:tool:spawn';
  await render([
    ...call('spawn', 'process_spawn', { command: 'python', args: ['-i'], cwd: '/workspace', mode: 'pty' }),
    ...call('input', 'process_write', { processId, text: '2+2\n' }, { requestedBytes: 4, confirmedBytes: 4, eofApplied: false }),
    ...call('inspect', 'process_inspect', { processId }, { processId, pid: 1234, status: 'running', exitCode: null }),
    ...call('enter', 'process_write', { processId, text: '\n' }, { requestedBytes: 1, confirmedBytes: 1 }),
    ...call('read', 'process_read', { processId, cursor: 0 }, { process: { processId, status: 'running' },
      chunks: [{ channel: 'stdout', offset: 0, text: '4\nready\n', bytesBase64: 'NApyZWFkeQo=' }], nextCursor: 8 }),
  ]);
  const rows = summaries();
  expect(rows.every(row => !row.open)).toBe(true);
  expect(rows[1]?.text).toContain('python -i'); expect(rows[1]?.text).toContain('2+2 ↵'); expect(rows[1]?.text).toContain('4 B confirmed');
  expect(rows[2]?.text).toContain('python -i'); expect(rows[2]?.text).toContain(dict['chat.timeline.tools.running']);
  expect(rows[3]?.text).toContain('↵'); expect(rows[4]?.text).toContain('2 output lines');
  expect(container.querySelector('.tool-process-console')).toBeNull();
});

it('uses a returned PID when its spawn is outside loaded history and does not label binary output as empty', async () => {
  await render(call('read', 'process_read', { processId: 'unloaded:process', cursor: 0 }, {
    process: { processId: 'unloaded:process', pid: 4567, status: 'exited', exitCode: 2 },
    chunks: [{ channel: 'stdout', offset: 0, bytesBase64: 'AA==' }],
  }), 'another-thread');
  expect(summaries()[0]?.text).toContain('PID 4567');
  expect(summaries()[0]?.text).not.toContain('python');
  expect(summaries()[0]?.text).not.toContain('0 output lines');
  expect(summaries()[0]?.text).toContain('2');
});

it('resolves a disclosed process by its target operation, rather than the gateway call ID', async () => {
  await render([
    ...call('gateway', 'tool_invoke', { reference: { name: 'process_spawn', version: '1' },
      arguments: { command: 'node', args: ['server.js'], cwd: '/workspace', mode: 'pipe' } },
    { reference: { name: 'process_spawn', version: '1' }, operationId: 'native-process', completion: { kind: 'job_accepted' }, result: {} }),
    ...call('inspect', 'process_inspect', { processId: 'native-process' }, { processId: 'native-process', status: 'running' }),
  ]);
  expect(summaries()[1]?.text).toContain('node server.js');
});

it('summarizes real work targets without presenting requested changes as completed results', async () => {
  await render([
    ...call('settings', 'settings_update', { id: 'chat.reasoning', set: { collapsibleThinkingBlocks: false }, expectedRevision: 2 }),
    ...call('restore', 'file_restore', { point: 'checkpoint-7', paths: ['src/app.ts'] }),
    ...call('describe', 'tool_describe', { namespace: 'browser' }),
    ...call('resource', 'resource_read', { kind: 'skill-resource', resourceId: 'design', relativePath: 'references/layout.md' }),
  ]);
  const rows = summaries();
  expect(rows[0]?.text).toContain('chat.reasoning'); expect(rows[0]?.text).toContain('collapsibleThinkingBlocks');
  expect(rows[1]?.text).toContain('src/app.ts'); expect(rows[1]?.text).toContain('checkpoint-7');
  expect(rows[1]?.text).not.toContain('files restored');
  expect(rows[2]?.text).toContain('browser'); expect(rows[3]?.text).toContain('references/layout.md');
});

it('includes the requested computer action, document range and MCP query in their headings', async () => {
  await render([
    ...call('office', 'computer_office', { op: 'act', act: { kind: 'write', doc: 'Budget.ods', sheet: 'Forecast', range: 'B2:D8', values: [[1]] } }),
    ...call('browser', 'computer_browser', { op: 'act', act: { kind: 'navigate', url: 'https://example.com/docs' } }),
    ...call('mcp', 'mcp__github__search_issues', { owner: 'varin', repo: 'desktop', query: 'is:open label:bug', token: 'never-promote-secrets' }),
  ]);
  const headings = [...container.querySelectorAll('.tool-artifact-heading, .tool-service-byline')].map(node => node.textContent!);
  expect(headings[0]).toContain('Write'); expect(headings[0]).toContain('Budget.ods'); expect(headings[0]).toContain('B2:D8');
  expect(headings[1]).toContain('Navigate'); expect(headings[1]).toContain('https://example.com/docs');
  expect(headings[2]).toContain('varin/desktop'); expect(headings[2]).toContain('is:open label:bug');
  expect(headings[2]).not.toContain('never-promote-secrets');
});
