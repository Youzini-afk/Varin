import React from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { MarkdownImageAsset, MarkdownImageItem } from './markdownImages';

export function MarkdownImageViewer({ items, initialIndex, load, onClose }: {
  items: MarkdownImageItem[]; initialIndex: number;
  load(source: string, signal: AbortSignal): Promise<MarkdownImageAsset>;
  onClose(): void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(true);
  const [index, setIndex] = React.useState(initialIndex);
  const [retained, setRetained] = React.useState<{ source: string; asset: MarkdownImageAsset }>();
  const [failedSource, setFailedSource] = React.useState<string>();
  const [retry, setRetry] = React.useState(0);
  const [dimensions, setDimensions] = React.useState({ source: '', width: 0, height: 0 });
  const [viewportSize, setViewportSize] = React.useState({ width: 0, height: 0 });
  const [zoom, setZoom] = React.useState(1);
  const viewport = React.useRef<HTMLDivElement>(null);
  const detachViewport = React.useRef<(() => void) | undefined>(undefined);
  const attachViewport = React.useCallback((element: HTMLDivElement | null) => {
    detachViewport.current?.(); detachViewport.current = undefined;
    viewport.current = element; if (!element) return;
    const measure = () => setViewportSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault(); setZoom(value => value * Math.exp(-event.deltaY * 0.002));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    detachViewport.current = () => { observer?.disconnect(); element.removeEventListener('wheel', wheel); };
  }, []);
  const pointer = React.useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const originals = React.useRef(new Map<string, { controller: AbortController; result: Promise<MarkdownImageAsset> }>());
  const item = items[index]!;
  const originalSource = item.originalSource ?? item.source;
  const error = failedSource === originalSource;
  const asset = retained?.source === item.source ? retained.asset : undefined;
  const size = dimensions.source === item.source ? dimensions : { width: 0, height: 0 };
  React.useEffect(() => {
    let active = true;
    setRetained(undefined); setFailedSource(undefined); setZoom(1);
    let cached = originals.current.get(originalSource);
    if (!cached) {
      const controller = new AbortController();
      cached = { controller, result: load(originalSource, controller.signal) };
      originals.current.set(originalSource, cached);
    }
    void cached.result.then(value => { if (active) setRetained({ source: item.source, asset: value }); }, () => { if (active) setFailedSource(originalSource); });
    return () => { active = false; };
  }, [item.source, originalSource, load, retry]);
  React.useEffect(() => {
    const cache = originals.current;
    return () => {
      for (const asset of cache.values()) { asset.controller.abort(); void asset.result.then(value => value.release?.(), () => {}); }
      cache.clear();
    };
  }, []);
  const fit = size.width && size.height && viewportSize.width && viewportSize.height ? Math.min(1, viewportSize.width / size.width, viewportSize.height / size.height) : 1;
  const scale = fit * zoom;
  const rendered = { width: size.width * scale, height: size.height * scale };
  const previous = React.useRef({ width: 0, height: 0 });
  React.useLayoutEffect(() => {
    const element = viewport.current, old = previous.current;
    if (element && old.width && old.height) {
      element.scrollLeft = (element.scrollLeft + element.clientWidth / 2) / old.width * Math.max(rendered.width, element.clientWidth) - element.clientWidth / 2;
      element.scrollTop = (element.scrollTop + element.clientHeight / 2) / old.height * Math.max(rendered.height, element.clientHeight) - element.clientHeight / 2;
    }
    previous.current = { width: Math.max(rendered.width, viewportSize.width), height: Math.max(rendered.height, viewportSize.height) };
  }, [rendered.width, rendered.height, viewportSize.width, viewportSize.height]);
  const step = (delta: number) => setIndex(value => (value + delta + items.length) % items.length);
  const button = (label: string, icon: React.ComponentProps<typeof Icon>['name'], action: () => void) =>
    <button type="button" className="md-image-viewer-action" title={label} aria-label={label} onClick={action}><Icon name={icon} className="size-4" /></button>;
  return <Dialog open={open} onOpenChange={setOpen} onOpenChangeComplete={next => { if (!next) onClose(); }}>
    <DialogContent className="md-image-viewer" onKeyDown={event => {
      if (items.length < 2 || event.target instanceof HTMLInputElement) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); step(event.key === 'ArrowLeft' ? -1 : 1); }
    }}>
      <div className="md-image-viewer-toolbar">
        <DialogTitle className="min-w-0 flex-1 truncate typography-ui-label">{item.label || t('chat.media.image')}</DialogTitle>
        {items.length > 1 && <div className="md-image-viewer-navigation">
          {button(t('chat.toolOutputDialog.image.previousAria'), 'arrow-left-s', () => step(-1))}
          <span className="typography-micro tabular-nums">{index + 1} / {items.length}</span>
          {button(t('chat.toolOutputDialog.image.nextAria'), 'arrow-right-s', () => step(1))}
        </div>}
        {button(t('markdownRenderer.mermaid.actions.zoomOutTitle'), 'subtract', () => setZoom(value => value / 1.25))}
        <button type="button" className="md-image-viewer-action md-image-viewer-scale typography-micro" onClick={() => setZoom(1)} title={t('chat.images.fit')}>{size.width ? `${Math.round(scale * 100)}%` : '—'}</button>
        {button(t('markdownRenderer.mermaid.actions.zoomInTitle'), 'add', () => setZoom(value => value * 1.25))}
        <button type="button" className="md-image-viewer-action typography-micro" onClick={() => setZoom(1 / fit)} title={t('chat.images.actualSize')}>1:1</button>
        {asset && <a className="md-image-viewer-action" href={asset.src} download target="_blank" rel="noopener noreferrer" title={t('chat.media.download')} aria-label={t('chat.media.download')}><Icon name="download" className="size-4" /></a>}
      </div>
      <div ref={attachViewport} className="md-image-viewer-viewport" data-zoomed={zoom > 1} onPointerDown={event => {
        if (event.button !== 0 || event.pointerType === 'touch') return;
        const element = event.currentTarget;
        pointer.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
        element.setPointerCapture(event.pointerId);
      }} onPointerMove={event => {
        const drag = pointer.current; if (!drag) return;
        event.currentTarget.scrollLeft = drag.left + drag.x - event.clientX;
        event.currentTarget.scrollTop = drag.top + drag.y - event.clientY;
      }} onPointerUp={() => { pointer.current = null; }} onPointerCancel={() => { pointer.current = null; }} onLostPointerCapture={() => { pointer.current = null; }}>
        {error ? <button type="button" className="md-image-viewer-empty typography-meta" onClick={() => {
          const cached = originals.current.get(originalSource);
          cached?.controller.abort(); if (cached) void cached.result.then(value => value.release?.(), () => {});
          originals.current.delete(originalSource); setRetry(value => value + 1);
        }}>{t('chat.images.failed')} · {t('chat.media.retry')}</button>
          : <>
            {!size.width && <span role="status" className="md-image-viewer-empty typography-meta">{t('chat.media.loading')}</span>}
            {asset && <div className="md-image-viewer-plane" style={{ width: Math.max(rendered.width, viewportSize.width), height: Math.max(rendered.height, viewportSize.height) }}>
              <img src={asset.src} alt={item.label} draggable={false} referrerPolicy="no-referrer" decoding="async" onError={() => setFailedSource(originalSource)}
                onLoad={event => setDimensions({ source: item.source, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
                style={size.width ? { width: rendered.width, height: rendered.height } : { visibility: 'hidden' }} />
            </div>}
          </>}
      </div>
    </DialogContent>
  </Dialog>;
}
