import { isAbsolute } from 'node:path';
import type { ModelTokenizer } from '@varin/application-client';
import { object } from './configuration.js';

export const TOKENIZER_ENCODINGS = ['o200k_base', 'o200k_harmony', 'cl100k_base', 'p50k_base', 'p50k_edit', 'r50k_base'];
export const normalizeEncodingName = (name: string): string => name.trim().toLowerCase().replaceAll('-', '_');
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
export function validTokenizer(value: unknown): value is ModelTokenizer {
  if (!object(value)) return false;
  switch (value.kind) {
    case 'encoding': return typeof value.name === 'string' && TOKENIZER_ENCODINGS.includes(normalizeEncodingName(value.name));
    case 'huggingface': return text(value.repository) && value.repository.split('/').length <= 2
      && value.repository.split('/').every(part => /^[\w.-]+$/.test(part) && part !== '.' && part !== '..')
      && (value.revision === undefined || text(value.revision));
    case 'file': return text(value.path) && isAbsolute(value.path);
    case 'url': {
      if (!text(value.url)) return false;
      try { const url = new URL(value.url); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash; }
      catch { return false; }
    }
    default: return false;
  }
}

/** Directories can name public resources. Local files require an explicit saved user choice. */
export function discoveredTokenizer(raw: Record<string, unknown>): ModelTokenizer | undefined {
  if (validTokenizer(raw.tokenizer) && raw.tokenizer.kind !== 'file') return raw.tokenizer.kind === 'encoding'
    ? { kind: 'encoding', name: normalizeEncodingName(raw.tokenizer.name) } : raw.tokenizer;
  if (typeof raw.tokenizer === 'string' && TOKENIZER_ENCODINGS.includes(normalizeEncodingName(raw.tokenizer))) return { kind: 'encoding', name: normalizeEncodingName(raw.tokenizer) };
  const repository = raw.hugging_face_id ?? raw.huggingface_id;
  const candidate = { kind: 'huggingface', repository };
  return validTokenizer(candidate) ? candidate : undefined;
}
