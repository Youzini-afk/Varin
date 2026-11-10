import { createHash } from 'node:crypto';
import type { VarinTextFormat } from '@varin/application-client';
import { DocumentAuthorityError } from './errors.js';

export const revisionFromBytes = (bytes: Buffer | Uint8Array): string => (
  `d1_${createHash('sha256').update(bytes).digest('base64url')}`
);

/** Transport adapter only. Rust is the sole file codec and strict serializer. */
export interface DocumentTextCodec {
  textEncodings?(): Promise<import('@varin/application-client').VarinTextCodec[]>;
  textDecode(input: { bytesBase64: string; encoding?: string; defaultEncoding?: string; includeContent?: boolean }): Promise<
    | { kind: 'text'; content?: string; format: VarinTextFormat; byteLength: number }
    | { kind: 'binary' | 'unsupported-encoding'; byteLength: number; message?: string; candidates?: string[] }>;
  textSerialize(input: { content: string; sourceBytesBase64?: string; sourceFormat?: VarinTextFormat;
    targetFormat?: { encoding?: string; bom?: boolean; lineEnding?: 'lf' | 'crlf' | 'cr' | 'mixed' }; normalizeLineEndings?: boolean;
    edits?: Array<{ start: number; end: number; text: string }> }): Promise<
    | { kind: 'serialized'; bytesBase64: string; format: VarinTextFormat; byteLength: number }
    | { kind: 'unrepresentable'; encoding: string; position: number; character: string; message: string }
    | { kind: 'invalid' | 'binary' | 'unsupported-encoding'; message: string }>;
}
const codecBindings: Array<{ codec: DocumentTextCodec }> = [];
/** The Application Host binds its existing kernel; this does not create another writer or authority. */
export const bindDocumentTextCodec = (codec: DocumentTextCodec): (() => void) => {
  const binding = { codec };
  codecBindings.push(binding);
  return () => {
    const index = codecBindings.indexOf(binding);
    if (index !== -1) codecBindings.splice(index, 1);
  };
};
const codec = (): DocumentTextCodec => {
  const nativeCodec = codecBindings.at(-1)?.codec;
  if (!nativeCodec) throw new DocumentAuthorityError('Native text service is unavailable', { code: 'failed', statusCode: 503 });
  return nativeCodec;
};

/** The native owner supplies labels and actual capabilities; never mirror its registry in JS. */
export const documentTextEncodings = async (): Promise<import('@varin/application-client').VarinTextCodec[]> => {
  const nativeCodec = codec();
  if (!nativeCodec.textEncodings) throw new DocumentAuthorityError('Native text encoding catalog is unavailable', { code: 'failed', statusCode: 503 });
  return nativeCodec.textEncodings();
};

/** Format validation, not byte decoding. Aliases are resolved by the native codec. */
export const isDocumentEncoding = (value: unknown): value is string => typeof value === 'string'
  && value.trim().length > 0;

export const isDocumentTextFormat = (value: unknown): value is VarinTextFormat => {
  if (!value || typeof value !== 'object') return false;
  const format = value as VarinTextFormat;
  return isDocumentEncoding(format.encoding) && typeof format.bom === 'boolean'
    && ['lf', 'crlf', 'cr', 'mixed', 'none'].includes(format.lineEnding)
    && ['lf', 'crlf', 'cr'].includes(format.defaultLineEnding) && typeof format.source === 'string';
};

/** Structural validation only. Native validates ordering, baseline bounds and exact outcome. */
export const isDocumentTextEdits = (value: unknown): value is Array<{ start: number; end: number; text: string }> =>
  Array.isArray(value) && value.every(edit => edit && typeof edit === 'object'
    && Number.isSafeInteger(edit.start) && Number.isSafeInteger(edit.end)
    && edit.start >= 0 && edit.end >= edit.start && typeof edit.text === 'string');

export const sameDocumentTextFormat = (left: VarinTextFormat | undefined, right: VarinTextFormat | undefined): boolean =>
  left === right || Boolean(left && right && left.encoding === right.encoding && left.bom === right.bom
    && left.lineEnding === right.lineEnding && left.defaultLineEnding === right.defaultLineEnding);

export type InspectedDocument =
  | { kind: 'binary'; byteLength: number }
  | { kind: 'unsupported-encoding'; byteLength: number; candidates?: string[] }
  | { kind: 'text'; encoding: string; bom: boolean; format: VarinTextFormat; content: string; byteLength: number };
export type InspectedDocumentMetadata = Exclude<InspectedDocument, { kind: 'text' }>
  | Omit<Extract<InspectedDocument, { kind: 'text' }>, 'content'>;
export interface InspectDocumentOptions { encoding?: string; defaultEncoding?: string }
export function inspectDocumentBytes(input: Buffer | Uint8Array, includeContent?: true, options?: InspectDocumentOptions): Promise<InspectedDocument>;
export function inspectDocumentBytes(input: Buffer | Uint8Array, includeContent: false, options?: InspectDocumentOptions): Promise<InspectedDocumentMetadata>;
export async function inspectDocumentBytes(input: Buffer | Uint8Array, includeContent = true, options: InspectDocumentOptions = {}): Promise<InspectedDocument | InspectedDocumentMetadata> {
  const result = await codec().textDecode({ bytesBase64: Buffer.from(input).toString('base64'), includeContent, ...options });
  if (result.kind !== 'text') return result;
  if (includeContent && typeof result.content !== 'string') throw new Error('Native text read returned no content');
  return { kind: 'text', encoding: result.format.encoding, bom: result.format.bom, format: result.format,
    byteLength: result.byteLength, ...(includeContent ? { content: result.content! } : {}) };
}
export interface EncodeDocumentTextOptions {
  content: string; encoding: string; bom: boolean;
  sourceBytes?: Uint8Array; sourceFormat?: VarinTextFormat;
  lineEnding?: 'lf' | 'crlf' | 'cr' | 'mixed'; normalizeLineEndings?: boolean;
  edits?: Array<{ start: number; end: number; text: string }>;
}
export const serializeDocumentText = async (options: EncodeDocumentTextOptions) => {
  // JSON would replace lone surrogates before Rust can inspect a string. Reject them at this boundary.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(options.content)) throw new DocumentAuthorityError('The document contains an unpaired Unicode surrogate', { code: 'invalid-text', statusCode: 400 });
  const result = await codec().textSerialize({ content: options.content,
    ...(options.sourceBytes ? { sourceBytesBase64: Buffer.from(options.sourceBytes).toString('base64') } : {}),
    ...(options.sourceFormat ? { sourceFormat: options.sourceFormat } : {}),
    targetFormat: { encoding: options.encoding, bom: options.bom, ...(options.lineEnding ? { lineEnding: options.lineEnding } : {}) },
    ...(options.normalizeLineEndings === undefined ? {} : { normalizeLineEndings: options.normalizeLineEndings }),
    ...(options.edits ? { edits: options.edits } : {}),
  });
  if (result.kind !== 'serialized') throw new DocumentAuthorityError(result.message,
    { code: result.kind === 'unrepresentable' ? 'unrepresentable' : 'invalid-text', statusCode: 400 });
  return { bytes: Buffer.from(result.bytesBase64, 'base64'), format: result.format, byteLength: result.byteLength };
};
export const encodeDocumentText = async (options: EncodeDocumentTextOptions): Promise<Buffer> => (await serializeDocumentText(options)).bytes;
