import React from 'react';
import type { ContentReferenceOccurrence } from '@varin/application-client';
import { markdownSourceMap } from './chatSelection';

export interface BoundReferenceMarker {
  occurrence: ContentReferenceOccurrence;
  label: string;
  description: string;
}
export interface BoundReferencePresentation {
  markers: readonly BoundReferenceMarker[];
  open(index: number): void;
}
export const BoundReferenceContext = React.createContext<BoundReferencePresentation | null>(null);
export const boundReferenceClassName = 'inline-block whitespace-nowrap rounded-sm bg-primary/10 px-0.5 align-baseline font-medium text-primary hover:bg-primary/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary';

/** Explicit input ranges only. A spelling in ordinary text is never a binding. */
export function validReferenceOccurrences(text: string, occurrences: readonly ContentReferenceOccurrence[] = []): ContentReferenceOccurrence[] {
  let end = 0;
  return [...occurrences].sort((left, right) => left.start - right.start).filter(value => {
    if (!Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end) || value.start < end || value.end <= value.start || value.end > text.length) return false;
    end = value.end;
    return true;
  });
}

/** Decorate the renderer's own complete Markdown DOM, never search arbitrary chat
 * text for marker syntax. Offsets remain in the original user input even when
 * Markdown has removed formatting, link destinations, or fence delimiters. */
export function decorateBoundReferences(root: HTMLElement, text: string, presentation: BoundReferencePresentation | null, sourceOffset = 0): void {
  for (const existing of root.querySelectorAll('[data-bound-reference]')) existing.replaceWith(root.ownerDocument.createTextNode(existing.textContent ?? ''));
  if (!presentation?.markers.length) return;
  const map = markdownSourceMap(text);
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* SHOW_TEXT */);
  const nodes: Array<{ node: Text; from: number; to: number }> = [];
  let cursor = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.data || node.parentElement?.closest('button, summary, [aria-hidden="true"], [data-md-code-line-number], .katex-mathml, [data-md-image-src]')) continue;
    const position = map.text.indexOf(node.data, cursor);
    if (position < 0) continue;
    nodes.push({ node, from: position, to: position + node.data.length });
    cursor = position + node.data.length;
  }
  // Reverse order retains the offsets of earlier markers sharing a text node.
  for (let index = presentation.markers.length - 1; index >= 0; index -= 1) {
    const marker = presentation.markers[index]!;
    const start = marker.occurrence.start - sourceOffset, end = marker.occurrence.end - sourceOffset;
    if (start < 0 || end > text.length) continue;
    const from = map.starts.indexOf(start), last = map.ends.lastIndexOf(end);
    if (from < 0 || last < from || map.text.slice(from, last + 1) !== text.slice(start, end)) continue;
    const covered = nodes.filter(value => value.to > from && value.from <= last && value.node.parentNode);
    if (!covered.length || covered[0]!.from > from || covered.at(-1)!.to <= last) continue;
    const button = root.ownerDocument.createElement('button');
    button.type = 'button'; button.className = boundReferenceClassName;
    button.setAttribute('data-bound-reference', String(index));
    button.setAttribute('aria-label', marker.description); button.title = marker.description;
    button.textContent = text.slice(start, end);
    for (const [part, item] of covered.entries()) {
      const left = Math.max(0, from - item.from), right = Math.min(item.node.data.length, last + 1 - item.from);
      if (part === 0) {
        const trailing = root.ownerDocument.createTextNode(item.node.data.slice(right));
        item.node.data = item.node.data.slice(0, left);
        item.node.after(button, trailing);
      } else item.node.data = item.node.data.slice(0, left) + item.node.data.slice(right);
    }
  }
}
