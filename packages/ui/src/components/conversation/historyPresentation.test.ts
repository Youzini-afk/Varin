import { expect, it } from 'vitest';
import { assistant, HistoryPresentation } from './historyPresentation';
import { projectChatDialogue } from './chatDialogueProjection';
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

it.each([false, true])('presents a saved render_ui gateway receipt (legacy=%s) with its original history identity', legacy => {
  const target = legacy ? { reference: { name: 'render_ui', version: 'version' } } : { name: 'render_ui' };
  const input = { title: 'Report', changes: [{ op: 'write', file: 'index.html', text: '<h1>Report</h1>' }] };
  const receipt = { kind: 'ui', workRef: 'ui:report', ref: 'ui:report@1', title: 'Report', revision: 1, entry: 'index.html', files: ['index.html'] };
  const base = { parent: null, thread_id: 'thread', run_id: 'run', source: 'assistant', provider: null };
  const history = [
    { ...base, id: 'call-history', content: { id: 'model-item:7:request:call', content: { kind: 'tool_call', call: { call_id: 'call', name: 'tool_invoke', arguments: { ...target, arguments: input } } } } },
    { ...base, id: 'result-history', source: 'tool', content: { content: { kind: 'tool_result', result: { request_id: 'request', call_id: 'call', completion: { kind: 'result', outcome: 'succeeded', effect: 'none', content: { data: { ...target, completion: { kind: 'result', outcome: 'succeeded', effect: 'confirmed' }, result: receipt }, parts: [] } } } } } },
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

it('retains native body indices for assistant output while leaving tool and agent output non-interactive', () => {
  const output = { parts: [{ kind: 'text', text: 'Before' }, { kind: 'media', media: { media_type: 'image/png' } },
    { kind: 'text', text: '```varin-ui\n{"type":"choice","options":["A","B"]}\n```' }], data: null };
  const base = { parent: null, thread_id: 'thread', run_id: 'run', provider: null };
  const history = ['assistant', 'tool', 'agent'].map(source => ({ ...base, source, id: source,
    content: { id: 'native-output', content: { kind: 'output', output } } })) as ThreadHistoryItem[];
  const view = new HistoryPresentation('thread').project(history, undefined);
  expect(view.entries[0]).toMatchObject({ id: 'assistant', message: { role: 'assistant', content: [
    { id: 'native-output:part:0', contentIndex: 0, text: 'Before' },
    { id: 'native-output:part:2', contentIndex: 2, text: output.parts[2]!.text },
  ] } });
  const dialogue = projectChatDialogue(view.entries.filter(entry => entry.type === 'message' || entry.type === 'custom_message'));
  expect(dialogue.filter(part => part.kind === 'text').map(part => ({ sourceId: part.sourceId, contentIndex: part.contentIndex }))).toEqual([
    { sourceId: 'assistant', contentIndex: 0 }, { sourceId: 'assistant', contentIndex: 2 },
  ]);
  expect(view.entries[1]).toMatchObject({ message: { role: 'custom', customType: 'tool' } });
  expect(view.entries[2]).toMatchObject({ type: 'custom_message', customType: 'thread-message' });
  expect(history[0]?.content).toMatchObject({ content: { output: { parts: output.parts } } });
});

it('keeps a simple assistant body at native index zero when opaque thinking is prepended', () => {
  const view = new HistoryPresentation('thread').project([{
    id: 'history', parent: null, thread_id: 'thread', run_id: 'run', source: 'assistant', provider: null,
    content: { id: 'model-item:7:request:message', content: { kind: 'text', text: 'Body' },
      opaque: { family: 'openai-completions', value: { reasoning_content: 'Thinking' } } },
  }], undefined);
  expect(view.entries[0]).toMatchObject({ message: { content: [
    { type: 'thinking' }, { type: 'text', id: 'model-item:7:request:message', contentIndex: 0 },
  ] } });
});

it('retains an extras-bearing row for media-only assistant outputs and anchors mixed output extras after visible text', () => {
  const base = { parent: null, thread_id: 'thread', run_id: 'run', source: 'assistant', provider: null };
  const media = { kind: 'media', media: { media_type: 'image/png' } };
  const entries = new HistoryPresentation('thread').project([
    { ...base, id: 'image-only', content: { content: { kind: 'output', output: { data: null, parts: [media] } } } },
    { ...base, id: 'mixed', content: { content: { kind: 'output', output: { data: null, parts: [{ kind: 'text', text: 'Caption' }, media, { kind: 'text', text: '  ' }] } } } },
  ] as ThreadHistoryItem[], undefined).entries;
  expect(entries[0]).toMatchObject({ message: { role: 'custom', customType: 'assistant' } });
  const dialogue = projectChatDialogue(entries.filter(entry => entry.type === 'message' || entry.type === 'custom_message'));
  expect(dialogue.some(part => part.kind === 'process' && part.activities.some(item => item.sourceId === 'image-only'))).toBe(true);
  expect(dialogue.find(part => part.kind === 'text')).toMatchObject({ contentIndex: 0, extrasId: 'mixed' });
});


it('keeps runtime collaboration observations in original history without adding chat or dialogue rows', () => {
  const base = { parent: null, thread_id: 'thread', run_id: 'run', provider: null };
  const data = { version: 1, notice: 'Collaboration state observed at this history point.',
    callerThreadId: 'thread', callerBranchId: 'branch', rootThreadId: 'thread', members: [] };
  const observation = { ...base, id: 'collaboration-observation:original', source: 'environment', content: {
    id: 'collaboration-observation:original', provenance: { kind: 'external_data', source: 'collaboration-state' },
    content: { kind: 'output', output: { data, parts: [] } }, opaque: null, resource_activation: null,
  } } as ThreadHistoryItem;
  const history = [
    { ...base, id: 'before', source: 'assistant', content: { content: { kind: 'text', text: 'Before' } } },
    observation,
    { ...base, id: 'after', source: 'assistant', content: { content: { kind: 'text', text: 'After' } } },
  ] as ThreadHistoryItem[];
  const original = JSON.stringify(history);
  const presentation = new HistoryPresentation('collaboration');
  for (let read = 0; read < 2; read++) {
    const entries = presentation.project(history, undefined).entries;
    expect(entries.map(entry => entry.id)).toEqual(['before', 'after']);
    const dialogue = projectChatDialogue(entries.filter(entry => entry.type === 'message' || entry.type === 'custom_message'));
    expect(dialogue.map(part => part.kind)).toEqual(['text', 'text']);
  }
  expect(JSON.stringify(history)).toBe(original);
  expect(observation.content).toMatchObject({ content: { output: { data, parts: [] } } });
});

it('does not hide user content, other environment facts, or unrelated empty outputs', () => {
  const base = { parent: null, thread_id: 'thread', run_id: 'run', provider: null };
  const provenance = { kind: 'external_data', source: 'collaboration-state' };
  const output = { kind: 'output', output: { data: { arbitrary: 'original data' }, parts: [] } };
  const history = [
    { ...base, id: 'user', source: 'user', content: { text: 'User text remains visible', provenance, content: output } },
    { ...base, id: 'agent', source: 'agent', content: { provenance, content: output } },
    { ...base, id: 'assistant', source: 'assistant', content: { provenance, content: output } },
    { ...base, id: 'other-environment', source: 'environment', content: { provenance: { kind: 'external_data', source: 'other-state' }, content: output } },
    { ...base, id: 'other-provenance', source: 'environment', content: { provenance: { kind: 'environment_fact', source: 'collaboration-state' }, content: output } },
    { ...base, id: 'ordinary-text', source: 'environment', content: { provenance, content: { kind: 'text', text: 'Original environment text' } } },
    { ...base, id: 'unrelated-empty', source: 'environment', content: { content: output } },
  ] as ThreadHistoryItem[];
  const entries = new HistoryPresentation('other-history').project(history, undefined).entries;
  expect(entries.map(entry => entry.id)).toEqual(history.map(item => item.id));
  expect(entries[0]).toMatchObject({ message: { role: 'user', content: 'User text remains visible' } });
  expect(entries[3]).toMatchObject({ message: { role: 'custom', customType: 'environment', display: true } });
  expect(entries[5]).toMatchObject({ type: 'custom_message', content: 'Original environment text' });
});
