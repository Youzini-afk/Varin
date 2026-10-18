import type { ChatAssistantMessage, ChatSessionEntry } from './types';
import { chatContentText } from './extensionPresentation';

/** A preview belongs to the native Run, never to a mounted tool/message row. */
export function readChatRunNavigationText(entries: readonly ChatSessionEntry[], runId: string, live?: ChatAssistantMessage): string {
  const messages = entries.filter(entry => entry.runId === runId).flatMap(entry => entry.type === 'message' ? [entry.message] : []);
  const prompt = messages.find(message => message.role === 'user');
  const assistants = messages.filter((message): message is ChatAssistantMessage => message.role === 'assistant');
  if (live?.runId === runId) assistants.push(live);
  let response = '';
  for (let index = assistants.length - 1; index >= 0; index -= 1) {
    const message = assistants[index]!;
    response = message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n').trim() || message.errorMessage || '';
    if (response) break;
  }
  return response || (prompt ? chatContentText(prompt.content) : '');
}
