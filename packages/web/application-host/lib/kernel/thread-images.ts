import type { ImageAttachment } from '@varin/protocol';

/** Validate untrusted HTTP media once. Never accept arbitrary URL/file references from this path. */
export function parseThreadImages(value: unknown): ImageAttachment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Images must be an array');
  return value.map(image => {
    if (!image || typeof image !== 'object' || Array.isArray(image)
      || Object.keys(image).some(key => key !== 'mimeType' && key !== 'data')
      || typeof image.mimeType !== 'string' || !/^image\/[a-zA-Z0-9.+-]+$/.test(image.mimeType)
      || typeof image.data !== 'string' || !image.data.length
      || Buffer.from(image.data, 'base64').toString('base64') !== image.data) throw new Error('Malformed image attachment');
    return { mimeType: image.mimeType, data: image.data };
  });
}

export function threadInput(text: string, images?: readonly ImageAttachment[]) {
  return { ...(text.length || !images?.length ? { text } : {}), ...(images?.length ? { attachments: images.map(image => ({
    media_type: image.mimeType,
    content_ref: `data:${image.mimeType};base64,${image.data}`,
    source: 'user-upload',
  })) } : {}) };
}
