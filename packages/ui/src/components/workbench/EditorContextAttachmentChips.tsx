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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { MaterialLinkContext } from '@/components/materials/MaterialLinkContext';
import { formatPdfMaterialCitationUrl } from '@/lib/materials/pdfMaterialCitation';
import { ReferenceNavigationContext } from '@/components/conversation/ReferenceNavigation';

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
  const [preview, setPreview] = React.useState<EditorContextAttachment>();
  const navigation = React.useContext(ReferenceNavigationContext);
  const openMaterial = React.useContext(MaterialLinkContext);
  const referenceSource = preview?.reference?.source;
  const entryId = referenceSource && referenceSource.kind !== 'document' ? referenceSource.itemId
    ?? (referenceSource.kind === 'chat' ? referenceSource.passages[0]?.entryId : undefined) : undefined;
  const canLocate = referenceSource?.kind === 'document' ? Boolean(openMaterial) : Boolean(entryId && navigation?.revealEntry
    && referenceSource?.thread?.threadId === navigation.identity.threadId && referenceSource.thread.branchId === navigation.identity.branchId);
  const locate = () => {
    const source = referenceSource; if (!source || !canLocate) return;
    setPreview(undefined);
    if (source.kind === 'document') openMaterial?.(formatPdfMaterialCitationUrl(source), preview!.reference!.title);
    else if (entryId) void Promise.resolve().then(() => navigation?.revealEntry?.(entryId)).catch(failure => toast.error(failure.message));
  };
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
          {item.reference ? <button className="max-w-[min(18rem,55vw)] truncate" onClick={() => setPreview(item)} type="button">
            {item.label} · {item.reference.text?.slice(0, 28) || item.reference.title}
          </button> : <span className="max-w-[min(18rem,55vw)] truncate">{t(labelFor(item), { name: item.label })}</span>}
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
      {preview?.reference && <Dialog open onOpenChange={open => { if (!open) setPreview(undefined); }}><DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{preview.label} · {preview.reference.title}</DialogTitle></DialogHeader>
        {preview.reference.text && <blockquote className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border p-3 text-sm">{preview.reference.text}</blockquote>}
        {preview.reference.image && <img className="max-h-[65vh] object-contain" src={`data:${preview.reference.image.mimeType};base64,${preview.reference.image.data}`} alt={preview.label} />}
        <p className="text-xs text-muted-foreground">{preview.reference.ref}</p>
        {canLocate && <Button variant="outline" onClick={locate}>{t('ui.content.locateSource')}</Button>}
      </DialogContent></Dialog>}
    </div>
  );
};
