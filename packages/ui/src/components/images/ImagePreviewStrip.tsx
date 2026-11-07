import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';

export function ImagePreviewStrip({ items, onPreview, onRemove, onReference, removeLabel, editable }: {
  items: readonly { id: string; src: string; reference?: number; edited?: boolean }[];
  onPreview(index: number, editing: boolean): void;
  onRemove?(index: number): void; onReference?(reference: number): void;
  removeLabel?: string; editable?: boolean;
}) {
  const { t } = useI18n();
  return <div className="flex flex-wrap gap-2">
    {items.map((image, index) => <div key={image.id} className="composer-attachment group/image relative overflow-hidden rounded-lg border border-border bg-muted/20">
      <button type="button" onClick={() => onPreview(index, false)} aria-label={`${t('chat.media.view')} ${image.reference ?? index + 1}`}
        className="block rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        <img src={image.src || undefined} alt={t('chat.imageReference.token', { number: image.reference ?? index + 1 })} className="size-20 object-cover" />
      </button>
      {onReference ? <button type="button" onMouseDown={event => event.preventDefault()}
        onClick={() => onReference(image.reference ?? index + 1)}
        title={t('chat.imageReference.insert', { number: image.reference ?? index + 1 })}
        aria-label={t('chat.imageReference.insert', { number: image.reference ?? index + 1 })}
        className="absolute bottom-1 left-1 min-w-5 rounded bg-background/85 px-1.5 py-0.5 text-[11px] leading-4 tabular-nums text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        {image.reference ?? index + 1}
      </button> : <span className="pointer-events-none absolute bottom-1 left-1 min-w-5 rounded bg-background/85 px-1.5 py-0.5 text-center text-[11px] leading-4 tabular-nums text-muted-foreground">{image.reference ?? index + 1}</span>}
      {onRemove && <button type="button" onClick={() => onRemove(index)}
        className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-background/90 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground group-hover/image:opacity-100 focus:opacity-100"
        aria-label={removeLabel}>
        <Icon name="close" className="size-3.5" />
      </button>}
      {image.edited ? <span className="composer-image-edited" title={t('imageEditor.edited')} /> : null}
      {editable && <button type="button" className="composer-image-annotate" aria-label={t('imageEditor.annotate')} onClick={() => onPreview(index, true)}><Icon name="pencil" className="size-3.5"/></button>}
    </div>)}
  </div>;
}
