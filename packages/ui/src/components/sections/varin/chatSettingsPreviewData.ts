import type { useI18n } from '@/lib/i18n';
import type { ChatSessionEntry, ChatSessionMessageEntry, ChatMessage, ChatToolExecutionState } from '@/components/conversation/types';

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

/** Controlled examples exercise the same dynamic row without a timer or live API. */
export function createDialoguePreview(t: ReturnType<typeof useI18n>['t'], step: number) {
  const original = createChatPreviewEntries(t);
  const entries: ChatSessionEntry[] = original.slice(0, -2).map(entry => entry.type === 'message' && entry.message.role === 'assistant'
    ? { ...entry, message: { ...entry.message, content: [...entry.message.content.filter(part => part.type === 'text'), ...entry.message.content.filter(part => part.type !== 'text')] } } : entry);
  const runId = 'settings-preview:run';
  const add = (id: string, message: ChatMessage) => entries.push({ id: `settings-preview:${id}`, parentId: entries.at(-1)?.id ?? null, runId, timestamp: '', type: 'message', message });
  const assistant = (id: string, content: Extract<ChatMessage, { role: 'assistant' }>['content']) => add(id, {
    id: `settings-preview:${id}`, role: 'assistant', api: '', model: 'GPT-4.1', provider: 'OpenAI', timestamp: 0, content, stopReason: 'toolUse',
  });
  const task = { name: t('settings.chat.preview.delegate'), task: t('settings.chat.preview.delegateTask') };
  assistant('delegate', [{ type: 'toolCall', id: 'settings-preview:delegate', name: 'dispatch', arguments: task }]);
  add('delegate-result', { role: 'toolResult', toolCallId: 'settings-preview:delegate', toolName: 'dispatch', timestamp: 0, isError: false, status: 'background',
    details: { threadId: 'settings-preview:reviewer', branchId: 'settings-preview:branch', name: task.name }, content: [] });
  assistant('next', [{ type: 'text', text: t('settings.chat.preview.dialogueNext') }]);
  assistant('read', [{ type: 'toolCall', id: 'settings-preview:read', name: 'file_read', arguments: { path: 'src/validate.ts' } }]);
  const executions: Record<string, ChatToolExecutionState> = {
    'settings-preview:delegate': { toolCallId: 'settings-preview:delegate', name: 'dispatch', args: task, status: step < 2 ? 'running' : 'success' },
    'settings-preview:read': { toolCallId: 'settings-preview:read', name: 'file_read', args: { path: 'src/validate.ts' }, status: step === 0 ? 'running' : 'success' },
  };
  if (step > 0) {
    add('read-result', { role: 'toolResult', toolCallId: 'settings-preview:read', toolName: 'file_read', timestamp: 0, isError: false, status: 'success', content: [{ type: 'text', text: 'export function validate(input: string) { return input.length > 0; }' }] });
    assistant('search', [{ type: 'toolCall', id: 'settings-preview:search', name: 'file_search', arguments: { query: 'validate', paths: ['src'] } }]);
    executions['settings-preview:search'] = { toolCallId: 'settings-preview:search', name: 'file_search', args: { query: 'validate', paths: ['src'] }, status: step === 1 ? 'running' : 'success' };
  }
  if (step === 2) {
    add('search-result', { role: 'toolResult', toolCallId: 'settings-preview:search', toolName: 'file_search', timestamp: 0, isError: false, status: 'success', content: [{ type: 'text', text: 'src/validate.ts:1' }] });
    entries.push(...original.slice(-2));
  }
  return { entries, executions, active: step < 2 };
}

