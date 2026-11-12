import type { DocumentsAPI } from '@varin/application-client';
import { formatMessage, useI18nStore } from '@/lib/i18n/store';
import { isBinaryFile, isImageFile, isPdfFile, looksLikeBinaryText } from '@/lib/toolHelpers';
import { DocumentsError } from '@varin/application-client';
import { readWorkspaceTextFile } from '@/lib/documents/workspace-text';

const t = (key: Parameters<typeof formatMessage>[1], params?: Parameters<typeof formatMessage>[2]) =>
  formatMessage(useI18nStore.getState().dictionary, key, params);

export type ContextFileOpenFailureReason = 'missing' | 'unreadable' | 'binary';

export type ContextFileOpenValidationResult =
  | { ok: true }
  | { ok: false; reason: ContextFileOpenFailureReason };

export type ContextFileOpenOptions = {
  directory: string;
  resource?: import('@/lib/documents/types').DocumentIdentity;
};

const classifyReadError = (error: unknown): ContextFileOpenFailureReason => {
  if (error instanceof DocumentsError && error.reason === 'path-escape') {
    return 'unreadable';
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();

  if (
    normalized.includes('file not found')
    || normalized.includes('not found')
    || normalized.includes('enoent')
    || normalized.includes('no such file')
    || normalized.includes('does not exist')
    || normalized.includes('missing')
  ) {
    return 'missing';
  }

  return 'unreadable';
};

/**
 * Validate whether a context-panel click may open a path in the shared file editor.
 * Previewable/non-text binaries are allowed through so FilesView can show image/PDF
 * preview or the cannot-preview empty state — never by decoding them as editable text here.
 */
export const validateContextFileOpen = async (
  documents: DocumentsAPI,
  path: string,
  options: ContextFileOpenOptions,
): Promise<ContextFileOpenValidationResult> => {
  if (isBinaryFile(path) || isPdfFile(path) || isImageFile(path)) {
    return { ok: true };
  }

  try {
    const read = options.resource ? await documents.read(options.resource) : undefined;
    if (read && read.status !== 'ready') return { ok: false, reason: read.status === 'missing' ? 'missing' : 'binary' };
    const content = read?.status === 'ready' ? read.content : await readWorkspaceTextFile(documents, options.directory, path);
    if (content === null) {
      return { ok: false, reason: 'missing' };
    }
    if (looksLikeBinaryText(content)) {
      return { ok: false, reason: 'binary' };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: classifyReadError(error) };
  }
};

export const getContextFileOpenFailureMessage = (reason: ContextFileOpenFailureReason): string => {
  if (reason === 'missing') {
    return t('contextFileOpen.failure.missing');
  }

  if (reason === 'binary') {
    return t('filesView.editor.cannotPreviewBinary');
  }

  return t('contextFileOpen.failure.unreadable');
};
