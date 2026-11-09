import React from 'react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { getDocumentRegistry } from '@/lib/documents/session';
import { useDocumentRecord } from '@/lib/documents/hooks';
import type { DocumentIdentity } from '@/lib/documents/types';
import { useI18n } from '@/lib/i18n';

const codecs = [
  { encoding: 'utf-8', label: 'UTF-8', bom: false },
  { encoding: 'gbk', label: 'GBK', bom: false },
  { encoding: 'utf-16le', label: 'UTF-16 LE', bom: true },
  { encoding: 'utf-16be', label: 'UTF-16 BE', bom: true },
] as const;

/** Rare format actions live in existing file menus; opening normal text asks nothing. */
export function DocumentEncodingMenuItems({ identity }: { identity: DocumentIdentity }) {
  const { t } = useI18n();
  const record = useDocumentRecord(identity);
  const ready = record?.status === 'ready';
  const save = (encoding: string, bom: boolean) => {
    const registry = getDocumentRegistry();
    registry.setFormat(identity, { encoding, bom });
    // The document retains the typed error and draft. Do not add another toast or modal.
    void registry.save(identity).catch(() => undefined);
  };
  return <>
    <DropdownMenuSeparator />
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={!record || record.dirty || record.saving}
        title={record?.dirty ? t('filesView.encoding.reopenDirty') : undefined}>{t('filesView.encoding.reopen')}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>{codecs.map(codec => <DropdownMenuItem key={codec.encoding}
        onSelect={() => { void getDocumentRegistry().reopenWithEncoding(identity, codec.encoding).catch(() => undefined); }}>{codec.label}</DropdownMenuItem>)}</DropdownMenuSubContent>
    </DropdownMenuSub>
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={!ready || record?.saving}>{t('filesView.encoding.save')}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {codecs.map(codec => <DropdownMenuItem key={codec.encoding} onSelect={() => save(codec.encoding, codec.bom)}>{codec.label}</DropdownMenuItem>)}
        <DropdownMenuItem onSelect={() => save('utf-8', true)}>UTF-8 BOM</DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={!ready || record?.saving}>{t('filesView.encoding.lineEndings')}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>{(['lf', 'crlf', 'cr'] as const).map(lineEnding => <DropdownMenuItem key={lineEnding}
        onSelect={() => getDocumentRegistry().setFormat(identity, { lineEnding })}>{lineEnding.toUpperCase()}</DropdownMenuItem>)}</DropdownMenuSubContent>
    </DropdownMenuSub>
    <DropdownMenuItem disabled={!ready || record?.saving || !getDocumentRegistry().canUndoFormat(identity)} onSelect={() => { getDocumentRegistry().undoFormat(identity); }}>{t('filesView.encoding.undoFormat')}</DropdownMenuItem>
  </>;
}

export function DocumentEncodingMenu({ identity, children }: { identity: DocumentIdentity; children: React.ReactElement }) {
  return <DropdownMenu modal={false}><DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
    <DropdownMenuContent align="end"><DocumentEncodingMenuItems identity={identity} /></DropdownMenuContent>
  </DropdownMenu>;
}

/** A failed save stays next to the editable draft, never replaces it with an error screen. */
export function DocumentEncodingNotice({ identity }: { identity: DocumentIdentity }) {
  const record = useDocumentRecord(identity);
  const { t } = useI18n();
  if (!record?.errorMessage || !['ready', 'deleted'].includes(record.status)) return null;
  const currentSaveFailure = record.saveErrorRevision === record.localEditRevision;
  return <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 typography-micro text-status-error">
    <span className="min-w-0 flex-1">{record.errorMessage}</span>
    {currentSaveFailure && record.saveErrorReason === 'unrepresentable' && record.encoding !== 'utf-8' ? <button type="button"
      disabled={record.saving} className="shrink-0 text-foreground underline underline-offset-2" onClick={() => {
        const registry = getDocumentRegistry();
        registry.setFormat(identity, { encoding: 'utf-8', bom: false });
        void registry.save(identity).catch(() => undefined);
      }}>{t('filesView.encoding.saveUtf8')}</button> : null}
  </div>;
}
