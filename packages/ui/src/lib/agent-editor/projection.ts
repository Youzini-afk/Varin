import type { ContentReference } from '@varin/application-client';
import type { EditorContextAttachment } from './types';

const fenceFor = (content: string): string => {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
};

const languageFence = (languageId: string | undefined, content: string): string => {
  const fence = fenceFor(content);
  const language = languageId && /^[a-z0-9_+#-]+$/i.test(languageId) ? languageId : '';
  return `${fence}${language}\n${content}\n${fence}`;
};

const formatOne = (attachment: EditorContextAttachment, includeImages?: boolean, showSource = false): string => {
  if (attachment.reference) {
    const selection = attachment.reference;
    return [`[${attachment.label} · ${selection.label ?? selection.title}]`,
      selection.text ? languageFence('', selection.text) : '',
      selection.image && includeImages === false ? 'Image not supplied to the current model; the original file remains available.' : '',
    ].filter(Boolean).join('\n');
  }
  const pathLine = [`- Resource: ${attachment.resourceId}`, showSource && attachment.sourceLabel ? `- Source: ${attachment.sourceLabel}` : ''].filter(Boolean).join('\n');
  const rangeLine = attachment.range
    ? `- Range: ${attachment.range.startLine}:${attachment.range.startColumn}-${attachment.range.endLine}:${attachment.range.endColumn}` : '';
  const unsavedLine = attachment.source === 'unsaved-buffer' ? 'Unsaved editor content; file tools read the saved file on disk.' : '';
  if (attachment.kind === 'diagnostic') {
    return [
      `Attached problem for \`${attachment.label}\`:`,
      pathLine,
      `- Message: ${attachment.diagnosticMessage ?? attachment.label}`,
      rangeLine,
      unsavedLine,
      attachment.text ? languageFence(attachment.languageId, attachment.text) : '',
    ].filter(Boolean).join('\n');
  }
  if (attachment.kind === 'test-failure') {
    return [
      `Attached test failure for \`${attachment.label}\`:`,
      pathLine,
      `- Message: ${attachment.diagnosticMessage ?? attachment.label}`,
      attachment.text ? languageFence('', attachment.text) : '',
      rangeLine,
      unsavedLine,
    ].filter(Boolean).join('\n');
  }
  if (attachment.kind === 'stack') {
    return [
      `Attached stack frame for \`${attachment.label}\`:`,
      pathLine,
      `- Frame: ${attachment.diagnosticMessage ?? attachment.label}`,
      rangeLine,
      unsavedLine,
      attachment.text ? languageFence(attachment.languageId, attachment.text) : '',
    ].filter(Boolean).join('\n');
  }
  if (attachment.kind === 'diff') {
    const patch = attachment.patch ?? '';
    return [
      `Attached diff for \`${attachment.label}\`:`,
      pathLine,
      unsavedLine,
      languageFence('diff', patch),
    ].join('\n');
  }
  if (attachment.source === 'unsaved-buffer') {
    const range = attachment.range
      ? `- Range: ${attachment.range.startLine}:${attachment.range.startColumn}-${attachment.range.endLine}:${attachment.range.endColumn}`
      : '- Range: entire buffer';
    return [
      `Attached unsaved editor snapshot for \`${attachment.label}\`.`,
      pathLine,
      unsavedLine,
      range,
      languageFence(attachment.languageId, attachment.text ?? ''),
    ].join('\n');
  }
  return [
    `Attached saved file \`${attachment.label}\`.`,
    pathLine,
    rangeLine,
  ].filter(Boolean).join('\n');
};

export const projectEditorContextAttachments = (
  text: string,
  items: readonly EditorContextAttachment[],
  options?: { includeImages: boolean },
): string => {
  if (items.length === 0) return text;
  const projected = items.map(item => formatOne(item, options?.includeImages, items.some(other =>
    other.resourceId === item.resourceId && (other.workspaceId !== item.workspaceId || other.sourceLabel !== item.sourceLabel),
  ))).join('\n\n');
  return text.trim() ? `${text}\n\n${projected}` : projected;
};

/** Project a fixed source without putting it in, or consuming, the user's attachment strip. */
export function projectContentReference(text: string, reference: ContentReference, includeImages: boolean): string {
  return projectEditorContextAttachments(text, [{ reference, ordinal: 1, id: reference.ref, resourceId: reference.ref,
    label: reference.title, runtimeKey: '', threadKey: '', workspaceId: '', documentInstanceId: null,
    documentRevision: null, localEditRevision: 0, source: 'saved', kind: 'reference' }], { includeImages });
}
