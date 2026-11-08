import { expect, it, vi } from 'vitest';
import * as content from '@varin/application-client';
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


it('does not reparse retained history on each stream frame and still recomputes placement ownership', () => {
  const parse = vi.spyOn(content, 'parseConversationContent');
  try {
    const history = Array.from({ length: 40 }, (_, i) => entry(`saved:${i}`, [{ type: 'text', text: `Earlier ${i}\n${fence(`ui:report-${i}@1`)}` }]));
    let result = projectUiEmbeds(history, {});
    const original = result.embeds;
    expect(parse).toHaveBeenCalledTimes(40);
    for (let i = 0; i < 20; i++) {
      result = projectUiEmbeds(history, {}, { ...message('live', [{ type: 'text', text: `Current ${i}` }]), stopReason: 'pending' });
      expect(result.embeds).toEqual(original);
    }
    expect(parse).toHaveBeenCalledTimes(60);
    const part = { type: 'text' as const, text: fence('ui:report@1') };
    const answer = entry('answer', [part]);
    expect(Object.values(projectUiEmbeds([entry('creation', [call]), answer], {}).embeds)[0]?.sessionId).not.toBe('make');
    expect(Object.values(projectUiEmbeds([entry('creation', [call]), answer], cards).embeds)[0]?.sessionId).toBe('make');
    part.text = fence('ui:replacement@2');
    expect(Object.values(projectUiEmbeds([answer], {}).embeds)[0]?.ref).toBe('ui:replacement@2');
    const before = parse.mock.calls.length;
    const live: ChatAssistantMessage = { ...message('live', [part]), stopReason: 'pending' };
    projectUiEmbeds([], {}, live);
    live.stopReason = 'stop';
    projectUiEmbeds([], {}, live);
    expect(parse.mock.calls.length - before).toBe(2);
  } finally { parse.mockRestore(); }
});
