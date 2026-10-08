import type { ImageAttachment } from '@varin/protocol';

export const imageAttachmentUrl = (attachment: ImageAttachment): string =>
  `data:${attachment.mimeType};base64,${attachment.data}`;

/** Shared browser ingestion; the active conversation transport owns durable acceptance. */
export const fileToImageAttachment = (file: File): Promise<ImageAttachment> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
  reader.onload = () => {
    const value = typeof reader.result === 'string' ? reader.result : '';
    const separator = value.indexOf(',');
    if (separator === -1) { reject(new Error(`Could not decode ${file.name}`)); return; }
    resolve({ data: value.slice(separator + 1), mimeType: file.type || 'application/octet-stream' });
  };
  reader.readAsDataURL(file);
});
