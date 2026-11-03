import React from 'react';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { DraftSelectedAttachment } from '@/stores/useThreadDraftStore';

export function ComposerSelectedFiles({ files = [], locked, onRemove }: { files?: readonly DraftSelectedAttachment[]; locked: boolean; onRemove(id: string): void }) {
  const { t } = useI18n();
  return files.length ? <div role="group" aria-label={t('chat.attachments.files')} className="flex flex-wrap gap-2">
    {files.map(file => <div key={file.id} className="flex min-w-0 max-w-full items-start gap-2 rounded-lg border border-border/60 p-2 typography-meta">
      <FileTypeIcon filePath={file.filename} className="size-5 shrink-0" />
      <span className="min-w-0"><span className="block break-words">{file.filename}</span><span className="block break-all typography-micro text-muted-foreground">{'path' in file.selection ? file.selection.path : t('chat.attachments.ready')}</span>
        {'path' in file.selection && <span className="block typography-micro text-muted-foreground">{t('composer.file.onSend')}</span>}</span>
      <button type="button" disabled={locked} onClick={() => onRemove(file.id)} aria-label={t('chat.attachments.remove', { name: file.filename })} className="text-muted-foreground hover:text-foreground disabled:opacity-40"><Icon name="close" className="size-4" /></button>
    </div>)}
  </div> : null;
}
