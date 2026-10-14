import { threadHostKey as getRuntimeKey } from '@/stores/useThreadStore';
import { getDocumentRegistry } from '@/lib/documents/session';
import { languageIdFromResourceId } from '@/lib/language-services/language-id';
import { addEditorContextAttachment } from './attachments';
import { sliceDocumentRange } from './range';
import type { EditorContextAttachment, EditorContextAttachmentKind, EditorContextRange } from './types';

const fileNameOf = (resourceId: string): string => resourceId.split('/').pop() || resourceId;

export const attachEditorContext = (input: {
  threadKey: string;
  workspaceId: string;
  resourceId: string;
  kind: EditorContextAttachmentKind;
  range?: EditorContextRange;
  diagnosticMessage?: string;
  patch?: string;
  label?: string;
  text?: string;
}): EditorContextAttachment | { status: 'wrong-runtime' } | { status: 'missing-document' } => {
  const runtimeKey = getRuntimeKey();
  const identity = { workspaceId: input.workspaceId, resourceId: input.resourceId };
  const record = getDocumentRegistry().get(identity);
  const dirty = record?.dirty === true;
  const source = input.kind === 'selection' || (dirty && (input.kind === 'editor' || input.kind === 'diff'))
    ? 'unsaved-buffer'
    : 'saved';
  let text: string | undefined;
  if (source === 'unsaved-buffer') {
    if (!record) return { status: 'missing-document' };
    text = input.range ? sliceDocumentRange(record.buffer, input.range) : record.buffer;
  }
  const attachment: EditorContextAttachment = {
    id: crypto.randomUUID(),
    runtimeKey,
    threadKey: input.threadKey,
    workspaceId: input.workspaceId,
    resourceId: input.resourceId,
    label: input.label ?? fileNameOf(input.resourceId),
    documentInstanceId: record?.documentInstanceId ?? null,
    documentRevision: record?.baseRevision ?? null,
    localEditRevision: record?.localEditRevision ?? 0,
    source,
    kind: input.kind,
  };
  if (input.range) attachment.range = input.range;
  if (input.kind !== 'diff') attachment.languageId = languageIdFromResourceId(input.resourceId);
  if (text !== undefined) attachment.text = text;
  if (input.diagnosticMessage) attachment.diagnosticMessage = input.diagnosticMessage;
  if (input.patch) attachment.patch = input.patch;
  if (input.text !== undefined) attachment.text = input.text;
  return addEditorContextAttachment(attachment);
};
