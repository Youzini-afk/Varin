import { expect, it } from 'vitest';
import { assistant, HistoryPresentation } from './historyPresentation';

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
