import { normalizeFilePath, toAbsoluteFilePath } from '@/lib/path-utils';

const IMAGE_EXTENSION = /\.(?:avif|avifs|bmp|gif|ico|jpe?g|png|svg|webp)(?:[?#].*)?$/i;

export function isImageHref(href: string): boolean {
  return IMAGE_EXTENSION.test(href) || /^data:image\//i.test(href);
}

export type MarkdownImageSource = { kind: 'url'; url: string } | { kind: 'file'; path: string };

/** Resolve against the conversation's source, never the renderer page URL. */
export function resolveMarkdownImageSource(href: string, directory: string): MarkdownImageSource | null {
  const value = href.trim();
  if (!value) return null;
  if (/^(?:https?:|data:image\/|blob:)/i.test(value)) return { kind: 'url', url: value };
  if (/^\/\//.test(value)) return { kind: 'url', url: `https:${value}` };
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const path = decodeURIComponent(url.pathname);
      return { kind: 'file', path: normalizeFilePath(url.hostname ? `//${url.hostname}${path}` : path.replace(/^\/([a-z]:\/)/i, '$1')) };
    } catch { return null; }
  }
  // A Windows drive is a path; every other explicit protocol needs its own owner.
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return null;
  let path: string;
  try { path = decodeURIComponent(value); } catch { path = value; }
  if (!directory && !/^(?:[a-z]:[\\/]|[/\\])/i.test(path)) return null;
  return { kind: 'file', path: toAbsoluteFilePath(directory, path) };
}

export const escapeImageAttribute = (text: string): string => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function markdownImagePlaceholder(href: string, alt: string, title?: string | null): string {
  return `<span data-md-image-src="${escapeImageAttribute(href)}" data-md-image-alt="${escapeImageAttribute(alt)}"${title ? ` data-md-image-title="${escapeImageAttribute(title)}"` : ''}></span>`;
}

/** Consecutive image paragraphs are one gallery; prose always ends the group. */
const galleryStart = /^<p\b(?=[^>]*\bdata-md-image-gallery(?:\s|=|>))[^>]*>/;
export function groupMarkdownImageBlocks<T extends { id: string; html: string }>(blocks: T[]): T[] {
  const result: T[] = [];
  for (const block of blocks) {
    const previous = result.at(-1);
    if (previous && galleryStart.test(previous.html) && galleryStart.test(block.html)) {
      result[result.length - 1] = { ...previous, id: `${previous.id}|${block.id}`, html: previous.html.replace(/<\/p>\s*$/, '') + block.html.replace(galleryStart, '') };
    } else result.push(block);
  }
  return result;
}
