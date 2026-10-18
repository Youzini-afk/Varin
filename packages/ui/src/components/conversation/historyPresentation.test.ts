import { expect, it } from 'vitest';
import { assistant, HistoryPresentation } from './historyPresentation';
import type { ThreadHistoryItem } from '@varin/application-client';

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
