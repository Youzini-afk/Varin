import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { threadHostKey as getRuntimeKey } from '@/stores/useThreadStore';
import {
  getEditorContextAttachmentsRevision,
  listEditorContextAttachments,
  removeEditorContextAttachment,
  subscribeEditorContextAttachments,
} from '@/lib/agent-editor/attachments';
import type { EditorContextAttachment } from '@/lib/agent-editor/types';

type EditorContextAttachmentChipsProps = {
  threadKey: string | null | undefined;
};

const labelFor = (attachment: EditorContextAttachment): I18nKey => {
  if (attachment.kind === 'diagnostic') return 'workbench.attachment.chipDiagnostic';
  if (attachment.kind === 'test-failure') return 'workbench.attachment.chipTestFailure';
  if (attachment.kind === 'stack') return 'workbench.attachment.chipStack';
  if (attachment.kind === 'diff') return 'workbench.attachment.chipDiff';
  if (attachment.kind === 'selection') return 'workbench.attachment.chipSelection';
  return attachment.source === 'unsaved-buffer' ? 'workbench.attachment.chipUnsaved' : 'workbench.attachment.chipSaved';
};

export const EditorContextAttachmentChips: React.FC<EditorContextAttachmentChipsProps> = ({ threadKey }) => {
  const { t } = useI18n();
  const runtimeKey = getRuntimeKey();
  React.useSyncExternalStore(
    subscribeEditorContextAttachments,
    getEditorContextAttachmentsRevision,
    () => 0,
  );
  const items = threadKey ? listEditorContextAttachments(runtimeKey, threadKey) : [];
  if (!threadKey || items.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span
          key={item.id}
          className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-1 typography-micro"
        >
          <Icon name={item.source === 'unsaved-buffer' ? 'file-edit' : 'file-code'} className="size-3.5 shrink-0" />
          <span className="max-w-[min(18rem,55vw)] truncate">
            {t(labelFor(item), { name: item.label })}
          </span>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            aria-label={t('workbench.attachment.removeAria', { name: item.label })}
            onClick={() => removeEditorContextAttachment(item.id, runtimeKey, threadKey)}
          >
            <Icon name="close" className="size-3.5" />
          </button>
        </span>
      ))}
    </div>
  );
};
