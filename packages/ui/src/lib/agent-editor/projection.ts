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

const formatOne = (attachment: EditorContextAttachment, includeImages?: boolean): string => {
  if (attachment.reference) {
    const selection = attachment.reference;
    return [`Reference point ${attachment.ordinal}: ${selection.title}`, `- Reference: ${selection.ref}`,
      `- Source: ${JSON.stringify(selection.source)}`,
      selection.text ? languageFence('', selection.text) : '',
      selection.image && includeImages === false ? 'Image not supplied to the current model; the source reference and selected text remain available.' : '',
    ].filter(Boolean).join('\n');
  }
  const pathLine = `- Resource: ${attachment.resourceId}`;
  const revisionLine = `- Disk revision: ${attachment.documentRevision ?? 'none'}`;
  const localLine = `- Editor revision: ${attachment.localEditRevision}`;
  if (attachment.kind === 'diagnostic') {
    return [
      `Attached problem for \`${attachment.label}\`:`,
      pathLine,
      `- Message: ${attachment.diagnosticMessage ?? attachment.label}`,
      attachment.range ? `- Line: ${attachment.range.startLine}` : '',
    ].filter(Boolean).join('\n');
  }
  if (attachment.kind === 'test-failure') {
    return [
      `Attached test failure for \`${attachment.label}\`:`,
      pathLine,
      `- Message: ${attachment.diagnosticMessage ?? attachment.label}`,
      attachment.text ? languageFence('', attachment.text) : '',
      'This is citation text only. It does not grant process, debug, or test-runner capability.',
    ].filter(Boolean).join('\n');
  }
  if (attachment.kind === 'stack') {
    return [
      `Attached stack frame for \`${attachment.label}\`:`,
      pathLine,
      `- Frame: ${attachment.diagnosticMessage ?? attachment.label}`,
      attachment.range ? `- Line: ${attachment.range.startLine}` : '',
      'This is citation text only. It does not grant process or debugger capability.',
    ].filter(Boolean).join('\n');
  }
  if (attachment.kind === 'diff') {
    const patch = attachment.patch ?? '';
    return [
      `Attached diff for \`${attachment.label}\`:`,
      pathLine,
      revisionLine,
      languageFence('diff', patch),
    ].join('\n');
  }
  if (attachment.source === 'unsaved-buffer') {
    const range = attachment.range
      ? `- Range: ${attachment.range.startLine}:${attachment.range.startColumn}-${attachment.range.endLine}:${attachment.range.endColumn}`
      : '- Range: entire buffer';
    return [
      `Attached unsaved editor snapshot for \`${attachment.label}\`.`,
      'This text is a prompt snapshot. File tools do not see this buffer on disk.',
      pathLine,
      revisionLine,
      localLine,
      range,
      languageFence(attachment.languageId, attachment.text ?? ''),
    ].join('\n');
  }
  return [
    `Attached saved file \`${attachment.label}\`.`,
    'The admitted source determines file access. Unsaved editor buffers are not included.',
    pathLine,
    revisionLine,
    localLine,
  ].join('\n');
};

export const projectEditorContextAttachments = (
  text: string,
  items: readonly EditorContextAttachment[],
  options?: { includeImages: boolean },
): string => {
  if (items.length === 0) return text;
  const projected = items.map(item => formatOne(item, options?.includeImages)).join('\n\n');
  return text.trim() ? `${text}\n\n${projected}` : projected;
};
