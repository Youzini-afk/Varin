import { useDirectoryStore } from '@/stores/useDirectoryStore';
import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useWorkbenchWorkspaceId } from '@/lib/extensions/workbench-workspace';
import { attachActiveEditorContext } from '@/features/agent-editor/attach-active-editor';
import {
  getEditorContextAttachmentsRevision,
  listEditorContextAttachments,
  subscribeEditorContextAttachments,
} from '@/lib/agent-editor/attachments';
import { threadHostKey as getRuntimeKey } from '@/stores/useThreadStore';
import { useEditorContextStore } from '@/stores/useEditorContextStore';

export const ActiveEditorSuggestion: React.FC<{ threadKey: string }> = ({ threadKey }) => {
  const { t } = useI18n();
  const workspaceId = useWorkbenchWorkspaceId();
  const workspaceRoot = useDirectoryStore(state => state.currentDirectory);
  const activeEditorFile = useEditorContextStore((state) => state.activeEditorFile);
  const runtimeKey = getRuntimeKey();
  React.useSyncExternalStore(
    subscribeEditorContextAttachments,
    getEditorContextAttachmentsRevision,
    () => 0,
  );
  const attachments = listEditorContextAttachments(runtimeKey, threadKey, workspaceId);

  if (
    !workspaceRoot || !activeEditorFile
    || !workspaceId
    || activeEditorFile.runtimeKey !== runtimeKey
    || (activeEditorFile.workspaceId !== null && activeEditorFile.workspaceId !== workspaceId)
  ) return null;

  const relativePath = activeEditorFile.relativePath.replace(/\\/g, '/');
  const selectionAttached = attachments.some((item) => (
    item.kind === 'selection' && item.resourceId.replace(/\\/g, '/') === relativePath
  ));
  const fileAttached = attachments.some((item) => (
    item.kind === 'editor' && item.resourceId.replace(/\\/g, '/') === relativePath
  ));
  const showSelection = Boolean(activeEditorFile.selection) && !selectionAttached;
  const showFile = !showSelection && !fileAttached;
  if (!showSelection && !showFile) return null;

  const selection = activeEditorFile.selection;
  const range = selection
    ? selection.startLine === selection.endLine
      ? `${selection.startLine}`
      : `${selection.startLine}-${selection.endLine}`
    : '';
  const label = showSelection
    ? `${activeEditorFile.fileName}:${range}`
    : activeEditorFile.fileName;
  const actionLabel = showSelection
    ? t('chat.fileAttachment.activeEditor.pinSelection')
    : t('chat.fileAttachment.activeEditor.addFile', { name: activeEditorFile.fileName });
  const unsaved = activeEditorFile.dirty || showSelection;

  return (
    <div className="mb-2 flex min-w-0 items-center">
      <button
        type="button"
        title={`${actionLabel} · ${activeEditorFile.relativePath}`}
        aria-label={actionLabel}
        onClick={() => {
          attachActiveEditorContext({
            threadKey,
            workspaceId,
            workspaceRoot: workspaceRoot,
            kind: showSelection ? 'selection' : 'editor',
          });
        }}
        className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-dashed border-[var(--syntax-punctuation)] bg-transparent px-2 py-1 typography-micro italic text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
      >
        <Icon name={showSelection ? 'pushpin-2' : 'add'} className="size-3.5 shrink-0" />
        <Icon name="file-code" className="size-3.5 shrink-0" />
        <span className="max-w-[min(22rem,65vw)] truncate">{label}</span>
        {unsaved ? (
          <span className="shrink-0 not-italic">{t('workbench.attachment.unsavedBadge')}</span>
        ) : null}
      </button>
    </div>
  );
};
