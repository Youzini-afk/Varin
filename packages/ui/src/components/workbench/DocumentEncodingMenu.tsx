import React from 'react';
import type { DocumentRegistry } from '@/lib/documents/registry';
import type { VarinTextCodec } from '@varin/application-client';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MenuHighlight } from '@/components/ui/MenuHighlight';
import { getDocumentRegistry } from '@/lib/documents/session';
import { useDocumentRecord } from '@/lib/documents/hooks';
import type { DocumentIdentity } from '@/lib/documents/types';
import { useI18n } from '@/lib/i18n';

function EncodingChoices({ codecs, current, currentBom, onSelect }: {
  codecs: VarinTextCodec[]; current?: string; currentBom?: boolean; onSelect: (codec: VarinTextCodec) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = React.useState('');
  const search = query.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const matches = codecs.filter(codec => `${codec.label} ${codec.encoding}`.toLowerCase().replace(/[\s_-]+/g, '').includes(search));
  return <>
    <div className="shrink-0 border-b border-border/60 px-1 pt-1 pb-2">
      <input aria-label={t('filesView.encoding.search')} placeholder={t('filesView.encoding.search')}
        className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 typography-ui outline-none focus:border-ring"
        value={query} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key !== 'Escape' && event.key !== 'Tab' && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') event.stopPropagation(); }} />
    </div>
    <div data-menu-highlight="" className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pt-1">
      <MenuHighlight />
      {matches.map(codec => <DropdownMenuItem key={`${codec.encoding}:${codec.defaultBom}`} onSelect={() => onSelect(codec)}>
        <span className="flex-1">{codec.label}</span>{current === codec.encoding && (currentBom === undefined || currentBom === codec.defaultBom) ? <span aria-hidden="true">✓</span> : null}
      </DropdownMenuItem>)}
      {matches.length === 0 ? <div className="px-2 py-2 typography-micro text-muted-foreground">{t('filesView.encoding.noMatches')}</div> : null}
    </div>
  </>;
}

/** Rare format actions live in existing file menus; opening normal text asks nothing. */
export function DocumentEncodingMenuItems({ identity, registry: providedRegistry }: { identity: DocumentIdentity; registry?: DocumentRegistry }) {
  const { t } = useI18n();
  const registry = providedRegistry ?? getDocumentRegistry();
  const record = useDocumentRecord(identity, registry);
  const [codecs, setCodecs] = React.useState<VarinTextCodec[]>([]);
  const [catalogError, setCatalogError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    void registry.textEncodings().then(value => { if (active) { setCodecs(value); setCatalogError(null); } }, error => {
      if (active) setCatalogError(error instanceof Error ? error.message : String(error));
    });
    return () => { active = false; };
  }, [registry, attempt]);
  const ready = record?.status === 'ready';
  const save = (encoding: string, bom: boolean) => {
    registry.setFormat(identity, { encoding, bom });
    // The document retains the typed error and draft. Do not add another toast or modal.
    void registry.save(identity).catch(() => undefined);
  };
  return <>
    <DropdownMenuSeparator />
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={!record || record.dirty || record.saving || codecs.length === 0}
        title={record?.dirty ? t('filesView.encoding.reopenDirty') : undefined}>{t('filesView.encoding.reopen')}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="flex max-h-[min(24rem,70dvh,var(--available-height))] min-w-60 flex-col overflow-hidden">
        <EncodingChoices codecs={codecs.filter(codec => codec.read)} current={record?.encoding}
          onSelect={codec => { void registry.reopenWithEncoding(identity, codec.encoding).catch(() => undefined); }} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={!ready || record?.saving || codecs.length === 0}>{t('filesView.encoding.save')}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="flex max-h-[min(24rem,70dvh,var(--available-height))] min-w-60 flex-col overflow-hidden">
        <EncodingChoices codecs={codecs.filter(codec => codec.write).flatMap(codec => codec.bom ? [
          { ...codec, label: codec.defaultBom ? `${codec.label} BOM` : codec.label },
          { ...codec, label: codec.defaultBom ? codec.label : `${codec.label} BOM`, defaultBom: !codec.defaultBom },
        ] : [codec])}
          current={record?.encoding} currentBom={record?.bom} onSelect={codec => save(codec.encoding, codec.defaultBom)} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
    {catalogError ? <DropdownMenuItem title={catalogError} onSelect={event => { event.preventDefault(); setAttempt(value => value + 1); }}>{t('filesView.encoding.retry')}</DropdownMenuItem> : null}
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={!ready || record?.saving}>{t('filesView.encoding.lineEndings')}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>{(['lf', 'crlf', 'cr'] as const).map(lineEnding => <DropdownMenuItem key={lineEnding}
        onSelect={() => registry.setFormat(identity, { lineEnding })}>{lineEnding.toUpperCase()}</DropdownMenuItem>)}</DropdownMenuSubContent>
    </DropdownMenuSub>
    <DropdownMenuItem disabled={!ready || record?.saving || !registry.canUndoFormat(identity)} onSelect={() => { registry.undoFormat(identity); }}>{t('filesView.encoding.undoFormat')}</DropdownMenuItem>
  </>;
}

export function DocumentEncodingMenu({ identity, children, registry }: { identity: DocumentIdentity; children: React.ReactElement; registry?: DocumentRegistry }) {
  return <DropdownMenu modal={false}><DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
    <DropdownMenuContent align="end"><DocumentEncodingMenuItems identity={identity} registry={registry} /></DropdownMenuContent>
  </DropdownMenu>;
}

/** A failed save stays next to the editable draft, never replaces it with an error screen. */
export function DocumentEncodingNotice({ identity, registry: providedRegistry }: { identity: DocumentIdentity; registry?: DocumentRegistry }) {
  const registry = providedRegistry ?? getDocumentRegistry();
  const record = useDocumentRecord(identity, registry);
  const { t } = useI18n();
  if (!record?.errorMessage || !['ready', 'deleted'].includes(record.status)) return null;
  const currentSaveFailure = record.saveErrorRevision === record.localEditRevision;
  return <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 typography-micro text-status-error">
    <span className="min-w-0 flex-1">{record.errorMessage}</span>
    {currentSaveFailure && record.saveErrorReason === 'unrepresentable' && record.encoding !== 'utf-8' ? <button type="button"
      disabled={record.saving} className="shrink-0 text-foreground underline underline-offset-2" onClick={() => {
        registry.setFormat(identity, { encoding: 'utf-8', bom: false });
        void registry.save(identity).catch(() => undefined);
      }}>{t('filesView.encoding.saveUtf8')}</button> : null}
  </div>;
}
