import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { useI18n } from '@/lib/i18n';
import type { ThreadHistoryRun } from '@varin/application-client';

type TurnMarker = ThreadHistoryRun & { id: string; round: number };
export type ChatTurnNavigatorHandle = { setVisibleRun(runId: string): void };
type PreviewHandle = { show(marker: TurnMarker, anchor: HTMLElement): void; hide(): void; reconcile(markers: readonly TurnMarker[]): void };
type TurnPreview = { id: string; round: number; text: string; anchor: HTMLElement };
const excerpt = (text: string): string => {
  const compact = text.trim().replace(/\s+/g, ' ');
  return compact.length > 240 ? `${compact.slice(0, 240)}…` : compact;
};

/** Hover reads this Run's preview independently of mounted message elements. */
const TurnPreview = React.forwardRef<PreviewHandle, {
  root: React.RefObject<HTMLElement | null>;
  readPreview(runId: string, signal: AbortSignal): Promise<string>;
}>(({ root, readPreview }, ref) => {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();
  const [preview, setPreview] = React.useState<TurnPreview>();
  const current = React.useRef<TurnPreview | undefined>(undefined);
  const popup = React.useRef<HTMLDivElement>(null);
  const pending = React.useRef<AbortController | undefined>(undefined);
  const cache = React.useRef(new Map<string, { throughId: string | null; text: string }>());
  const show = React.useCallback((marker: TurnMarker, anchor: HTMLElement) => {
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    const cached = cache.current.get(marker.id);
    const next = { id: marker.id, round: marker.round, anchor, text: cached?.text ?? '' };
    current.current = next; setPreview(next);
    if (cached?.throughId === marker.lastItemId) return;
    void readPreview(marker.runId, controller.signal).then(value => {
      if (controller.signal.aborted || current.current?.id !== marker.id) return;
      const text = excerpt(value);
      cache.current.set(marker.id, { throughId: marker.lastItemId, text });
      current.current = { ...current.current, text }; setPreview(current.current);
    }).catch(() => { /* An unavailable preview leaves the Run pointer usable. */ });
  }, [readPreview]);
  React.useEffect(() => () => pending.current?.abort(), []);
  React.useImperativeHandle(ref, () => ({
    show,
    hide() { pending.current?.abort(); current.current = undefined; setPreview(undefined); },
    reconcile(markers) {
      const value = current.current;
      if (!value) return;
      const marker = markers.find(marker => marker.id === value.id);
      if (!marker) { pending.current?.abort(); current.current = undefined; setPreview(undefined); }
      else show(marker, value.anchor);
    },
  }), [show]);
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
    {preview ? <motion.div key="turn-preview" ref={popup} role="tooltip" className="conversation-turn-preview"
      initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -2 }}
      transition={{ duration: reducedMotion ? 0 : .15, ease: [.22, 1, .36, 1] }}>
      <div className="mb-1.5 typography-micro tabular-nums text-muted-foreground">
        Varin · {t('chat.promptNavigator.turn', { number: preview.round })}
      </div>
      <p className="line-clamp-3 break-words typography-meta text-foreground">{preview.text || t('chat.promptNavigator.noPreview')}</p>
    </motion.div> : null}
  </AnimatePresence>;
});

/** One pointer per native Run. The rail never consumes virtual rows or their indices. */
export const ChatTurnNavigator = React.memo(React.forwardRef<ChatTurnNavigatorHandle, {
  runs: readonly ThreadHistoryRun[];
  initialRunId?: string;
  readPreview(runId: string, signal: AbortSignal): Promise<string>;
  onSelect(target: ThreadHistoryRun): void;
}>(({ runs, initialRunId, readPreview, onSelect }, ref) => {
  const { t } = useI18n();
  const markers = React.useMemo(() => runs.map((run, index) => ({ ...run, id: run.runId, round: index + 1 })), [runs]);
  const [activeId, setActiveId] = React.useState(initialRunId);
  const root = React.useRef<HTMLElement>(null);
  const scroll = React.useRef<HTMLDivElement>(null);
  const list = React.useRef<HTMLDivElement>(null);
  const buttons = React.useRef(new Map<number, HTMLButtonElement>());
  const preview = React.useRef<PreviewHandle>(null);
  const pointerInside = React.useRef(false);
  const pointerY = React.useRef<number | undefined>(undefined);
  const waveFrame = React.useRef<number | null>(null);
  const waved = React.useRef(new Set<HTMLButtonElement>());
  const displayedId = markers.some(marker => marker.id === activeId) ? activeId : initialRunId;
  const activeOrdinal = markers.findIndex(marker => marker.id === displayedId);
  React.useImperativeHandle(ref, () => ({ setVisibleRun(runId) { setActiveId(runId); } }), []);

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
    if (marker && button) preview.current?.show(marker, button);
  };
  if (!markers.length) return null;
  return <nav ref={root} className="conversation-turn-navigation" aria-label={t('chat.promptNavigator.aria')}
    onPointerEnter={() => { pointerInside.current = true; }}
    onPointerMove={event => { if (event.pointerType !== 'touch') { pointerY.current = event.clientY; updateWave(); } }}
    onPointerLeave={() => { pointerInside.current = false; clearWave(); if (!root.current?.contains(document.activeElement)) preview.current?.hide(); revealActive(); }}
    onBlur={event => { if (!pointerInside.current && !event.currentTarget.contains(event.relatedTarget as Node | null)) preview.current?.hide(); }}
    onKeyDown={event => {
      if (event.key === 'Escape') { preview.current?.hide(); clearWave(); return; }
      const ordinal = Number((event.target as HTMLElement).closest<HTMLButtonElement>('button[data-conversation-turn-marker]')?.dataset.conversationTurnMarker);
      if (!Number.isInteger(ordinal)) return;
      const next = event.key === 'ArrowDown' ? Math.min(markers.length - 1, ordinal + 1)
        : event.key === 'ArrowUp' ? Math.max(0, ordinal - 1) : event.key === 'Home' ? 0
          : event.key === 'End' ? markers.length - 1 : undefined;
      if (next !== undefined) { event.preventDefault(); buttons.current.get(next)?.focus(); }
    }}>
    <div ref={scroll} className="conversation-turn-navigation-scroll" onScroll={() => { if (pointerInside.current) { preview.current?.hide(); updateWave(); } }}>
      <div ref={list} className="conversation-turn-navigation-list">
        {markers.map((marker, ordinal) => <button key={marker.id} type="button" data-conversation-turn-marker={ordinal}
          ref={button => { if (button) buttons.current.set(ordinal, button); else buttons.current.delete(ordinal); }}
          className="conversation-turn-marker" data-message-role="assistant" data-run-id={marker.runId}
          aria-label={`Varin · ${t('chat.promptNavigator.turn', { number: marker.round })}`}
          aria-current={marker.id === displayedId ? 'location' : undefined}
          tabIndex={ordinal === (activeOrdinal >= 0 ? activeOrdinal : 0) ? 0 : -1}
          onPointerEnter={event => { if (event.pointerType !== 'touch') showPreview(ordinal); }}
          onPointerLeave={() => { if (!root.current?.contains(document.activeElement)) preview.current?.hide(); }}
          onFocus={() => showPreview(ordinal)} onClick={() => onSelect(marker)}>
          <span className="conversation-turn-marker-stroke" aria-hidden="true" />
        </button>)}
      </div>
    </div>
    <TurnPreview ref={preview} root={root} readPreview={readPreview} />
  </nav>;
}));
