import type { IncomingMedia, OutputPart } from './nested-tools.generated.js';

/** The producer boundary carries bytes only. Storage identities and provenance are owner-authored. */
export function parseIncomingOutputPart(value: unknown): OutputPart<IncomingMedia> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid output part');
  const part = value as Record<string, unknown>;
  if (part.kind === 'text' && typeof part.text === 'string' && Object.keys(part).every(key => key === 'kind' || key === 'text')) {
    return { kind: 'text', text: part.text };
  }
  if (part.kind === 'media' && Object.keys(part).every(key => key === 'kind' || key === 'media') && part.media && typeof part.media === 'object' && !Array.isArray(part.media)) {
    const media = part.media as Record<string, unknown>;
    if (Object.keys(media).every(key => key === 'media_type' || key === 'data_base64')
      && typeof media.media_type === 'string' && /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(media.media_type)
      && typeof media.data_base64 === 'string' && canonicalBase64(media.data_base64)) {
      return { kind: 'media', media: { media_type: media.media_type, data_base64: media.data_base64 } };
    }
  }
  throw new Error('Invalid output part');
}

function canonicalBase64(value: string): boolean {
  if (!value.length || value.length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const body = value.slice(0, value.length - padding);
  if (/[^A-Za-z0-9+/]/u.test(body)) return false;
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(body.at(-1) ?? '');
  return padding === 0 || (last >= 0 && (last & (padding === 2 ? 15 : 3)) === 0);
}
