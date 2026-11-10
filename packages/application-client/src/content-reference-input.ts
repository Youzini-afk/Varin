import { parseAttachmentSelections } from '@varin/protocol';
import type { ContentReference, ContentReferenceInput, ContentReferenceOccurrence } from './content-reference.js';

function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function required(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function boundary(text: string, index: number): boolean { return index <= 0 || index >= text.length || !(text.charCodeAt(index - 1) >= 0xd800 && text.charCodeAt(index - 1) <= 0xdbff && text.charCodeAt(index) >= 0xdc00 && text.charCodeAt(index) <= 0xdfff); }
/** Validate and copy selected objects before any asynchronous preparation. Sources are
 * retained metadata, not authority to read a file, navigate another Host or run a tool. */
export function parseContentReferenceInput(input: ContentReferenceInput, text: string): ContentReferenceInput {
  if (input.contentReferences === undefined && input.contentReferenceOccurrences === undefined) return {};
  if (input.contentReferences !== undefined && !Array.isArray(input.contentReferences) || input.contentReferenceOccurrences !== undefined && !Array.isArray(input.contentReferenceOccurrences)) throw new Error('Quote objects and occurrences must be arrays');
  const ids = new Map<string, ContentReference>();
  const numbers = new Set<number>();
  const contentReferences = (input.contentReferences ?? []).map((value, index): ContentReference => {
    const object = record(value), source = record(object?.source);
    if (!object || Object.keys(object).some(key => !['ref', 'title', 'number', 'label', 'text', 'image', 'imageReference', 'attachment', 'attachmentRef', 'source'].includes(key))
      || !required(object.ref) || !required(object.title) || !source || !['ui', 'object', 'chat', 'document', 'file', 'tool'].includes(String(source.kind))
      || object.text !== undefined && typeof object.text !== 'string' || object.label !== undefined && typeof object.label !== 'string'
      || object.imageReference !== undefined && !positive(object.imageReference) || object.attachmentRef !== undefined && !required(object.attachmentRef)) throw new Error('Invalid frozen quote object');
    const number = object.number ?? index + 1;
    if (!positive(number) || ids.has(object.ref) || (object.imageReference === undefined || Boolean(object.text)) && numbers.has(number)) throw new Error('Quotes need unique identities and positive numbers');
    const image = record(object.image);
    if (object.image !== undefined && (!image || Object.keys(image).some(key => !['mimeType', 'data'].includes(key)) || !required(image.mimeType) || !required(image.data))) throw new Error('Invalid quote image');
    if (object.attachment !== undefined) parseAttachmentSelections([object.attachment]);
    if (object.text === undefined && object.image === undefined && object.imageReference === undefined && object.attachment === undefined && object.attachmentRef === undefined) throw new Error('Quote has no selected content');
    const reference = structuredClone({ ...value, number });
    ids.set(reference.ref, reference); if (reference.imageReference === undefined || reference.text) numbers.add(number);
    return reference;
  });
  const contentReferenceOccurrences = (input.contentReferenceOccurrences ?? []).map((value): ContentReferenceOccurrence => {
    const object = record(value);
    if (!object || !['content', 'image'].includes(String(object.kind)) || Object.keys(object).some(key => !['kind', object.kind === 'content' ? 'ref' : 'reference', 'start', 'end'].includes(key))
      || typeof object.start !== 'number' || typeof object.end !== 'number' || !Number.isSafeInteger(object.start) || !Number.isSafeInteger(object.end)
      || object.start < 0 || object.start >= object.end || object.end > text.length || !boundary(text, object.start) || !boundary(text, object.end)) throw new Error('Invalid quote occurrence range');
    // Explicit ranges bind objects; translated marker spelling is presentation only.
    if (object.kind === 'content') {
      const reference = typeof object.ref === 'string' ? ids.get(object.ref) : undefined;
      if (!reference) throw new Error('Quote occurrence does not identify its selected content');
    } else if (!positive(object.reference)) throw new Error('Image occurrence does not identify its bound image');
    return { ...value };
  });
  const sorted = [...contentReferenceOccurrences].sort((a, b) => a.start - b.start);
  if (sorted.some((entry, index) => index > 0 && entry.start < sorted[index - 1]!.end)) throw new Error('Quote occurrence ranges overlap');
  return { contentReferences, contentReferenceOccurrences };
}

/** External Harnesses receive the same readable selection semantics. Their own adapter
 * still supplies actual images/files through its native capabilities and attachment owner. */
export function projectContentReferenceText(text: string, input: ContentReferenceInput): string {
  const parsed = parseContentReferenceInput(input, text);
  if (parsed.contentReferences === undefined) return text;
  const references = parsed.contentReferences;
  const seen = new Set<string>();
  const quote = (reference: ContentReference): string => {
    if (seen.has(reference.ref)) return !reference.text && reference.imageReference !== undefined ? `[图片${reference.imageReference}]` : `[引用点${reference.number}]`;
    seen.add(reference.ref);
    if (!reference.text && reference.imageReference !== undefined) return `[图片${reference.imageReference}]`;
    const label = reference.label ?? (reference.source.kind === 'chat' ? reference.source.role === 'user' ? '用户消息' : reference.source.role === 'tool' ? '工具结果' : 'Varin'
      : reference.source.kind === 'tool' ? '工具结果' : ['file', 'document'].includes(reference.source.kind) ? '文件' : '交互内容');
    return `\n[引用点${reference.number} · ${label}]\n${reference.text === undefined ? '' : `${reference.text.split('\n').map(line => `> ${line}`).join('\n')}\n`}${reference.imageReference === undefined ? '' : `[图片${reference.imageReference}]`}`;
  };
  let result = '', offset = 0;
  for (const occurrence of [...parsed.contentReferenceOccurrences ?? []].sort((a, b) => a.start - b.start)) {
    result += text.slice(offset, occurrence.start);
    if (occurrence.kind === 'content') result += quote(references.find(reference => reference.ref === occurrence.ref)!);
    else {
      result += text.slice(occurrence.start, occurrence.end);
      for (const reference of references) if (reference.imageReference === occurrence.reference && !reference.text) seen.add(reference.ref);
    }
    offset = occurrence.end;
  }
  result += text.slice(offset);
  for (const reference of references) if (!seen.has(reference.ref)) result += quote(reference);
  return result;
}
