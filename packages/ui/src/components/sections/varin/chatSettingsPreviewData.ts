import type { useI18n } from '@/lib/i18n';
import type { ChatSessionEntry, ChatSessionMessageEntry, ChatMessage } from '@/components/conversation/types';

export const CHAT_PREVIEW_CODE = '```ts\nconst result = validate(input, { allowEmpty: false, normalizeWhitespace: true });\n```';

/** Inert sample history is fed into the production turn renderer, never a Thread store or API. */
export function createChatPreviewEntries(t: ReturnType<typeof useI18n>['t']): ChatSessionEntry[] {
  const runId = 'settings-preview:run';
  const entry = (id: string, message: ChatMessage, parentId: string | null): ChatSessionMessageEntry => ({ id: `settings-preview:${id}`, parentId, runId, timestamp: '2026-01-01T10:24:00Z', type: 'message', message });
  const assistant = (id: string, content: Extract<ChatMessage, { role: 'assistant' }>['content'], stopReason: 'toolUse' | 'stop'): Extract<ChatMessage, { role: 'assistant' }> => ({ id, role: 'assistant', api: '', model: 'GPT-4.1', provider: 'OpenAI', timestamp: 0, content, stopReason });
  return [
    entry('user', { role: 'user', timestamp: 0, content: t('settings.chat.preview.user') }, null),
    entry('activity', assistant('settings-preview:activity', [
      { type: 'thinking', thinking: t('settings.chat.preview.thinking') },
      { type: 'text', text: t('settings.chat.preview.narration') },
      { type: 'toolCall', id: 'settings-preview:edit', name: 'file_edit', arguments: { path: 'src/validate.ts', edits: [{ oldText: 'if (!input) return true;', newText: 'if (!input) return false;' }] } },
      { type: 'toolCall', id: 'settings-preview:test', name: 'process_spawn', arguments: { command: 'bun test validate' } },
    ], 'toolUse'), 'settings-preview:user'),
    entry('edit-result', { role: 'toolResult', timestamp: 0, toolCallId: 'settings-preview:edit', toolName: 'file_edit', isError: false, status: 'success', details: { applied: true }, content: [{ type: 'text', text: 'src/validate.ts · +1 −1' }] }, 'settings-preview:activity'),
    entry('test-result', { role: 'toolResult', timestamp: 0, toolCallId: 'settings-preview:test', toolName: 'process_spawn', isError: false, status: 'success', content: [{ type: 'text', text: t('settings.chat.preview.testOutput') }] }, 'settings-preview:edit-result'),
    entry('answer', assistant('settings-preview:answer', [{ type: 'text', text: `${t('settings.chat.preview.answer')}\n\n${CHAT_PREVIEW_CODE}` }], 'stop'), 'settings-preview:test-result'),
    { id: `run-usage:${runId}`, parentId: 'settings-preview:answer', runId, timestamp: '', type: 'run_usage', usages: [] },
  ];
}

