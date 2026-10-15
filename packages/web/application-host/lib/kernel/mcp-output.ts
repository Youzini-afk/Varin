/** Explicit MCP protocol projection. Unknown JSON is never a media capability. */
import type { IncomingMedia, OutputBody, OutputPart } from './protocol.generated.js';
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function projectMcpOutput(result: Record<string, unknown>, kind: 'tool' | 'resource' | 'prompt'): OutputBody<IncomingMedia> {
  const parts: OutputPart<IncomingMedia>[] = [];
  const append = (part: OutputPart<IncomingMedia>) => {
    const index = parts.length;
    parts.push(part);
    return { outputPartIndex: index };
  };
  const resource = (value: unknown): unknown => {
    if (!object(value)) return value;
    const projected = { ...value };
    if (typeof value.text === 'string') projected.text = append({ kind: 'text', text: value.text });
    if (typeof value.blob === 'string') projected.blob = append({
      kind: 'media', media: {
        media_type: value.mimeType === undefined ? 'application/octet-stream' : typeof value.mimeType === 'string' ? value.mimeType : '',
        data_base64: value.blob,
      }
    });
    return projected;
  };
  const content = (value: unknown): unknown => {
    if (!object(value)) return value;
    if (value.type === 'text' && typeof value.text === 'string') return { ...value, text: append({ kind: 'text', text: value.text }) };
    if ((value.type === 'image' || value.type === 'audio') && typeof value.data === 'string') return {
      ...value, data: append({
        kind: 'media', media: {
          media_type: typeof value.mimeType === 'string' ? value.mimeType : '', data_base64: value.data,
        }
      }),
    };
    if (value.type === 'resource') return { ...value, resource: resource(value.resource) };
    return value;
  };
  let data: Record<string, unknown> = result;
  if (kind === 'tool' && Array.isArray(result.content)) data = { ...result, content: result.content.map(content) };
  if (kind === 'resource' && Array.isArray(result.contents)) data = { ...result, contents: result.contents.map(resource) };
  if (kind === 'prompt' && Array.isArray(result.messages)) data = {
    ...result, messages: result.messages.map(message => object(message) ? { ...message, content: content(message.content) } : message),
  };
  return { data, parts };
}
