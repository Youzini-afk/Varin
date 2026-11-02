import type { ExternalItem } from '@varin/application-client';
import { record, text } from './transport.js';

type Item = Omit<ExternalItem, 'turnId'>;

export function acpContent(value: unknown): Pick<Item, 'text' | 'images'> {
  const content = record(value);
  if (content.type === 'text') return { text: text(content.text) };
  if (
    content.type === 'image' &&
    text(content.data) &&
    text(content.mimeType).startsWith('image/')
  )
    return {
      text: '',
      images: [{ data: text(content.data), mimeType: text(content.mimeType) }],
    };
  if (content.type === 'resource_link')
    return {
      text: [text(content.title) || text(content.name), text(content.uri)]
        .filter(Boolean)
        .join('\n'),
    };
  if (content.type === 'resource') {
    const resource = record(content.resource);
    return {
      text: [text(resource.uri), text(resource.text)]
        .filter(Boolean)
        .join('\n'),
    };
  }
  return { text: '' };
}

export function acpToolItem(
  update: Record<string, unknown>,
  previous?: Item,
): Item | undefined {
  const id = text(update.toolCallId);
  if (!id) return undefined;
  const blocks = Array.isArray(update.content) ? update.content : undefined;
  const rendered = blocks?.map((value) => {
    const block = record(value);
    if (block.type === 'content') return acpContent(block.content);
    if (block.type === 'diff')
      return {
        text: `--- ${text(block.path)}\n${text(block.oldText)}\n+++ ${text(block.path)}\n${text(block.newText)}`,
      };
    if (block.type === 'terminal')
      return { text: `Terminal: ${text(block.terminalId)}` };
    return { text: '' };
  });
  const output = rendered
    ?.map((value) => value.text)
    .filter(Boolean)
    .join('\n');
  const images = rendered?.flatMap((value) =>
    'images' in value ? (value.images ?? []) : [],
  );
  const locations = Array.isArray(update.locations) ? update.locations : [];
  const diff = blocks?.map(record).find((value) => value.type === 'diff');
  const path =
    text(diff?.path) || text(record(locations[0]).path) || previous?.tool?.path;
  const input = Object.hasOwn(update, 'rawInput')
    ? update.rawInput
    : previous?.tool?.input;
  const result = Object.hasOwn(update, 'rawOutput')
    ? update.rawOutput
    : (output ?? previous?.tool?.output);
  const command = text(record(input).command) || previous?.tool?.command;
  const status =
    update.status === 'completed'
      ? 'completed'
      : update.status === 'failed'
        ? 'failed'
        : update.status === 'pending' || update.status === 'in_progress'
          ? 'running'
          : (previous?.tool?.status ?? 'running');
  return {
    id,
    kind: 'tool',
    text: '',
    complete: status !== 'running',
    ...(images?.length
      ? { images }
      : rendered === undefined && previous?.images
        ? { images: previous.images }
        : {}),
    tool: {
      name:
        text(update.title) ||
        previous?.tool?.name ||
        text(update.kind) ||
        'Tool',
      ...(input === undefined ? {} : { input }),
      ...(result === undefined ? {} : { output: result }),
      status,
      ...(path ? { path } : {}),
      ...(command ? { command } : {}),
    },
  };
}
