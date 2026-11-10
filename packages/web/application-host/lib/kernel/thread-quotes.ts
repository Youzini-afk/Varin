import { parseContentReferenceInput, type ContentReferenceInput } from '@varin/application-client';
import type { Attachment, AttachmentSelection, ImageAttachment } from '@varin/protocol';
import { parseThreadImages } from './thread-images.js';

/** Copy before asynchronous reads. Captured quote images join the existing input media
 * owner; prepared file descriptors join the existing attachment delivery relationship. */
export function prepareQuoteSelections(input: ContentReferenceInput & { text: string; images?: ImageAttachment[]; attachments?: AttachmentSelection[]; attachmentImageReferences?: Record<string, number> }) {
  const quotes = parseContentReferenceInput(input, input.text);
  const images = parseThreadImages(input.images)?.map(image => ({ ...image }));
  const selectedImages = images ?? [];
  const attachments = [...input.attachments ?? []];
  let nextImage = Math.max(0, ...selectedImages.map(image => image.reference ?? 0), ...Object.values(input.attachmentImageReferences ?? {}));
  const quoteAttachmentIndices = new Map<string, number>();
  for (const reference of quotes.contentReferences ?? []) {
    if (reference.image) {
      const number = reference.imageReference ?? ++nextImage;
      if (selectedImages.some(image => image.reference === number)) throw new Error('Quote image number is already bound to another image');
      selectedImages.push(...parseThreadImages([{ ...reference.image, reference: number }])!);
      reference.imageReference = number;
      delete reference.image;
    }
    if (reference.attachment) {
      let index = attachments.findIndex(selection => JSON.stringify(selection) === JSON.stringify(reference.attachment));
      if (index < 0) { index = attachments.length; attachments.push(reference.attachment); }
      quoteAttachmentIndices.set(reference.ref, index);
      // The caller's copy cannot nominate a prepared descriptor independently of the owner.
      delete reference.attachmentRef;
    } else if (reference.attachmentRef) throw new Error('A quoted file requires its original attachment selection');
  }
  // Automatic file-image media may follow these images. Fix their numbers now so
  // the raw retry intent and the later prepared payload use the same identities.
  if (attachments.length || selectedImages.some(image => image.reference !== undefined)) {
    for (const image of selectedImages) if (image.reference === undefined) image.reference = ++nextImage;
  }
  return { quotes, images: selectedImages.length ? selectedImages : images, attachments, bind(files: readonly Attachment[]): ContentReferenceInput {
    for (const reference of quotes.contentReferences ?? []) {
      const index = quoteAttachmentIndices.get(reference.ref);
      if (index !== undefined) {
        const attachment = files[index];
        if (!attachment) throw new Error('Quoted attachment was not prepared by its original owner');
        reference.attachmentRef = attachment.ref;
      }
    }
    return quotes;
  } };
}
