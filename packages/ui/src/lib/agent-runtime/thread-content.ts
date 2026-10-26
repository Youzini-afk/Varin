import type { OutputBody, StoredMedia } from '@varin/protocol';

const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export type ThreadContentPart =
  | { kind: 'text'; text: string }
  | { kind: 'media'; media: StoredMedia; partIndex: number; imageReference?: number }
  | { kind: 'output'; output: OutputBody }
  | { kind: 'data'; data: unknown }
  | { kind: 'status'; text: string };

function isMedia(value: unknown): value is StoredMedia {
  const media = record(value);
  return typeof media?.media_type === 'string' && typeof record(media.content_ref)?.content_object === 'string'
    && typeof record(media.source)?.kind === 'string';
}
function isOutput(value: unknown): value is OutputBody {
  const output = record(value);
  return !!output && Object.hasOwn(output, 'data') && Array.isArray(output.parts) && output.parts.every(part => {
    const value = record(part);
    return value?.kind === 'text' ? typeof value.text === 'string' : value?.kind === 'media' && isMedia(value.media);
  });
}
/** Only call at an explicitly declared output-body boundary, never to infer a JSON value's kind. */
export function parseThreadOutput(value: unknown): OutputBody {
  if (!isOutput(value)) throw new Error('The original report output is invalid. Retry the report read.');
  return value;
}
export function inputText(content: unknown): string {
  return typeof content === 'string' ? content : typeof record(content)?.text === 'string' ? record(content)!.text as string : '';
}
/** Called only for the original user input holder, not arbitrary tool data. */
export function inputParts(content: unknown): ThreadContentPart[] {
  if (typeof content === 'string') return [{ kind: 'text', text: content }];
  const value = record(content);
  if (!value) return [{ kind: 'status', text: 'Input content unavailable. Refresh this conversation.' }];
  const parts: ThreadContentPart[] = [];
  if (typeof value.text === 'string') parts.push({ kind: 'text', text: value.text });
  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments)) parts.push({ kind: 'status', text: 'Input media is invalid. Refresh this conversation.' });
    else value.attachments.forEach((media, partIndex) => parts.push(isMedia(media) ? { kind: 'media', media, partIndex,
      ...(Array.isArray(value.imageReferences) ? { imageReference: value.imageReferences[partIndex] as number } : {}) }
      : { kind: 'status', text: 'Input media is unavailable. Refresh this conversation.' }));
  }
  return parts;
}
/** Public semantic history only. Output.data is opaque and is never recursively interpreted. */
export function historyParts(content: unknown, source: string): ThreadContentPart[] {
  if (source === 'user') return inputParts(content);
  const value = record(record(content)?.content);
  if (!value) return [{ kind: 'data', data: content }];
  switch (value.kind) {
    case 'text': case 'reasoning_summary': return typeof value.text === 'string' ? [{ kind: 'text', text: value.text }] : unavailable();
    case 'media': return isMedia(value.media) ? [{ kind: 'media', media: value.media, partIndex: 0 }] : unavailable();
    case 'output': return isOutput(value.output) ? [{ kind: 'output', output: value.output }] : unavailable();
    case 'tool_call': return [{ kind: 'text', text: `Tool: ${String(record(value.call)?.name ?? '')}` }, { kind: 'data', data: value.call }];
    case 'tool_result': {
      const completion = record(record(value.result)?.completion);
      if (!completion) return unavailable();
      if (completion.kind === 'not_dispatched') return [{ kind: 'status', text: `Not dispatched: ${String(completion.reason ?? '')}` }];
      if (completion.kind !== 'result' && completion.kind !== 'job_accepted') return unavailable();
      const { content: output, ...facts } = completion;
      return [{ kind: 'data', data: facts }, ...(output === undefined && completion.kind === 'job_accepted' ? [] : isOutput(output)
        ? [{ kind: 'output' as const, output }] : unavailable())];
    }
    case 'provider_only': return [];
    default: return [{ kind: 'data', data: content }];
  }
}
function unavailable(): ThreadContentPart[] { return [{ kind: 'status', text: 'This content could not be displayed. Refresh the conversation and read the original record.' }]; }
