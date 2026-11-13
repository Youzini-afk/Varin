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
  .map(node => ({ open: node.hasAttribute('open'), text: node.querySelector('summary')!.textContent! }));

it.each(['dialogue', 'sorted', 'live'] as const)('keeps source work scannable in %s and preserves an explicit expansion', async mode => {
  useUIStore.setState({ chatRenderMode: mode, activityRenderMode: 'summary' });
  const history = [
    ...call('sources', 'websearch', { queries: ['terminal input'] }, { items: [{ results: [
      { title: 'A useful source', url: 'https://example.com/guide', snippet: 'A short excerpt helps choose a source.', contentKind: 'provider-excerpt' },
      { summary: 'An answer without title or URL.', contentKind: 'generated-answer' },
    ] }] }),
    ...call('page', 'webfetch', { url: 'https://example.com/notes' }, { markdown: 'Readable page body without paper metadata.' }),
  ];
  await render(history, 'sources-' + mode);
  const activity = container.querySelector<HTMLDetailsElement>('.dialogue-activity');
  if (activity) await act(async () => { activity.open = true; activity.dispatchEvent(new window.Event('toggle')); });
  expect(summaries()[0]?.text).toContain('terminal input');
  expect(summaries()[0]?.text).toContain('2 entries');
  expect(summaries()[0]?.open).toBe(mode === 'live');
  if (mode !== 'live') expect(container.textContent).not.toContain('A useful source');
  const source = container.querySelector<HTMLDetailsElement>('details[data-conversation-tool-disclosure^="tool:"]')!;
  await act(async () => { source.open = true; source.dispatchEvent(new window.Event('toggle')); });
  expect(container.textContent).toContain('A short excerpt helps choose a source.');
  expect(container.textContent).toContain('An answer without title or URL.');
  expect(container.textContent).not.toContain(dict['chat.tools.sourceExcerpt']);
  const page = container.querySelectorAll<HTMLDetailsElement>('details[data-conversation-tool-disclosure^="tool:"]')[1]!;
  await act(async () => { page.open = true; page.dispatchEvent(new window.Event('toggle')); });
  expect(container.textContent).toContain('Readable page body without paper metadata.');
  await act(async () => { source.open = false; source.dispatchEvent(new window.Event('toggle')); });
  await render([], 'sources-' + mode);
  await render(history, 'sources-' + mode);
  expect(summaries()[0]?.open).toBe(false);
  expect(summaries()[1]?.open).toBe(true);
});

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

it('renders complete history bodies and the actual restored file change', async () => {
  await render([
    ...call('history', 'read_thread', { query: { kind: 'recent' } }, { page: { items: [{ id: 'entry', source: 'assistant', kind: 'text', body: { text: 'Retained report body' }, bodyTruncated: false }] } }),
    ...call('restore', 'file_restore', { point: 'current:before' }, { status: 'applied', files: [{ path: 'new.txt', status: 'applied', change: 'deleted' }], appliedPaths: ['new.txt'], conflictPaths: [] }),
  ]);
  await act(async () => {
    const history = container.querySelector<HTMLDetailsElement>('details[data-conversation-tool-disclosure^="tool:"]')!;
    history.open = true; history.dispatchEvent(new window.Event('toggle'));
  });
  expect(container.textContent).toContain('Retained report body');
  expect(container.textContent).toContain(dict['diffView.change.deleted']);
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

const observeControls: Record<string, JsonValue> = {
  id: 'original-observation', desktopId: 'original-desktop', machineId: 'original-host',
  app: { name: 'Preferences', pid: 12 }, windowTitle: 'Preferences', capturedAt: '2026-11-14T01:00:00Z',
  treeLines: ['Duplicate text projection must not be rendered beside structured controls'],
  elements: [
    { index: 4, role: 'group', name: 'Autosave options', hasMoreChildren: true },
    { index: 12, parentIndex: 4, role: 'checkbox', name: 'Autosave', checked: 'mixed', enabled: true },
    { index: 19, parentIndex: 4, role: 'listitem', name: 'Daily', selected: false },
  ],
};
async function openComputerObservation() {
  const disclosure = container.querySelector<HTMLDetailsElement>('[data-conversation-tool-disclosure^="computer-observation:"]')!;
  expect(disclosure).not.toBeNull();
  await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new window.Event('toggle')); });
  return disclosure;
}

it('folds a partial control query, keeps actual state and hierarchy, and never duplicates the tree projection', async () => {
  await render(call('query', 'computer_query', { app: 'Preferences', match: { name: 'Autosave' } }, {
    observation: observeControls, complete: false, nextOffset: 3,
  }), 'semantic-query');
  expect(container.querySelectorAll('.tool-computer-event')).toHaveLength(1);
  expect(container.querySelector('.tool-heading-receipt')?.textContent).toBe('3 matches returned · Search incomplete');
  expect(container.textContent).toContain(dict['chat.tools.computer.incomplete']);
  expect(container.querySelector('[data-computer-element]')).toBeNull();
  expect(container.querySelector('img')).toBeNull();
  const detail = await openComputerObservation();
  expect(detail.querySelectorAll('[data-computer-element]')).toHaveLength(3);
  expect(detail.querySelector('[data-computer-element="12"]')?.getAttribute('style')).toContain('padding-inline-start:1rem');
  expect(detail.querySelector('[data-computer-element="12"]')?.textContent).toContain('Checked: Mixed');
  expect(detail.querySelector('[data-computer-element="19"]')?.textContent).toContain('Selected: No');
  expect(detail.textContent).toContain(dict['chat.tools.computer.moreChildren']);
  expect(detail.textContent).not.toContain('Duplicate text projection');
  await act(async () => { detail.open = false; detail.dispatchEvent(new window.Event('toggle')); });
  await render(call('query', 'computer_query', { app: 'Preferences', match: { name: 'Autosave' } }, {
    complete: false, status: 'unavailable', reason: 'Application no longer exposes controls',
  }), 'semantic-query');
  expect(container.querySelector('.tool-heading-receipt')?.textContent).toBe(dict['chat.tools.computer.unavailable']);
  expect(container.querySelector('[data-computer-element]')).toBeNull();
  expect(container.textContent).not.toContain('3 matches');
});

it('does not turn missing or unavailable control properties into false', async () => {
  await render(call('properties', 'computer_query', {
    target: { observationId: 'obs:retained', elementIndex: 12 }, properties: ['checked', 'selected', 'enabled', 'expanded'],
  }, { properties: { checked: 'mixed', selected: false }, unavailableProperties: ['enabled'], complete: true }), 'semantic-properties');
  expect(container.querySelector('.tool-heading-receipt')?.textContent).toContain('Checked: Mixed');
  const detail = await openComputerObservation();
  expect(detail.querySelector('[data-computer-property="selected"]')?.textContent).toBe('Selected: No');
  expect(detail.querySelector('[data-computer-property="enabled"]')?.textContent).toBe('Enabled: Unavailable');
  expect(detail.querySelector('[data-computer-property="expanded"]')?.textContent).toBe('Expanded: Unknown');
});

it('uses observed selection rather than requested selection and keeps input mechanism secondary', async () => {
  await render(call('select', 'computer_act', { action: { kind: 'select', elementIndex: 19, selection: 'add' } }, {
    result: { accepted: true, inputWriterStopped: true,
      receipt: { effect: 'dispatched', mechanism: 'accessibility', observedState: { name: 'Daily', selected: false } } },
  }), 'semantic-selection');
  const heading = container.querySelector('.tool-artifact-heading')!.textContent!;
  expect(heading).toContain('Add to selection'); expect(heading).toContain('Daily');
  expect(heading).toContain(dict['chat.tools.computer.dispatched']); expect(heading).toContain('Selected: No');
  expect(heading).not.toContain('Selected: Yes'); expect(heading).not.toContain('accessibility');
  const mechanism = container.querySelector<HTMLDetailsElement>('[data-conversation-tool-disclosure^="computer-mechanism:"]')!;
  expect(mechanism.hasAttribute('open')).toBe(false);
  await act(async () => { mechanism.open = true; mechanism.dispatchEvent(new window.Event('toggle')); });
  expect(mechanism.textContent).toContain('Control action');
  expect(container.querySelectorAll('.tool-computer-event')).toHaveLength(1);
});

it('distinguishes an already-satisfied state from an unconfirmed input outcome without offering replay', async () => {
  const args = { action: { kind: 'set_checked', checked: true, elementIndex: 12 } };
  await render(call('check', 'computer_act', args, { result: { accepted: true, inputWriterStopped: true,
    receipt: { effect: 'none', observedState: { checked: true } } } }), 'semantic-check');
  expect(container.querySelector('.tool-heading-receipt')?.textContent).toContain(dict['chat.tools.computer.alreadySet']);
  await render(call('check', 'computer_act', args, { result: { accepted: false, inputWriterStopped: false,
    receipt: { effect: 'unknown', reason: { code: 'connection-lost', message: 'Reply lost after input submission' } } } }), 'semantic-check');
  expect(container.querySelector('.tool-heading-receipt')?.textContent).toBe(dict['chat.tools.computer.unknown']);
  expect(container.textContent).toContain(dict['chat.tools.computer.writerUnconfirmed']);
  expect(container.textContent).toContain('Reply lost after input submission');
  expect(container.textContent).not.toContain(dict['chat.tools.computer.alreadySet']);
  expect([...container.querySelectorAll('button')].some(button => /retry|repeat/i.test(button.textContent!))).toBe(false);
});

it.each([
  ['satisfied', 'chat.tools.computer.satisfied'], ['timed_out', 'chat.tools.computer.timedOut'],
  ['cancelled', 'chat.tools.computer.cancelled'], ['target_lost', 'chat.tools.computer.targetLost'],
  ['unavailable', 'chat.tools.computer.unavailable'],
] as const)('shows the actual %s wait outcome even when the tool call completed normally', async (status, key) => {
  await render(call('await', 'computer_await', {
    app: 'Preferences', target: { observationId: 'obs:retained', elementIndex: 12 }, condition: 'property', property: 'checked', equals: true,
  }, { status, condition: 'property', elapsedMs: 1250, last: { properties: { checked: false }, complete: true } }), 'semantic-await-' + status);
  expect(container.querySelector('.tool-heading-receipt')?.textContent).toBe(dict[key]);
  expect(container.textContent).toContain('1.25 s elapsed');
  const last = await openComputerObservation();
  expect(last.querySelector('summary')?.textContent).toBe(dict['chat.tools.computer.lastObserved']);
  expect(last.querySelector('[data-computer-property="checked"]')?.textContent).toBe('Checked: No');
  expect(container.querySelectorAll('.tool-computer-event')).toHaveLength(1);
});

it('keeps an incomplete observation warning visible before opening its structured tree', async () => {
  await render(call('observe', 'computer_observe', { app: 'Preferences', view: 'outline' }, {
    observation: { ...observeControls, complete: false, truncatedReason: 'Provider reached its requested traversal depth' },
  }), 'semantic-observe');
  expect(container.textContent).toContain(dict['chat.tools.computer.incomplete']);
  expect(container.textContent).toContain('Provider reached its requested traversal depth');
  expect(container.querySelector('[data-computer-element]')).toBeNull();
});

it('keeps the last actual computer outcome in the sorted compact activity', async () => {
  useUIStore.setState({ chatRenderMode: 'sorted', activityRenderMode: 'summary' });
  await render([
    ...call('query', 'computer_query', { app: 'Preferences', match: { name: 'Save complete' } }, {
      complete: true, observation: { ...observeControls, elements: [] },
    }),
    ...call('await', 'computer_await', { app: 'Preferences', match: { name: 'Save complete' }, condition: 'present' }, {
      status: 'timed_out', condition: 'present', elapsedMs: 1000,
    }),
  ], 'semantic-sorted');
  const summary = container.querySelector('[data-conversation-sorted-activity] > button')!;
  expect(summary.textContent).toContain(dict['chat.tools.computer.timedOut']);
  expect(summary.textContent).toContain('Save complete');
});

it('does not identify an action target by reusing its old index in a new observation', async () => {
  await render(call('act', 'computer_act', {
    action: { kind: 'set_checked', observationId: 'old-observation', elementIndex: 12, checked: true },
  }, { result: { accepted: true, inputWriterStopped: true, receipt: { effect: 'dispatched' },
    observation: { ...observeControls, id: 'new-observation', elements: [{ index: 12, name: 'Different control', role: 'checkbox' }] },
  } }), 'semantic-renumber');
  const subject = container.querySelector('.tool-heading-subject')!.textContent!;
  expect(subject).toContain('#12');
  expect(subject).not.toContain('Different control');
});

it('distinguishes a returned result page from an incomplete native search', async () => {
  await render(call('page', 'computer_query', { app: 'Preferences', match: { role: 'checkbox' }, offset: 3 }, {
    complete: true, nextOffset: 6, observation: observeControls,
  }), 'semantic-query-page');
  expect(container.querySelector('.tool-heading-receipt')?.textContent).toBe('3 matches in this result page');
  expect(container.textContent).toContain(dict['chat.tools.partialResult']);
  expect(container.textContent).not.toContain(dict['chat.tools.computer.incomplete']);
});

it('does not infer exclusive replacement from one selected option', async () => {
  await render(call('replace-selection', 'computer_act', { action: { kind: 'select', elementIndex: 19, selection: 'replace' } }, {
    result: { accepted: true, inputWriterStopped: true, receipt: { effect: 'none', observedState: { name: 'Daily', selected: true } } },
  }), 'semantic-exclusive-selection');
  expect(container.querySelector('.tool-heading-receipt')?.textContent).toContain(dict['chat.tools.computer.noInput']);
  expect(container.querySelector('.tool-heading-receipt')?.textContent).toContain('Selected: Yes');
  expect(container.textContent).not.toContain(dict['chat.tools.computer.alreadySet']);
});

it('does not render requested properties as an observation before the read returns', async () => {
  await render(call('pending-properties', 'computer_query', {
    target: { observationId: 'obs:retained', elementIndex: 12 }, properties: ['checked', 'selected'],
  }), 'semantic-pending-properties');
  expect(container.querySelector('[data-conversation-tool-disclosure^="computer-observation:"]')).toBeNull();
  expect(container.querySelector('.tool-heading-receipt')).toBeNull();
});
