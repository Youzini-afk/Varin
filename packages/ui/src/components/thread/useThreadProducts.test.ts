import { expect, it } from 'vitest';
import type { ThreadHistoryItem } from '@varin/application-client';
import { threadProducts } from './useThreadProducts';

function exchange(run: string, name: string, args: object, data: object, outcome = 'succeeded'): ThreadHistoryItem[] {
  const request = `request-${run}`;
  return [
    { id: `${run}:call`, parent: null, run_id: run, source: 'assistant', content: { id: `model-item:${request.length}:${request}:call`, content: { kind: 'tool_call', call: { call_id: 'call', name, arguments: args } } } },
    { id: `${run}:result`, parent: `${run}:call`, run_id: run, source: 'tool', content: { content: { kind: 'tool_result', result: { request_id: request, call_id: 'call', completion: { kind: 'result', outcome, effect: 'confirmed', content: { data, parts: [] } } } } } },
  ] as ThreadHistoryItem[];
}

it('keeps the original Run and history owner for identical paths, and excludes rejected mutations', () => {
  const history = [
    ...exchange('one', 'file_write', { path: 'report.md', content: 'first' }, { mutation: { status: 'applied' } }),
    ...exchange('two', 'file_edit', { path: 'report.md', edits: [] }, { mutation: { status: 'conflict' } }, 'failed'),
    ...exchange('three', 'file_write', { path: 'report.md', content: 'third' }, { mutation: { status: 'committed' } }),
  ];
  expect(threadProducts(history, undefined).map(value => value.kind === 'file' && { itemId: value.itemId, run: value.runId, phase: value.phase, path: value.path })).toEqual([
    { itemId: 'three:call', run: 'three', phase: 'branch', path: 'report.md' },
    { itemId: 'one:call', run: 'one', phase: 'applied', path: 'report.md' },
  ]);
});

it('projects a disclosed file tool using its original call identity and its per-file receipt', () => {
  const reference = { name: 'file_write', version: 'v1' };
  const history = exchange('gateway', 'tool_invoke', { reference, arguments: { path: 'report.md', content: 'draft' } },
    { reference, result: { mutation: { status: 'partial', results: [{ path: 'report.md', status: 'applied', target: 'surface' }] } } });
  const product = threadProducts(history, undefined)[0];
  expect(product).toMatchObject({ kind: 'file', itemId: 'gateway:call', phase: 'draft', call: { name: 'file_write' } });
});

it('keeps the latest saved HTML revision, including updates through the disclosed entry', () => {
  const receipt = { kind: 'ui', ref: 'ui:report@1', workRef: 'ui:report', title: 'Report', revision: 1, entry: 'index.html', files: ['index.html'] };
  const reference = { name: 'render_ui', version: 'v1' };
  const history = [
    ...exchange('first', 'render_ui', { changes: [] }, receipt),
    ...exchange('second', 'tool_invoke', { reference, arguments: { ref: receipt.ref, changes: [] } }, { reference, result: { ...receipt, ref: 'ui:report@2', revision: 2 } }),
  ];
  expect(threadProducts(history, undefined)).toMatchObject([{ kind: 'ui', itemId: 'second:call', receipt: { ref: 'ui:report@2' } }]);
  expect(threadProducts(history, undefined)).toHaveLength(1);
});
