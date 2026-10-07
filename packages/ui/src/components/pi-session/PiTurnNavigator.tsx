import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { useI18n } from '@/lib/i18n';
import { piContentText } from './extensionPresentation';
import type { PiTimelineItem, PiTimelineRow, PiTimelineTurn } from './piTimelineProjection';

type TurnMarker = { id: string; index: number };
export type PiTurnNavigatorHandle = { setVisibleIndex(index: number): void };
type PreviewHandle = { show(marker: TurnMarker, ordinal: number, anchor: HTMLElement): void; hide(): void; reconcile(markers: readonly TurnMarker[]): void };
type TurnPreview = { id: string; ordinal: number; user: string; answer: string; anchor: HTMLElement };

const answerPreview = (turn: PiTimelineTurn): string => {
  const text = (message: NonNullable<PiTimelineTurn['liveAssistant']>) => message.content
    .flatMap(part => part.type === 'text' ? [part.text] : []).join('\n').trim();
  const live = turn.liveAssistant && text(turn.liveAssistant);
  if (live) return live;
  for (let index = turn.entries.length - 1; index >= 0; index -= 1) {
    const entry = turn.entries[index]!;
    if (entry.type === 'message' && entry.message.role === 'assistant') {
      const answer = text(entry.message);
      if (answer) return answer;
    }
  }
  return '';
};
const excerpt = (text: string): string => {
  const compact = text.trim().replace(/\s+/g, ' ');
  return compact.length > 240 ? `${compact.slice(0, 240)}…` : compact;
};

/** Only a hovered/focused turn reads message text; pointer motion does not rerender the rail. */
const TurnPreview = React.forwardRef<PreviewHandle, {
  root: React.RefObject<HTMLElement | null>;
  readItem(index: number): PiTimelineItem | undefined;
}>(({ root, readItem }, ref) => {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();
  const [preview, setPreview] = React.useState<TurnPreview>();
  const popup = React.useRef<HTMLDivElement>(null);
  React.useImperativeHandle(ref, () => ({
    show(marker, ordinal, anchor) {
      setPreview(current => {
        if (current?.id === marker.id && current.anchor === anchor) return current;
        const item = readItem(marker.index);
        if (item?.kind !== 'turn' || item.id !== marker.id) return undefined;
        return { id: marker.id, ordinal, anchor,
          user: excerpt(piContentText(item.turn.user.content)), answer: excerpt(answerPreview(item.turn)),
        };
      });
    },
    hide() { setPreview(undefined); },
    reconcile(markers) {
      setPreview(current => {
        if (!current) return current;
        const ordinal = markers.findIndex(marker => marker.id === current.id);
        const marker = markers[ordinal], item = marker && readItem(marker.index);
        if (item?.kind !== 'turn' || item.id !== current.id) return undefined;
        return { ...current, ordinal, user: excerpt(piContentText(item.turn.user.content)), answer: excerpt(answerPreview(item.turn)) };
      });
    },
  }), [readItem]);
  React.useLayoutEffect(() => {
    if (!preview || !popup.current || !root.current) return;
    const bounds = root.current.getBoundingClientRect();
    const anchor = preview.anchor.getBoundingClientRect();
    popup.current.style.maxHeight = `${Math.max(0, bounds.height - 16)}px`;
    const height = popup.current.getBoundingClientRect().height;
    const top = Math.max(8, Math.min(bounds.height - height - 8, anchor.top + anchor.height / 2 - bounds.top - height / 2));
    popup.current.style.setProperty('--turn-preview-top', `${top}px`);
  }, [preview, root]);
  return <AnimatePresence>
    {preview ? <motion.div key="turn-preview" ref={popup} role="tooltip" className="pi-turn-preview"
      initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -2 }}
      transition={{ duration: reducedMotion ? 0 : .15, ease: [.22, 1, .36, 1] }}>
      <div className="mb-1.5 typography-micro tabular-nums text-muted-foreground">{t('chat.promptNavigator.turn', { number: preview.ordinal + 1 })}</div>
      <p className="line-clamp-2 break-words typography-meta font-medium text-foreground">{preview.user || '…'}</p>
      {preview.answer ? <p className="mt-2 line-clamp-2 break-words border-t border-border/50 pt-2 typography-meta text-muted-foreground">{preview.answer}</p> : null}
    </motion.div> : null}
  </AnimatePresence>;
});

const markerAtIndex = (markers: readonly TurnMarker[], index: number): TurnMarker | undefined => {
  let low = 0, high = markers.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (markers[middle]!.index <= index) low = middle + 1; else high = middle;
  }
  return markers[Math.max(0, low - 1)];
};

/** One marker per user/Agent turn, including the current turn while it is being answered. */
export const PiTurnNavigator = React.memo(React.forwardRef<PiTurnNavigatorHandle, {
  items: readonly PiTimelineRow[];
  initialIndex: number;
  readItem(index: number): PiTimelineItem | undefined;
  onSelect(index: number): void;
}>(({ items, initialIndex, readItem, onSelect }, ref) => {
  const { t } = useI18n();
  const markers = React.useMemo(() => items.flatMap((item, index) => item.kind === 'turn' ? [{ id: item.id, index }] : []), [items]);
  const [activeId, setActiveId] = React.useState(() => markerAtIndex(markers, initialIndex)?.id);
  const root = React.useRef<HTMLElement>(null);
  const scroll = React.useRef<HTMLDivElement>(null);
  const list = React.useRef<HTMLDivElement>(null);
  const buttons = React.useRef(new Map<number, HTMLButtonElement>());
  const preview = React.useRef<PreviewHandle>(null);
  const pointerInside = React.useRef(false);
  const pointerY = React.useRef<number | undefined>(undefined);
  const waveFrame = React.useRef<number | null>(null);
  const waved = React.useRef(new Set<HTMLButtonElement>());
  const displayedId = markers.some(marker => marker.id === activeId) ? activeId : markerAtIndex(markers, initialIndex)?.id;
  const activeOrdinal = markers.findIndex(marker => marker.id === displayedId);
  React.useImperativeHandle(ref, () => ({ setVisibleIndex(index) { setActiveId(markerAtIndex(markers, index)?.id); } }), [markers]);

  const revealActive = React.useCallback(() => {
    const viewport = scroll.current;
    const button = buttons.current.get(activeOrdinal);
    if (!viewport || !button || pointerInside.current || root.current?.contains(document.activeElement)) return;
    const bounds = viewport.getBoundingClientRect(), tick = button.getBoundingClientRect();
    if (tick.top < bounds.top + 8) viewport.scrollTop += tick.top - bounds.top - 8;
    else if (tick.bottom > bounds.bottom - 8) viewport.scrollTop += tick.bottom - bounds.bottom + 8;
  }, [activeOrdinal]);
  React.useLayoutEffect(revealActive, [revealActive]);
  const clearWave = React.useCallback(() => {
    if (waveFrame.current !== null) cancelAnimationFrame(waveFrame.current);
    waveFrame.current = null;
    pointerY.current = undefined;
    for (const button of waved.current) button.style.removeProperty('--turn-proximity');
    waved.current.clear();
  }, []);
  React.useEffect(() => clearWave, [clearWave]);
  React.useEffect(() => { clearWave(); preview.current?.reconcile(markers); }, [markers, clearWave]);
  const updateWave = React.useCallback(() => {
    if (waveFrame.current !== null) return;
    waveFrame.current = requestAnimationFrame(() => {
      waveFrame.current = null;
      const first = buttons.current.get(0), y = pointerY.current;
      if (!first || !list.current || y === undefined) return;
      // Uniform marker spacing needs one geometry read, only adjacent marks are updated.
      const firstBounds = first.getBoundingClientRect();
      const step = firstBounds.height;
      if (!step) return;
      const position = (y - firstBounds.top) / step - .5;
      const next = new Set<HTMLButtonElement>();
      for (let ordinal = Math.max(0, Math.floor(position) - 4); ordinal <= Math.min(markers.length - 1, Math.ceil(position) + 4); ordinal += 1) {
        const button = buttons.current.get(ordinal);
        if (!button) continue;
        const proximity = Math.exp(-Math.pow((ordinal - position) / 1.8, 2));
        button.style.setProperty('--turn-proximity', proximity.toFixed(3));
        next.add(button);
      }
      for (const button of waved.current) if (!next.has(button)) button.style.removeProperty('--turn-proximity');
      waved.current = next;
    });
  }, [markers.length]);
  const showPreview = (ordinal: number) => {
    const marker = markers[ordinal], button = buttons.current.get(ordinal);
    if (marker && button) preview.current?.show(marker, ordinal, button);
  };
  if (!markers.length) return null;
  return <nav ref={root} className="pi-turn-navigation" aria-label={t('chat.promptNavigator.aria')}
    onPointerEnter={() => { pointerInside.current = true; }}
    onPointerMove={event => { if (event.pointerType !== 'touch') { pointerY.current = event.clientY; updateWave(); } }}
    onPointerLeave={() => { pointerInside.current = false; clearWave(); if (!root.current?.contains(document.activeElement)) preview.current?.hide(); revealActive(); }}
    onBlur={event => { if (!pointerInside.current && !event.currentTarget.contains(event.relatedTarget as Node | null)) preview.current?.hide(); }}
    onKeyDown={event => {
      if (event.key === 'Escape') { preview.current?.hide(); clearWave(); return; }
      const ordinal = Number((event.target as HTMLElement).closest<HTMLButtonElement>('button[data-pi-turn-marker]')?.dataset.piTurnMarker);
      if (!Number.isInteger(ordinal)) return;
      const next = event.key === 'ArrowDown' ? Math.min(markers.length - 1, ordinal + 1)
        : event.key === 'ArrowUp' ? Math.max(0, ordinal - 1) : event.key === 'Home' ? 0
          : event.key === 'End' ? markers.length - 1 : undefined;
      if (next !== undefined) { event.preventDefault(); buttons.current.get(next)?.focus(); }
    }}>
    <div ref={scroll} className="pi-turn-navigation-scroll" onScroll={() => { if (pointerInside.current) { preview.current?.hide(); updateWave(); } }}>
      <div ref={list} className="pi-turn-navigation-list">
        {markers.map((marker, ordinal) => <button key={marker.id} type="button" data-pi-turn-marker={ordinal}
          ref={button => { if (button) buttons.current.set(ordinal, button); else buttons.current.delete(ordinal); }}
          className="pi-turn-marker" aria-label={t('chat.promptNavigator.turn', { number: ordinal + 1 })}
          aria-current={marker.id === displayedId ? 'location' : undefined}
          tabIndex={ordinal === (activeOrdinal >= 0 ? activeOrdinal : 0) ? 0 : -1}
          onPointerEnter={event => { if (event.pointerType !== 'touch') showPreview(ordinal); }}
          onPointerLeave={() => { if (!root.current?.contains(document.activeElement)) preview.current?.hide(); }}
          onFocus={() => showPreview(ordinal)} onClick={() => onSelect(marker.index)}>
          <span className="pi-turn-marker-stroke" aria-hidden="true" />
        </button>)}
      </div>
    </div>
    <TurnPreview ref={preview} root={root} readItem={readItem} />
  </nav>;
}));
