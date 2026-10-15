import type { ImageAttachment } from '@varin/protocol';
import { fileToBase64 } from './fileAttachments';

export const imageAttachmentUrl = (attachment: ImageAttachment): string =>
  `data:${attachment.mimeType};base64,${attachment.data}`;

/** Shared browser ingestion; the active conversation transport owns durable acceptance. */
export const fileToImageAttachment = async (file: File): Promise<ImageAttachment> => ({
  data: await fileToBase64(file), mimeType: file.type || 'application/octet-stream',
});
