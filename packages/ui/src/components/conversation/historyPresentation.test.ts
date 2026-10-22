import { expect, it } from 'vitest';
import { assistant, HistoryPresentation } from './historyPresentation';
import type { ThreadHistoryItem, ThreadSnapshot } from '@varin/application-client';
import { invocationStatus, operationInvocation } from './toolInvocation';
import type { Operation } from '@varin/protocol';

it('keeps gateway dispatch acceptance separate from the original child execution and later work', () => {
  const base = { parent: null, thread_id: 'parent', run_id: 'run', source: 'assistant', provider: null };
  const gateway = { reference: { name: 'dispatch', version: '2' }, operationId: 'original-child',
    completion: { kind: 'job_accepted', operationId: 'original-child', phase: 'preparing' },
    result: { threadId: 'child', branchId: 'branch', name: 'Review' } };
  const history = [
    { ...base, id: 'call', content: { id: 'model-item:7:request:call', content: { kind: 'tool_call', call: { call_id: 'call', name: 'tool_invoke', arguments: { reference: gateway.reference, arguments: { task: 'Review source' } } } } } },
    { ...base, id: 'receipt', source: 'tool', content: { content: { kind: 'tool_result', result: { request_id: 'request', call_id: 'call', completion: { kind: 'result', outcome: 'succeeded', effect: 'none', content: { data: gateway, parts: [] } } } } } },
  ] as ThreadHistoryItem[];
  const snapshot = { operations: [
    { id: 'request:tool:call', run_id: 'run', phase: 'terminal', outcome: 'succeeded' },
    { id: 'original-child', run_id: 'run', phase: 'running', outcome: null },
  ], children: [{ operation_id: 'original-child', child_thread_id: 'child', child_branch_id: 'branch', state: 'running' }],
  childExecutions: [{ execution_id: 'later-child', state: 'running' }, { execution_id: 'original-child', state: 'preparing' }],
  childActivity: { 'later-child': { state: 'running' }, 'original-child': { state: 'preparing' } } } as unknown as ThreadSnapshot;
  const view = new HistoryPresentation('dispatch').project(history, snapshot);
  const execution = view.toolExecutions[JSON.stringify(['run', 'request', 'call'])];
  expect(execution).toMatchObject({ operationId: 'original-child', operation: { id: 'original-child' }, child: { execution: { execution_id: 'original-child' } } });
  const receipt = view.entries[1]!;
  expect(receipt).toMatchObject({ message: { status: 'background', toolName: 'dispatch', originalDetails: gateway, details: gateway.result } });
  if (receipt.type !== 'message' || receipt.message.role !== 'toolResult') throw new Error('Missing tool receipt');
  expect(invocationStatus(receipt.message, execution)).toBe('running');
  snapshot.operations[1]!.phase = 'terminal'; snapshot.operations[1]!.outcome = 'failed';
  const completed = new HistoryPresentation('dispatch').project(history, snapshot);
  expect(invocationStatus(receipt.message, completed.toolExecutions[JSON.stringify(['run', 'request', 'call'])])).toBe('error');
});

it('uses the target operation for nested gateway controls and retains the media receipt holder', () => {
  const outer = { id: 'wrapper', phase: 'terminal', outcome: 'succeeded', revision: 1,
    intent: { call: { name: 'tool_invoke', arguments: { reference: { name: 'process_spawn' }, arguments: { command: 'bun', args: ['test'] } } } },
    call_completion: { kind: 'result', outcome: 'succeeded', content: { parts: [], data: { reference: { name: 'process_spawn' }, operationId: 'process-operation',
      completion: { kind: 'job_accepted' }, result: { processId: 'original-process' } } } } } as unknown as Operation;
  const target = { id: 'process-operation', phase: 'running', revision: 2 } as Operation;
  const view = operationInvocation(outer, target);
  expect(view.call).toMatchObject({ id: 'wrapper', name: 'process_spawn', gateway: { name: 'tool_invoke' } });
  expect(view.execution.operation).toBe(target);
  expect(view.result?.operation).toBe(outer);
  expect(invocationStatus(view.result, view.execution)).toBe('running');
  const offline = operationInvocation(outer);
  expect(offline.execution.operation).toBeUndefined();
  expect(invocationStatus(offline.result, offline.execution)).toBe('background');
});

it('presents a saved render_ui gateway receipt as an interactive card with its original history identity', () => {
  const input = { title: 'Report', changes: [{ op: 'write', file: 'index.html', text: '<h1>Report</h1>' }] };
  const receipt = { kind: 'ui', workRef: 'ui:report', ref: 'ui:report@1', title: 'Report', revision: 1, entry: 'index.html', files: ['index.html'] };
  const base = { parent: null, thread_id: 'thread', run_id: 'run', source: 'assistant', provider: null };
  const history = [
    { ...base, id: 'call-history', content: { id: 'model-item:7:request:call', content: { kind: 'tool_call', call: { call_id: 'call', name: 'tool_invoke', arguments: { reference: { name: 'render_ui', version: 'version' }, arguments: input } } } } },
    { ...base, id: 'result-history', source: 'tool', content: { content: { kind: 'tool_result', result: { request_id: 'request', call_id: 'call', completion: { kind: 'result', outcome: 'succeeded', effect: 'none', content: { data: { reference: { name: 'render_ui', version: 'version' }, completion: { kind: 'result', outcome: 'succeeded', effect: 'confirmed' }, result: receipt }, parts: [] } } } } } },
  ] as ThreadHistoryItem[];
  const view = new HistoryPresentation('thread').project(history, undefined);
  expect(view.entries[0]).toMatchObject({ id: 'call-history', message: { content: [{ name: 'render_ui', arguments: input }] } });
  expect(view.entries[1]).toMatchObject({ id: 'result-history', message: { toolName: 'render_ui', details: receipt, isError: false } });
  expect(JSON.stringify(history[0])).toContain('tool_invoke');
});

it('keeps live and durable labels on the accepted request model without exposing channel IDs', () => {
  const live = assistant('live', [{ type: 'text', text: 'Answer' }], {
    providerId: 'dbcf0091-7695-4017-9613-9e5813b4cfe4',
    catalogModelId: 'catalog-alias', model: 'accepted-deployment',
  }, true);
  const history = new HistoryPresentation('thread').project([{
    id: 'answer', parent: null, thread_id: 'thread', run_id: 'run', source: 'assistant', provider: null,
    content: { content: { kind: 'text', text: 'Answer' }, opaque: { family: 'openai-completions', value: { reasoning_content: 'Visible thinking', content: 'Answer' } } },
    modelRequest: { requestId: 'request', providerFamily: 'openai-completions', modelId: 'accepted-deployment',
      usage: { measurement: 'missing', inputTokens: null, outputTokens: null, cachedInputTokens: null,
        cacheWriteTokens: null, reasoningTokens: null, pricingVersion: null } },
  }], undefined).entries[0];
  expect(live).toMatchObject({ model: 'accepted-deployment', provider: '' });
  expect(history).toMatchObject({ type: 'message', message: { model: live.model, provider: live.provider } });
  expect(history).toMatchObject({ message: { content: [{ type: 'thinking', thinking: 'Visible thinking' }, { type: 'text', text: 'Answer' }] } });
});
