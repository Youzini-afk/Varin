import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import type { OperationCallSummary, Operation } from '@varin/protocol';
import { I18nProvider } from '@/lib/i18n';
import { ConversationContext, type ConversationPresentation } from './ConversationContext';
import { ChatScriptCard } from './ChatScriptCard';
import { HistoryPresentation } from './historyPresentation';
import type { ThreadHistoryItem, ThreadSnapshot } from '@varin/application-client';
import type { ChatToolCall } from './types';
import { orderScriptCalls } from './scriptPresentation';

it('presents a disclosed script action once, using the actual target operation', () => {
  const common = { phase: 'terminal', outcome: 'succeeded', effect: 'none', cancelRequested: false } as const;
  expect(orderScriptCalls([
    { ...common, operationId: 'gateway', parentOperationId: 'script', name: 'tool_invoke', depth: 0 },
    { ...common, operationId: 'target', parentOperationId: 'gateway', name: 'file_read', depth: 1 },
  ])).toEqual([{ ...common, operationId: 'target', parentOperationId: 'gateway', name: 'file_read', depth: 0 }]);
});

afterEach(() => vi.unstubAllGlobals());
it('shows task intent, retained call failures and on-demand output without executing the displayed script', async () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  for (const [key, value] of Object.entries({ window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(key, value);
  const container = window.document.getElementById('root')!; const root = createRoot(container);
  const call: ChatToolCall = { type: 'toolCall', id: JSON.stringify(['run', 'request', 'script']), name: 'script_run',
    arguments: { environmentId: 'original-environment', title: 'Inspect directory exclusions', script: 'throw new Error("display-only-script")' } };
  const nested: OperationCallSummary[] = [
    { operationId: 'read', parentOperationId: 'request:tool:script', name: 'file_read', depth: 0, phase: 'terminal', outcome: 'succeeded', effect: 'none', cancelRequested: false },
    { operationId: 'search', parentOperationId: 'request:tool:script', name: 'file_search', depth: 0, phase: 'terminal', outcome: 'failed', effect: 'none', cancelRequested: false },
  ];
  const toolCalls = vi.fn(async () => nested);
  const operation = vi.fn(async (id: string) => ({ id, result: { actual: 'retained output' } }) as unknown as Operation);
  const context = { api: { toolCalls, operation } } as unknown as ConversationPresentation;
  const render = () => act(async () => root.render(<I18nProvider><ConversationContext.Provider value={context}><ChatScriptCard call={call}
    status="success" sessionId="script-card-test" output={<p>Script output</p>} rawDetails={<p>Original metadata</p>}
    renderCall={value => <p>{value.id}: retained output</p>} /></ConversationContext.Provider></I18nProvider>));
  const toggle = async (element: HTMLDetailsElement, open: boolean) => act(async () => { element.open = open; element.dispatchEvent(new window.Event('toggle')); });
  try {
    await render();
    expect(toolCalls).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Inspect directory exclusions');
    expect(container.textContent).not.toContain('display-only-script');
    expect(operation).not.toHaveBeenCalled();
    await toggle(container.querySelector('details')! as unknown as HTMLDetailsElement, true);
    expect(toolCalls).toHaveBeenCalledWith('request:tool:script', expect.any(AbortSignal));
    expect(container.textContent).toContain('Calls: 2');
    expect(container.textContent).toContain('1 need attention');
    expect(container.textContent).toContain('Script output');
    expect(container.textContent).toContain('View script');
    const row = container.querySelector('section details')! as unknown as HTMLDetailsElement;
    await toggle(row, true);
    expect(operation).toHaveBeenCalledExactlyOnceWith('read');
    expect(container.textContent).toContain('read: retained output');
    await toggle(container.querySelector('details')! as unknown as HTMLDetailsElement, false);
    call.arguments = { environmentId: 'original-environment', script: 'print("legacy")' };
    await render();
    expect(container.textContent).toContain('Search and read code');
    expect(container.textContent).not.toContain('Inspect directory exclusions');
  } finally { await act(async () => root.unmount()); }
});

it('projects live nested calls under their original script through the tool gateway', () => {
  const callId = JSON.stringify(['run', 'request', 'script']);
  const history: ThreadHistoryItem[] = [{ id: 'history-call', parent: null, run_id: 'run', thread_id: 'thread', source: 'assistant', provider: null,
    content: { id: 'model-item:7:request:call', content: { kind: 'tool_call', call: { call_id: 'script', name: 'tool_invoke',
      arguments: { reference: { name: 'script_run', version: '1' }, arguments: { title: 'Read source', script: 'print(1)' } } } } } }];
  const snapshot = { operations: [{ id: 'nested-read', run_id: 'run', phase: 'terminal', outcome: 'failed',
    intent: { origin: { kind: 'nested_call', parent_operation_id: 'request:tool:script' }, call: { name: 'file_read', arguments: { path: 'source.ts' } } },
  }] } as unknown as ThreadSnapshot;
  const view = new HistoryPresentation('script-projection').project(history, snapshot);
  expect(view.entries[0]).toMatchObject({ message: { content: [{ name: 'script_run', arguments: { title: 'Read source' } }] } });
  expect(view.toolExecutions['nested-read']).toMatchObject({ name: 'file_read', parentToolCallId: callId, status: 'error', args: { path: 'source.ts' } });
});
