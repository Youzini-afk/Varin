import { isImageHref, markdownImagePlaceholder } from './imageSources';

export interface MarkdownImageLabels {
  view: string; loading: string; retry: string; failed: string; long: string;
}
export interface MarkdownImageAsset {
  src: string; width?: number; height?: number; release?(): void;
}
export interface MarkdownImageItem { source: string; originalSource?: string; label: string; asset?: MarkdownImageAsset }
type ImageEntry = { item: MarkdownImageItem; signature: string; image: HTMLImageElement | null; dispose?(): void };
const originalReaders = new WeakMap<HTMLElement, (signal: AbortSignal) => Promise<MarkdownImageAsset>>();
/** Preserve the source owner's exact reader across morphs and list unmounts. */
export function captureMarkdownImageReader(element: HTMLElement) {
  const reference = element.closest<HTMLElement>('[data-md-image-src],[data-md-image-link]');
  return reference ? originalReaders.get(reference) : undefined;
}
export function readMarkdownImageOriginal(element: HTMLElement, signal: AbortSignal) {
  const reference = element.closest<HTMLElement>('[data-md-image-src]');
  return reference ? originalReaders.get(reference)?.(signal) : undefined;
}

export function decorateMarkdownImages(root: HTMLElement, labels: MarkdownImageLabels) {
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href], a[data-md-image-href]')) {
    if (anchor.querySelector('[data-md-image-src]')) {
      const original = anchor.getAttribute('data-md-image-href') ?? anchor.getAttribute('href') ?? '';
      if (isImageHref(original)) for (const image of anchor.querySelectorAll('[data-md-image-src]')) image.setAttribute('data-md-image-original', original);
      anchor.replaceWith(...anchor.childNodes); continue;
    }
    const href = anchor.getAttribute('data-md-image-href') ?? anchor.getAttribute('href') ?? '';
    if (!isImageHref(href) || anchor.closest('pre, code')) continue;
    if (anchor.closest('[data-md-image-gallery]')) {
      const temp = root.ownerDocument.createElement('span');
      temp.innerHTML = markdownImagePlaceholder(href, anchor.textContent ?? '', anchor.getAttribute('title'));
      anchor.replaceWith(...temp.childNodes);
    } else {
      anchor.setAttribute('data-md-image-link', '');
      if (!anchor.hasAttribute('href')) anchor.setAttribute('href', '#');
    }
  }
  // First paint parses the whole message, subsequent paints reconcile blocks.
  // Both paths create the same gallery before anything becomes visible.
  for (const gallery of root.querySelectorAll<HTMLElement>('p[data-md-image-gallery]')) {
    let next = gallery.nextSibling;
    while (next) {
      if (next.nodeType === 3 && !next.textContent?.trim()) { const after = next.nextSibling; next.remove(); next = after; continue; }
      if (!(next instanceof root.ownerDocument.defaultView!.HTMLElement) || !next.matches('p[data-md-image-gallery]')) break;
      const after = next.nextSibling;
      gallery.append(...next.childNodes); next.remove(); next = after;
    }
  }
  for (const image of root.querySelectorAll<HTMLElement>('[data-md-image-src]')) {
    if (image.hasAttribute('data-md-image-ready')) continue;
    image.setAttribute('data-md-image-ready', '');
    image.className = 'md-image';
    const label = image.getAttribute('data-md-image-title') || image.getAttribute('data-md-image-alt') || '';
    const button = root.ownerDocument.createElement('button');
    button.type = 'button'; button.className = 'md-image-frame'; button.setAttribute('aria-label', label ? `${labels.view}: ${label}` : labels.view);
    const img = root.ownerDocument.createElement('img');
    img.alt = image.getAttribute('data-md-image-alt') ?? ''; img.decoding = 'async'; img.draggable = false;
    img.referrerPolicy = 'no-referrer';
    const status = root.ownerDocument.createElement('span');
    status.className = 'md-image-status'; status.textContent = labels.loading;
    const affordance = root.ownerDocument.createElement('span');
    affordance.className = 'md-image-affordance'; affordance.textContent = labels.view;
    affordance.setAttribute('aria-hidden', 'true');
    button.append(img, status, affordance); image.append(button);
    if (label) {
      const caption = root.ownerDocument.createElement('span'); caption.className = 'md-image-caption'; caption.textContent = label;
      image.append(caption);
    }
  }
}

/** These children belong to the image loader, not the streaming text morph. */
export function preserveMarkdownImage(from: Element, to: Element): boolean {
  return from.hasAttribute('data-md-image-ready') && ['data-md-image-src', 'data-md-image-alt', 'data-md-image-title', 'data-md-image-original']
    .every(attribute => from.getAttribute(attribute) === to.getAttribute(attribute));
}

export class MarkdownImageRegistry {
  private entries = new Map<HTMLElement, ImageEntry>();
  private assets = new Map<string, { controller: AbortController; result: Promise<MarkdownImageAsset> }>();
  private observer?: IntersectionObserver;
  private disposed = false;

  constructor(private root: HTMLElement, private options: {
    labels: MarkdownImageLabels;
    load(source: string, signal: AbortSignal, interactive?: boolean): Promise<MarkdownImageAsset>;
    original?(source: string, signal: AbortSignal): Promise<MarkdownImageAsset>;
    open(items: MarkdownImageItem[], index: number): void;
    changed(): void;
  }) {
    if (typeof IntersectionObserver !== 'undefined') this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        this.observer?.unobserve(entry.target);
        const owned = this.entries.get(entry.target as HTMLElement);
        if (owned) void this.load(entry.target as HTMLElement, owned);
      }
    }, { rootMargin: '240px' });
    root.addEventListener('click', this.click, true);
  }

  refresh() {
    for (const [node, entry] of this.entries) if (!this.root.contains(node) || this.signature(node) !== entry.signature || node.querySelector('.md-image-frame > img') !== entry.image) {
      this.observer?.unobserve(node); entry.dispose?.(); this.entries.delete(node);
      originalReaders.delete(node);
    }
    for (const node of this.root.querySelectorAll<HTMLElement>('[data-md-image-src], a[data-md-image-link]')) {
      if (this.entries.has(node)) continue;
      const item: MarkdownImageItem = { source: this.source(node), originalSource: node.getAttribute('data-md-image-original') ?? undefined,
        label: node.getAttribute('data-md-image-title') || node.getAttribute('data-md-image-alt')
          || (node.hasAttribute('data-md-image-src') ? '' : node.textContent || '') };
      const entry: ImageEntry = { item, signature: this.signature(node), image: node.querySelector('.md-image-frame > img') };
      this.entries.set(node, entry);
      if (this.options.original) originalReaders.set(node, signal => this.options.original!(item.originalSource ?? item.source, signal));
      if (node.hasAttribute('data-md-image-src')) {
        if (this.observer) this.observer.observe(node);
        else void this.load(node, entry);
      }
    }
    // A removed/replaced stream tail releases only resources it no longer owns.
    const sources = new Set([...this.entries.values()].map(entry => entry.item.source));
    for (const [source, asset] of this.assets) if (!sources.has(source)) {
      asset.controller.abort(); void asset.result.then(value => value.release?.(), () => {}); this.assets.delete(source);
    }
  }

  private source(node: HTMLElement) {
    return node.getAttribute('data-md-image-src') ?? node.getAttribute('data-md-image-href') ?? node.getAttribute('href') ?? '';
  }

  private signature(node: HTMLElement) {
    return JSON.stringify([this.source(node), node.getAttribute('data-md-image-alt'), node.getAttribute('data-md-image-title'), node.getAttribute('data-md-image-original'),
      node.hasAttribute('data-md-image-link') ? node.textContent : null]);
  }

  private async load(node: HTMLElement, entry: ImageEntry, retry = false) {
    if (retry) {
      const old = this.assets.get(entry.item.source);
      old?.controller.abort(); if (old) void old.result.then(value => value.release?.(), () => {});
      this.assets.delete(entry.item.source);
    }
    node.dataset.imageState = 'loading';
    const status = node.querySelector<HTMLElement>('.md-image-status');
    if (status) status.textContent = this.options.labels.loading;
    try {
      let cached = this.assets.get(entry.item.source);
      if (!cached) {
        const controller = new AbortController();
        cached = { controller, result: this.options.load(entry.item.source, controller.signal, retry) };
        this.assets.set(entry.item.source, cached);
      }
      const asset = await cached.result;
      if (this.disposed || this.entries.get(node) !== entry || !this.root.contains(node)) return;
      entry.item.asset = asset;
      const img = node.querySelector<HTMLImageElement>('.md-image-frame > img');
      if (!img) return;
      const ready = () => {
        if (this.disposed || this.entries.get(node) !== entry) return;
        const width = asset.width || img.naturalWidth, height = asset.height || img.naturalHeight;
        if (width > 0 && height > 0) {
          node.style.setProperty('--image-width', `${width}px`);
          node.style.setProperty('--image-ratio', String(width / height));
          node.dataset.imageShape = height / width > 2.4 ? 'long' : width <= 128 && height <= 128 ? 'small' : height > width * 1.2 ? 'portrait' : 'landscape';
          if (node.dataset.imageShape === 'long') {
            node.querySelector('.md-image-affordance')!.textContent = this.options.labels.long;
          }
        }
        node.dataset.imageState = 'loaded'; this.options.changed();
      };
      const failed = () => {
        if (this.disposed || this.entries.get(node) !== entry) return;
        node.dataset.imageState = 'failed'; if (status) status.textContent = `${this.options.labels.failed} · ${this.options.labels.retry}`;
        this.options.changed();
      };
      entry.dispose?.();
      img.addEventListener('load', ready); img.addEventListener('error', failed);
      entry.dispose = () => { img.removeEventListener('load', ready); img.removeEventListener('error', failed); };
      // Reserve the real aspect ratio before decoding the preview.
      if (asset.width && asset.height) {
        node.style.setProperty('--image-width', `${asset.width}px`);
        node.style.setProperty('--image-ratio', String(asset.width / asset.height));
        node.dataset.imageShape = asset.height / asset.width > 2.4 ? 'long' : asset.width <= 128 && asset.height <= 128 ? 'small' : asset.height > asset.width * 1.2 ? 'portrait' : 'landscape';
      }
      img.src = asset.src;
      if (img.complete && img.naturalWidth) ready();
    } catch {
      if (this.disposed || this.entries.get(node) !== entry) return;
      node.dataset.imageState = 'failed';
      if (status) status.textContent = `${this.options.labels.failed} · ${this.options.labels.retry}`;
      this.options.changed();
    }
  }

  private click = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const target = event.target as Element | null;
    const node = target?.closest<HTMLElement>('[data-md-image-src], a[data-md-image-link]');
    if (!node || !this.root.contains(node)) return;
    const entry = this.entries.get(node); if (!entry) return;
    event.preventDefault(); event.stopPropagation();
    if (node.dataset.imageState === 'failed') { void this.load(node, entry, true); return; }
    const group = node.closest('[data-md-image-gallery]');
    const members = group ? [...group.querySelectorAll<HTMLElement>('[data-md-image-src]')] : [node];
    const items = members.flatMap(member => { const found = this.entries.get(member); return found ? [found.item] : []; });
    this.options.open(items, Math.max(0, members.indexOf(node)));
  };

  cleanup() {
    this.disposed = true; this.observer?.disconnect(); this.root.removeEventListener('click', this.click, true);
    for (const [node, entry] of this.entries) { entry.dispose?.(); originalReaders.delete(node); }
    for (const asset of this.assets.values()) { asset.controller.abort(); void asset.result.then(value => value.release?.(), () => {}); }
    this.entries.clear(); this.assets.clear();
  }
}
