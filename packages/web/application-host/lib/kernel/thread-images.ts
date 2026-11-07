import type { ImageAttachment } from '@varin/protocol';

export function parseAttachmentImageReferences(value: unknown, images?: readonly ImageAttachment[]): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Attachment image references must be an object');
  const used = new Set(images?.flatMap(image => image.reference === undefined ? [] : [image.reference]));
  return Object.fromEntries(Object.entries(value).map(([ref, number]) => {
    if (!ref.startsWith('attachment:') || !Number.isSafeInteger(number) || Number(number) < 1 || used.has(number as number)) throw new Error('Image references must be distinct positive integers');
    used.add(number as number);
    return [ref, number as number];
  }));
}

/** Validate untrusted HTTP media once. Never accept arbitrary URL/file references from this path. */
export function parseThreadImages(value: unknown): ImageAttachment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Images must be an array');
  const references = new Set<number>();
  return value.map(image => {
    if (!image || typeof image !== 'object' || Array.isArray(image)
      || Object.keys(image).some(key => key !== 'mimeType' && key !== 'data' && key !== 'reference')
      || typeof image.mimeType !== 'string' || !/^image\/[a-zA-Z0-9.+-]+$/.test(image.mimeType)
      || typeof image.data !== 'string' || !image.data.length
      || Buffer.from(image.data, 'base64').toString('base64') !== image.data) throw new Error('Malformed image attachment');
    if (image.reference !== undefined && (!Number.isSafeInteger(image.reference) || image.reference < 1 || references.has(image.reference))) {
      throw new Error('Image references must be distinct positive integers');
    }
    if (image.reference !== undefined) references.add(image.reference);
    return { mimeType: image.mimeType, data: image.data, ...(image.reference === undefined ? {} : { reference: image.reference }) };
  });
}

export function threadInput(text: string, images?: readonly ImageAttachment[]) {
  let nextReference = Math.max(0, ...(images ?? []).map(image => image.reference ?? 0));
  const imageReferences = images?.some(image => image.reference !== undefined)
    ? images.map(image => image.reference ?? ++nextReference) : undefined;
  return { ...(text.length || !images?.length ? { text } : {}), ...(images !== undefined ? { attachments: images.map(image => ({
    media_type: image.mimeType,
    data_base64: image.data,
  })) } : {}), ...(imageReferences ? { imageReferences } : {}) };
}
