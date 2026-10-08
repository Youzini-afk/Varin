import React from 'react';
import type { ImageAttachment } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { imageAttachmentUrl } from './imageAttachments';

export function ImageAttachmentStrip({ images, removeLabel, onRemove }: {
  images: readonly ImageAttachment[];
  removeLabel?: string;
  onRemove?: (index: number) => void;
}) {
  if (!images.length) return null;
  return <div className="flex flex-wrap gap-2 px-3 pt-3">
    {images.map((image, index) => <div key={`${image.mimeType}:${index}`} className="pi-composer-attachment group/image relative overflow-hidden rounded-lg border border-border bg-muted/20">
      <img src={imageAttachmentUrl(image)} alt={image.mimeType} className="size-20 object-cover" />
      {onRemove && <button type="button" onClick={() => onRemove(index)}
        className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-background/90 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground group-hover/image:opacity-100 focus:opacity-100"
        aria-label={removeLabel}>
        <Icon name="close" className="size-3.5" />
      </button>}
    </div>)}
  </div>;
}
