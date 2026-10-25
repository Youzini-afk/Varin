import type { StoredMedia, OutputMediaHolder } from '@varin/protocol';
import type { ChatImageContent, ChatToolExecutionState, ChatToolResultMessage } from './types';

export type ViewedImage =
  | { kind: 'stored'; holder: OutputMediaHolder; partIndex: number; media: StoredMedia }
  | { kind: 'inline'; partIndex: number; image: ChatImageContent };

/** Model-visible typed output only. A binary file read, URL or screenshot reference is not an image receipt. */
export function viewedImages(name: string, result?: ChatToolResultMessage, execution?: ChatToolExecutionState): ViewedImage[] {
  if (['image_generate', 'image_edit', 'varin.images.generation', 'varin.images.editing',
    'dispatch', 'send', 'ask_user', 'render_ui'].includes(name)) return [];
  if (result?.notDispatched) return [];
  if (result?.historyId && result.imageParts?.length) return result.imageParts.map(part => ({
    ...part, kind: 'stored', holder: { kind: 'history', itemId: result.historyId! },
  }));
  for (const operation of [result?.operation, execution?.operation]) {
    const completion = operation?.call_completion;
    const stored: ViewedImage[] = operation && completion && completion.kind !== 'not_dispatched'
      ? completion.content?.parts.flatMap((part, partIndex) => part.kind === 'media' && part.media.media_type.startsWith('image/')
        ? [{ kind: 'stored' as const, holder: { kind: 'operation' as const, operationId: operation.id, output: 'completion' as const }, partIndex, media: part.media }] : []) ?? [] : [];
    if (stored.length) return stored;
  }
  return result?.content.flatMap((part, partIndex) => part.type === 'image'
    ? [{ kind: 'inline' as const, partIndex, image: part }] : []) ?? [];
}
