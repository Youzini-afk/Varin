import type { ImageAttachment } from '@varin/protocol';
import { fileToBase64 } from './fileAttachments';
import type { ComposerEditorHandle } from './editor/ComposerEditor';
import { useThreadDraftStore, EMPTY_THREAD_DRAFT } from '@/stores/useThreadDraftStore';

export const imageAttachmentUrl = (attachment: ImageAttachment): string =>
  `data:${attachment.mimeType};base64,${attachment.data}`;

/** Shared browser ingestion; the active conversation transport owns durable acceptance. */
export const fileToImageAttachment = async (file: File): Promise<ImageAttachment> => ({
  data: await fileToBase64(file), mimeType: file.type || 'application/octet-stream',
});

/** Retain the original paste position across asynchronous file reads and later typing. */
export function beginImageInsertion(key: string, editor: ComposerEditorHandle | null, label: (number: number) => string) {
  const anchor = editor?.captureInsertion();
  let active = true;
  return {
    dispose: () => { active = false; anchor?.dispose(); },
    append(image: ImageAttachment) {
      if (!active) return;
      const store = useThreadDraftStore.getState();
      const draft = store.drafts[key] ?? EMPTY_THREAD_DRAFT;
      const reference = Math.max(draft.imageReferenceSequence ?? 0, ...draft.images.map(item => item.reference ?? 0)) + 1;
      store.patch(key, { images: [...draft.images, { ...image, reference }] });
      const text = label(reference);
      if (anchor) anchor.insertText(text);
      else store.patch(key, current => ({ text: current.text + text }));
    },
  };
}

export function removeDraftImage(key: string, index: number) {
  useThreadDraftStore.getState().patch(key, draft => {
    const image = draft.images[index];
    if (!image) return {};
    return { images: draft.images.filter((_, candidate) => candidate !== index),
      text: image.reference === undefined ? draft.text : removeImageReference(draft.text, image.reference) };
  });
}

export const removeImageReference = (text: string, number: number) =>
  text.replace(new RegExp(`\\[(?:Image ${number}|图片${number}|圖片${number})\\]`, 'g'), '');
