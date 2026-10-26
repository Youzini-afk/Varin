import React from 'react';
import type { ImageAttachment } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { imageAttachmentUrl } from './imageAttachments';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';

export function ImageAttachmentStrip({ images, removeLabel, onRemove, onReference }: {
  images: readonly ImageAttachment[];
  removeLabel?: string;
  onRemove?: (index: number) => void;
  onReference?: (reference: number) => void;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = React.useState<ImageAttachment | null>(null);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const visiblePreview = preview && images.includes(preview) ? preview : null;
  if (!images.length) return null;
  return <><div className="flex flex-wrap gap-2 px-3 pt-3">
    {images.map((image, index) => <div key={image.reference ?? index} className="composer-attachment group/image relative overflow-hidden rounded-lg border border-border bg-muted/20">
      <button type="button" onClick={() => { setPreview(image); setPreviewOpen(true); }} aria-label={`${t('chat.media.view')} ${image.reference ?? index + 1}`}
        className="block rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        <img src={imageAttachmentUrl(image)} alt={t('chat.imageReference.token', { number: image.reference ?? index + 1 })} className="size-20 object-cover" />
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
    </div>)}
  </div><Dialog open={previewOpen && Boolean(visiblePreview)} onOpenChange={setPreviewOpen}>
    <DialogContent className="max-w-[90vw] p-2"><DialogTitle className="sr-only">{t('chat.media.image')}</DialogTitle>
      {visiblePreview && <img src={imageAttachmentUrl(visiblePreview)} alt={t('chat.media.image')} className="max-h-[85vh] w-full object-contain" />}
    </DialogContent>
  </Dialog></>;
}
