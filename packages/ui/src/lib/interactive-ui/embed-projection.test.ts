import { expect, it } from 'vitest';
import { projectUiEmbeds } from './embed-projection';
import type { ChatAssistantMessage, ChatSessionEntry } from '@/components/conversation/types';
import type { UiCardProjection } from '@/components/conversation/ConversationContext';
const fence = (ref: string) => '```varin-ui\n' + JSON.stringify({ type: 'embed', ref }) + '\n```';
const message = (id: string, content: ChatAssistantMessage['content']): ChatAssistantMessage => ({ id, content, role: 'assistant', api: '', model: '', provider: '', stopReason: 'stop', timestamp: 0 });
const entry = (id: string, content: ChatAssistantMessage['content']): ChatSessionEntry => ({ id, type: 'message', message: message(id, content), timestamp: 'now', parentId: null });
const call = { id: 'make', type: 'toolCall' as const, name: 'render_ui', arguments: {} };
const cards: Record<string, UiCardProjection> = { make: { call, compact: false, result: { role: 'toolResult', content: [], isError: false, timestamp: 0, toolCallId: 'make', toolName: 'render_ui', details: { ref: 'ui:report@1' } } } };
it('selects the final prose position before mounting, with duplicate refs sharing one view', () => {
  const result = projectUiEmbeds([entry('creation', [call]), entry('answer', [{ id: 'native-text', type: 'text', text: 'Before\n' + fence('ui:report@1') + '\nAfter\n' + fence('ui:report@1') }])], cards);
  const positions = Object.values(result.embeds);
  expect(positions).toHaveLength(2);
  expect(positions[0]).toEqual(positions[1]);
  expect(positions[0]).toMatchObject({ sessionId: 'make', sourceEntryId: 'answer', primaryKey: 'native-text:offset:7' });
  expect(result.targets.make).toBe('native-text:offset:7');
});
it('retains streamed native item placement across history commit and does not interpret examples', () => {
  const content = [{ id: 'item:request:one', type: 'text' as const, text: fence('ui:report@1') }];
  const live = projectUiEmbeds([entry('creation', [call])], cards, message('progress:run', content));
  const durable = projectUiEmbeds([entry('creation', [call]), entry('saved', content)], cards);
  expect(Object.keys(live.embeds)).toEqual(Object.keys(durable.embeds));
  expect(live.targets).toEqual(durable.targets);
  const example = projectUiEmbeds([entry('example', [{ type: 'text', text: '````markdown\n' + fence('ui:report@1') + '\n````' }])], cards);
  expect(example.embeds).toEqual({});
});
