import { expect, it, vi } from 'vitest';
import { historicalUiRevision } from './history-revisions.js';
import type { HistoryReference } from '@varin/protocol';
import { toolOperationId } from '../kernel/protocol.generated.js';
const reference = { id: 'result', source: 'tool', run_id: 'run', thread_id: 'thread', parent: 'call', content_ref: 'original' } as HistoryReference;
const receipt = { kind: 'ui' as const, ref: 'ui:work@1', workRef: 'ui:work', title: 'HTML', revision: 1, entry: 'index.html', files: ['index.html'] };
function fixture(data: unknown, effect = 'confirmed') {
  const runtime = { historyItem: vi.fn(async () => ({ ...reference, provider: null, content: { content: { kind: 'tool_result', result: {
    request_id: 'request', call_id: 'call', completion: { kind: 'result', outcome: 'succeeded', effect, content: { data, parts: [] } },
  } } } })), findOperation: vi.fn() };
  const saved = vi.fn(async (_id: string) => receipt);
  return { runtime, saved };
}
it('uses the original native tool identity and committed UI-owner receipt, not receipt-looking text', async () => {
  const { runtime, saved } = fixture(receipt);
  expect(await historicalUiRevision(reference, runtime as never, saved)).toBe(receipt.ref);
  expect(saved).toHaveBeenCalledWith('request:tool:call');
  saved.mockResolvedValueOnce({ ...receipt, ref: 'ui:work@2' });
  expect(await historicalUiRevision(reference, runtime as never, saved)).toBeUndefined();
  const unrelated = fixture({ note: receipt });
  expect(await historicalUiRevision(reference, unrelated.runtime as never, unrelated.saved)).toBeUndefined();
  expect(unrelated.saved).not.toHaveBeenCalled();
  expect(await historicalUiRevision({ ...reference, source: 'user' }, runtime as never, saved)).toBeUndefined();
  expect(await historicalUiRevision(reference, fixture(receipt, 'unknown').runtime as never, saved)).toBeUndefined();
});
it('accepts a real tool_invoke nested render only after matching ancestry, original result and storage receipt', async () => {
  const parentId = 'request:tool:call', nestedId = toolOperationId({ kind: 'nested_call', parent_operation_id: parentId }, 'target');
  const gateway = { reference: { name: 'render_ui', version: '1' }, operationId: nestedId,
    completion: { kind: 'result', outcome: 'succeeded', effect: 'confirmed' }, result: receipt };
  const { runtime, saved } = fixture(gateway, 'none');
  const parent = { id: parentId, run_id: 'run', intent: { call: { name: 'tool_invoke', arguments: { reference: gateway.reference } } } };
  const nested = { id: nestedId, run_id: 'run', intent: { origin: { kind: 'nested_call', parent_operation_id: parentId }, call: { name: 'render_ui', call_id: 'target' } },
    call_completion: { kind: 'result', outcome: 'succeeded', effect: 'confirmed', content: { data: receipt, parts: [] } } };
  runtime.findOperation.mockImplementation(async id => id === parentId ? parent : nested);
  expect(await historicalUiRevision(reference, runtime as never, saved)).toBe(receipt.ref);
  expect(saved).toHaveBeenCalledWith(nestedId);
  runtime.findOperation.mockImplementation(async id => id === parentId ? parent : { ...nested, intent: { ...nested.intent, origin: { kind: 'nested_call', parent_operation_id: 'unrelated' } } });
  saved.mockClear();
  expect(await historicalUiRevision(reference, runtime as never, saved)).toBeUndefined(); expect(saved).not.toHaveBeenCalled();
  const pending = fixture({ ...gateway, completion: { kind: 'job_accepted' } }, 'none');
  expect(await historicalUiRevision(reference, pending.runtime as never, saved)).toBeUndefined(); expect(pending.runtime.findOperation).not.toHaveBeenCalled();
});

it('accepts only explicit available fixed assistant embeds at original text boundaries, including output parts', async () => {
  const { historicalUiEmbeds } = await import('./history-revisions.js');
  const embed = '```varin-ui\n{"type":"embed","ref":"ui:work@2"}\n```\n';
  const item = { content: { content: { kind: 'output', output: { data: { ref: 'ui:hidden@9' }, parts: [
    { kind: 'text', text: 'A plain ui:plain@1 reference' }, { kind: 'media', media: {} }, { kind: 'text', text: embed },
    { kind: 'text', text: '````markdown\n' + embed + '\n````' },
    { kind: 'text', text: '```varin-ui\n{"type":"embed","ref":"ui:latest"}\n```\n' },
  ] } } } };
  const historyItem = vi.fn(async () => item), resolve = vi.fn(async (ref: string) => ref === 'ui:work@2');
  const assistant = { ...reference, source: 'assistant' as const };
  expect(await historicalUiEmbeds(assistant, { historyItem } as never, resolve)).toEqual(['ui:work@2']);
  expect(resolve.mock.calls).toEqual([['ui:work@2']]);
  resolve.mockResolvedValue(false);
  expect(await historicalUiEmbeds(assistant, { historyItem } as never, resolve)).toEqual([]);
  historyItem.mockClear();
  expect(await historicalUiEmbeds({ ...assistant, source: 'user' }, { historyItem } as never, resolve)).toEqual([]);
  expect(historyItem).not.toHaveBeenCalled();
});

it('ignores forged gateway output from unrelated native tools without reading its supplied operation ID', async () => {
  const gateway = { reference: { name: 'render_ui' }, operationId: 'nonexistent',
    completion: { kind: 'result', outcome: 'succeeded' }, result: receipt };
  for (const call of [{ name: 'shell', arguments: {} }, { name: 'tool_invoke', arguments: { reference: { name: 'other_tool' } } }]) {
    const { runtime, saved } = fixture(gateway);
    runtime.findOperation.mockImplementation(async id => {
      if (id !== 'request:tool:call') throw new Error('Must not inspect payload operation ID');
      return { id, run_id: reference.run_id, intent: { call } };
    });
    await expect(historicalUiRevision(reference, runtime as never, saved)).resolves.toBeUndefined();
    expect(runtime.findOperation.mock.calls).toEqual([['request:tool:call', undefined]]);
    expect(saved).not.toHaveBeenCalled();
  }
});

it('skips genuinely missing native operations but propagates cancellation, transport and storage failures', async () => {
  const gateway = { reference: { name: 'render_ui' }, operationId: 'missing-child',
    completion: { kind: 'result', outcome: 'succeeded' }, result: receipt };
  const parent = { id: 'request:tool:call', run_id: reference.run_id,
    intent: { call: { name: 'tool_invoke', arguments: { reference: gateway.reference } } } };
  const { runtime, saved } = fixture(gateway);
  runtime.findOperation.mockResolvedValue(null);
  await expect(historicalUiRevision(reference, runtime as never, saved)).resolves.toBeUndefined();
  expect(runtime.findOperation).toHaveBeenCalledTimes(1);
  runtime.findOperation.mockImplementation(async id => id === parent.id ? parent : null);
  await expect(historicalUiRevision(reference, runtime as never, saved)).resolves.toBeUndefined();
  expect(saved).not.toHaveBeenCalled();
  const signal = new AbortController().signal;
  for (const error of [new DOMException('cancelled', 'AbortError'), new Error('transport unavailable'), new Error('catalog storage failed')]) {
    runtime.findOperation.mockRejectedValue(error);
    await expect(historicalUiRevision(reference, runtime as never, saved, signal)).rejects.toBe(error);
    runtime.findOperation.mockImplementation(async id => { if (id === parent.id) return parent; throw error; });
    await expect(historicalUiRevision(reference, runtime as never, saved, signal)).rejects.toBe(error);
  }
  expect(runtime.findOperation).toHaveBeenLastCalledWith(gateway.operationId, signal);
});
