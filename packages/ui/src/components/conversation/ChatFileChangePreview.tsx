import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Icon } from '@/components/icon/Icon';
import { SwapText } from '@/components/motion/SwapText';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { getMarkdownSyntaxVars } from '@/components/chat/markdown/markdownSyntaxVars';
import { highlightLinesInWorker } from '@/components/chat/markdown/markdown-worker';
import { documentMotionLevel } from '@/lib/motion/preference';
import { SpringDriver, omegaSpring, tokenSpring } from '@/lib/motion/spring';
import { EASE_OUT, springTiming, TWEENS } from '@/lib/motion/tokens';
import type { FileChangeLine, FileChangePhase, FileChangePreview } from './fileChangePreview';
import { timelinePresentationCache } from './timelinePresentationCache';

type PreviewView = { expanded: boolean; following: boolean; scrollTop: number };
const PreviewViews = React.createContext<Map<string, PreviewView> | undefined>(undefined);

/** The mounted turn keeps user navigation across live-to-persisted remounts. */
export const ChatFileChangePreviewScope: React.FC<{ children: React.ReactNode; sessionId?: string }> = ({ children, sessionId }) => {
  const [views] = React.useState(() => sessionId ? timelinePresentationCache(sessionId, 'files', () => new Map<string, PreviewView>()) : new Map<string, PreviewView>());
  return <PreviewViews.Provider value={views}>{children}</PreviewViews.Provider>;
};

/** A completed line settles (and its ink develops) before it takes colour. */
const HIGHLIGHT_DELAY_MS = 90;
/** The inner view follows on a slightly quicker spring than the timeline. */
const FOLLOW_SPRING = omegaSpring(16);
const TRAVEL_SPRING = tokenSpring('travel');
const INK_MS = 300;
/** A row that changed order fades in at its new place on the shared fade tween. */
const fadeTiming = { duration: TWEENS.fade.duration * 1000, easing: `cubic-bezier(${EASE_OUT.join(', ')})` };

const lineKey = (line: FileChangeLine, index: number): string => line.key ?? `#${index}`;

// Keep at most one highlighting job in flight per preview. New deltas replace
// the pending snapshot; they do not accumulate worker work behind the stream.
// Results are kept by row identity, so a row keeps its colour while rows
// around it are inserted or removed. The line being written stays plain.
function useHighlightedDiff(lines: FileChangeLine[], language: string) {
  const latest = React.useRef({ lines, language });
  const running = React.useRef(false);
  const alive = React.useRef(true);
  const [highlighted, setHighlighted] = React.useState<Map<string, { text: string; html: string }>>(() => new Map());
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  React.useEffect(() => {
    latest.current = { lines, language };
    if (running.current) return;
    running.current = true;
    void (async () => {
      try {
        while (alive.current) {
          await new Promise(resolve => setTimeout(resolve, HIGHLIGHT_DELAY_MS));
          if (!alive.current) break;
          const job = latest.current;
          const settled = job.lines.map((line, index) => ({ line, key: lineKey(line, index) })).filter(({ line }) => !line.pending && line.kind !== 'hunk');
          const before = settled.filter(({ line }) => line.kind === 'remove' || line.kind === 'context');
          const after = settled.filter(({ line }) => line.kind === 'add' || line.kind === 'context');
          const [oldHtml, newHtml] = await Promise.all([
            before.length ? highlightLinesInWorker(before.map(({ line }) => line.text).join('\n'), job.language) : null,
            after.length ? highlightLinesInWorker(after.map(({ line }) => line.text).join('\n'), job.language) : null,
          ]);
          if (!alive.current) break;
          const next = new Map<string, { text: string; html: string }>();
          before.forEach(({ line, key }, index) => { const html = oldHtml?.[index]; if (html !== undefined && line.kind === 'remove') next.set(key, { text: line.text, html }); });
          after.forEach(({ line, key }, index) => { const html = newHtml?.[index]; if (html !== undefined) next.set(key, { text: line.text, html }); });
          setHighlighted(next);
          if (job === latest.current) break;
        }
      } catch {
        // Highlighting is optional; the current escaped text remains visible.
      } finally { running.current = false; }
    })();
  }, [lines, language]);
  // A row keeps the colour of the text it was highlighted with; changed text
  // shows plain until the next result, so appending never flashes the card.
  return lines.map((line, index) => {
    const known = highlighted.get(lineKey(line, index));
    return known && known.text === line.text && !line.pending ? known.html : undefined;
  });
}

/** Rows whose relative order is unchanged: the longest increasing subsequence. */
function stableRows(previous: readonly string[], next: readonly string[]): Set<string> {
  const position = new Map(previous.map((key, index) => [key, index]));
  const sequence = next.filter(key => position.has(key));
  const values = sequence.map(key => position.get(key)!);
  const tails: number[] = [];
  const parent = new Array<number>(values.length).fill(-1);
  values.forEach((value, index) => {
    let low = 0;
    let high = tails.length;
    while (low < high) { const middle = (low + high) >> 1; if (values[tails[middle]!]! < value) low = middle + 1; else high = middle; }
    if (low > 0) parent[index] = tails[low - 1]!;
    tails[low] = index;
  });
  const stable = new Set<string>();
  for (let index = tails.length ? tails[tails.length - 1]! : -1; index >= 0; index = parent[index]!) stable.add(sequence[index]!);
  return stable;
}

/**
 * Ink for the line being written: each render's new characters develop from
 * faint grey, resumed at their age so a re-render never restarts them.
 */
function useLineInk() {
  const runs = React.useRef(new Map<string, { length: number; segments: Array<{ from: number; to: number; born: number }> }>());
  return (key: string, text: string, enabled: boolean): React.ReactNode => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const state = runs.current.get(key) ?? { length: enabled ? 0 : text.length, segments: [] };
    if (text.length > state.length && enabled) state.segments.push({ from: state.length, to: text.length, born: now });
    state.length = text.length;
    state.segments = state.segments.filter(segment => now - segment.born < INK_MS && segment.to <= text.length);
    runs.current.set(key, state);
    if (!state.segments.length) return text;
    const parts: React.ReactNode[] = [];
    let at = 0;
    for (const segment of state.segments) {
      if (segment.from > at) parts.push(text.slice(at, segment.from));
      parts.push(<span key={segment.born} className="markdown-ink" style={{ animationDelay: `${-Math.round(now - segment.born)}ms` }}>{text.slice(segment.from, segment.to)}</span>);
      at = segment.to;
    }
    if (at < text.length) parts.push(text.slice(at));
    return parts;
  };
}

export const ChatFileChangePreview: React.FC<{
  previewId: string;
  file: FileChangePreview;
  phase: FileChangePhase;
  onOpen?: () => void;
}> = ({ previewId, file, phase, onOpen }) => {
  const { t } = useI18n();
  const showFileIcons = useUIStore(state => state.showToolFileIcons);
  const theme = useOptionalThemeSystem();
  const syntaxVars = React.useMemo(() => theme ? getMarkdownSyntaxVars(theme.currentTheme) : {}, [theme]);
  const viewport = React.useRef<HTMLDivElement>(null);
  const ghostLayer = React.useRef<HTMLDivElement>(null);
  const views = React.useContext(PreviewViews);
  const [view] = React.useState(() => views?.get(previewId) ?? { expanded: false, following: true, scrollTop: 0 });
  const following = React.useRef(view.following);
  const previousTop = React.useRef(view.scrollTop);
  const [paused, setPaused] = React.useState(!view.following);
  const [expanded, setExpanded] = React.useState(view.expanded);
  const [rowHeight, setRowHeight] = React.useState(22);
  const html = useHighlightedDiff(file.lines, getLanguageFromExtension(file.path.replace(/\\/g, '/')) ?? 'text');
  const keys = React.useMemo(() => file.lines.map(lineKey), [file.lines]);
  const keysRef = React.useRef(keys);
  keysRef.current = keys;
  const ink = useLineInk();
  const virtualizer = useVirtualizer({
    count: file.lines.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => rowHeight,
    getItemKey: index => keysRef.current[index] ?? index,
    initialRect: { width: 640, height: rowHeight * 8 },
    initialOffset: view.scrollTop,
  });
  const busy = phase === 'generating' || phase === 'applying';
  const failed = phase === 'failed' || phase === 'partial';
  const writing = phase === 'generating';
  // Only a card that was working here settles its icon in; history does not.
  const sawBusy = React.useRef(busy);
  if (busy) sawBusy.current = true;
  const settles = sawBusy.current && !busy;
  const hasLines = file.lines.length > 0;
  const totalHeight = virtualizer.getTotalSize();
  const viewportHeight = virtualizer.scrollRect?.height;
  const pathLabel = file.path || t('chat.fileChange.pendingPath');

  // The inner view follows the writing on its own spring; the timeline keeps
  // owning page following and its extra manual-scrolling space.
  const programmatic = React.useRef(-1);
  const scrollSpring = React.useRef<SpringDriver | null>(null);
  const innerSpring = () => scrollSpring.current ??= new SpringDriver({
    spring: FOLLOW_SPRING,
    restDelta: 0.3,
    onUpdate: (value) => {
      const element = viewport.current;
      if (!element) return;
      element.scrollTop = value;
      programmatic.current = element.scrollTop;
    },
  });
  React.useEffect(() => () => scrollSpring.current?.stop(), []);
  const scrollInner = React.useCallback((target: number, travel = false) => {
    const element = viewport.current;
    if (!element) return;
    const goal = Math.max(0, Math.min(target, element.scrollHeight - element.clientHeight));
    if (documentMotionLevel() !== 'full') {
      scrollSpring.current?.stop();
      element.scrollTop = goal;
      programmatic.current = element.scrollTop;
      return;
    }
    const spring = innerSpring();
    spring.sync(element.scrollTop);
    spring.configure(travel ? TRAVEL_SPRING : FOLLOW_SPRING);
    spring.to(goal);
  }, []);

  const pause = () => {
    view.following = false;
    following.current = false;
    scrollSpring.current?.stop();
    setPaused(true);
  };
  const follow = React.useCallback(() => {
    view.following = true;
    following.current = true;
    setPaused(false);
    const element = viewport.current;
    if (element) scrollInner(element.scrollHeight);
  }, [view, scrollInner]);

  React.useLayoutEffect(() => {
    views?.set(previewId, view);
    const element = viewport.current;
    if (!element) return;
    element.scrollTop = view.scrollTop;
    let width = element.clientWidth;
    const measure = () => {
      const size = Number.parseFloat(getComputedStyle(element).fontSize);
      if (Number.isFinite(size) && size > 0) setRowHeight(Math.ceil(size * 1.65));
      // Wrapped rows have different heights after the sidebar/window resizes,
      // including rows currently outside the virtual viewport.
      if (element.clientWidth !== width) {
        width = element.clientWidth;
        virtualizer.measure();
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [previewId, view, views, hasLines, virtualizer]);
  React.useLayoutEffect(() => { virtualizer.measure(); }, [rowHeight, virtualizer]);
  React.useLayoutEffect(() => {
    // Reconcile again when wrapped rows are measured, including a growing last
    // line with no newline. Never steal the scroll position from manual reading.
    const element = viewport.current;
    if (following.current && hasLines && element) scrollInner(totalHeight - element.clientHeight);
  }, [file.lines, rowHeight, expanded, totalHeight, viewportHeight, hasLines, scrollInner]);

  // Row identity: kept rows that moved slide on snap (only those whose order is
  // unchanged, so rows never cross), new rows unfold from their top edge, and
  // removed rows fold away from a snapshot at their last place.
  const rowElements = React.useRef(new Map<string, HTMLElement>());
  const placed = React.useRef<{ keys: string[]; tops: Map<string, number> }>({ keys: [], tops: new Map() });
  const items = virtualizer.getVirtualItems();
  React.useLayoutEffect(() => {
    const previous = placed.current;
    const tops = new Map(items.map(item => [String(item.key), item.start]));
    placed.current = { keys, tops };
    const level = documentMotionLevel();
    if (!previous.keys.length || level === 'off') return;
    const known = new Set(previous.keys);
    const present = new Set(keys);
    const stable = stableRows(previous.keys, keys);
    const snap = springTiming('snap');
    for (const [key, top] of tops) {
      const element = rowElements.current.get(key);
      if (!element || typeof element.animate !== 'function') continue;
      if (!known.has(key)) {
        if (level === 'full') element.animate([{ opacity: 0, transform: 'scaleY(0)' }, { opacity: 1, transform: 'scaleY(1)' }], snap);
        continue;
      }
      const before = previous.tops.get(key);
      if (before === undefined || Math.abs(before - top) < 0.5) continue;
      if (level === 'full' && stable.has(key)) {
        // Slides add up, so a retarget mid-slide continues from where it is.
        element.animate([{ transform: `translateY(${before - top}px)` }, { transform: 'translateY(0)' }], { ...snap, composite: 'add' });
        continue;
      }
      // A row that changed order would cross others: drop any slide it was
      // carrying and let it appear at its new place instead.
      for (const animation of element.getAnimations()) animation.cancel();
      element.animate([{ opacity: 0 }, { opacity: 1 }], { ...fadeTiming, delay: level === 'full' ? 130 : 0, fill: 'backwards' });
    }
    const layer = ghostLayer.current;
    for (const [key, top] of previous.tops) {
      if (present.has(key)) continue;
      const element = rowElements.current.get(key);
      rowElements.current.delete(key);
      if (!element || !layer || level !== 'full' || typeof element.animate !== 'function') continue;
      const ghost = element.cloneNode(true) as HTMLElement;
      ghost.style.top = `${top}px`;
      ghost.setAttribute('aria-hidden', 'true');
      layer.append(ghost);
      const fold = ghost.animate([{ opacity: 1, transform: 'scaleY(1)' }, { opacity: 0, transform: 'scaleY(0)' }], { ...snap, fill: 'forwards' });
      void fold.finished.then(() => ghost.remove(), () => ghost.remove());
    }
  }, [items, keys]);

  const navigateChange = (direction: -1 | 1) => {
    const element = viewport.current;
    if (!element) return;
    const current = virtualizer.getVirtualItemForOffset(element.scrollTop + 2)?.index ?? 0;
    const starts = file.lines.flatMap((line, index) => {
      const changed = line.kind === 'add' || line.kind === 'remove';
      const prior = file.lines[index - 1];
      return changed && (!prior || prior.kind === 'context' || prior.kind === 'hunk') ? [index] : [];
    });
    const target = direction > 0 ? starts.find(index => index > current) : starts.reverse().find(index => index < current);
    if (target === undefined) return;
    pause();
    const offset = virtualizer.getOffsetForIndex(target, 'start')?.[0] ?? 0;
    // Travel to the change and light its first row briefly.
    scrollInner(Math.max(0, offset - rowHeight), true);
    const key = keys[target]!;
    window.setTimeout(() => {
      const row = rowElements.current.get(key);
      if (!row) return;
      row.removeAttribute('data-flash');
      void row.offsetWidth;
      row.setAttribute('data-flash', '');
      window.setTimeout(() => row.removeAttribute('data-flash'), 950);
    }, 0);
  };

  const overflowing = totalHeight > (expanded ? 24 : 8) * rowHeight + 1;
  return <section className="my-2 min-w-0 overflow-hidden rounded-xl border border-border/60 bg-muted/20"
    data-conversation-file-preview={file.path} data-phase={phase} style={syntaxVars as React.CSSProperties}
    data-preview-expanded={expanded || undefined} data-preview-paused={paused && overflowing || undefined}>
    <header className="flex min-w-0 items-center gap-2 bg-muted/35 px-3 py-2 typography-meta">
      {showFileIcons || busy || failed ? <Icon key={busy ? 'busy' : failed ? 'failed' : 'file'} name={busy ? 'loader-4' : failed ? 'error-warning' : 'file-code'}
        className={cn('size-3.5 shrink-0', busy && 'animate-spin', settles && 'workbench-diff-icon-settle', failed && 'text-[var(--status-error)]')} /> : null}
      <button type="button" title={pathLabel} data-varin-file-path={file.path || undefined}
        disabled={!file.path || !onOpen || file.operation === 'delete'} onClick={onOpen}
        className="flex min-w-0 flex-1 text-left text-muted-foreground enabled:hover:text-foreground enabled:hover:underline">
        <SwapText text={file.path ? file.path.replace(/\\/g, '/').split('/').at(-1)! : pathLabel} live={!file.path} />
      </button>
      {file.counts ? <span className="workbench-diff-counts flex shrink-0 gap-1.5 font-mono typography-micro tabular-nums">
        <span className="text-[var(--status-success)]">+<SwapText text={String(file.counts.added)} hold={0} /></span>
        <span className="text-[var(--status-error)]">−<SwapText text={String(file.counts.removed)} hold={0} /></span>
      </span> : null}
      <button type="button" aria-expanded={expanded} title={t(expanded ? 'chat.fileChange.collapse' : 'chat.fileChange.expand')}
        aria-label={t(expanded ? 'chat.fileChange.collapse' : 'chat.fileChange.expand')}
        className="rounded p-0.5 text-muted-foreground hover:bg-interactive-hover" onClick={() => {
          view.expanded = !expanded;
          setExpanded(view.expanded);
        }}>
        <Icon name={expanded ? 'arrow-up-s' : 'arrow-down-s'} className="size-3.5" />
      </button>
    </header>
    {file.lines.length ? <div ref={viewport} role="region" data-conversation-tool-scroll="true" aria-label={t('chat.fileChange.previewLabel', { path: pathLabel })}
      tabIndex={0} className="workbench-diff-preview-viewport overflow-x-hidden overflow-y-auto overscroll-contain font-mono typography-code outline-offset-[-2px]"
      style={{ height: Math.min(totalHeight, (expanded ? 24 : 8) * rowHeight), overflowAnchor: 'none', scrollbarGutter: 'stable' }}
      onWheel={event => { if (event.deltaY < 0) pause(); }}
      onPointerDown={pause}
      onKeyDown={event => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) pause(); }}
      onScroll={event => {
        const element = event.currentTarget;
        const own = Math.abs(element.scrollTop - programmatic.current) <= 2;
        if (!own && element.scrollTop > previousTop.current && element.scrollHeight - element.clientHeight - element.scrollTop <= 1) {
          following.current = true;
          view.following = true;
          setPaused(false);
        }
        previousTop.current = element.scrollTop;
        view.scrollTop = element.scrollTop;
      }}>
      <div style={{ height: totalHeight, width: '100%', position: 'relative' }}>
        {items.map(item => {
          const line = file.lines[item.index]!;
          const key = String(item.key);
          const code = line.typed !== undefined
            ? <>{line.text.slice(0, line.typed)}<span className="workbench-diff-caret" /><span className="workbench-diff-rest">{line.text.slice(line.typed)}</span></>
            : <>{line.pending ? ink(key, line.text, writing) : line.text || ' '}{line.pending && writing ? <span className="workbench-diff-caret" /> : null}</>;
          return <div key={key} ref={element => {
            virtualizer.measureElement(element);
            if (element) rowElements.current.set(key, element);
          }} data-index={item.index} data-row-key={key} data-change-kind={line.kind} data-ahead={line.ahead || undefined} data-pending={line.pending || undefined}
            className={cn('workbench-diff-row absolute left-0 flex w-full min-w-0 pr-3',
              line.kind === 'add' && 'bg-[var(--status-success)]/10',
              line.kind === 'remove' && 'bg-[var(--status-error)]/10',
              line.kind === 'hunk' && 'text-muted-foreground bg-muted/25')}
            style={{ top: item.start, minHeight: rowHeight, lineHeight: `${rowHeight}px` }}>
            <span aria-hidden="true" className={cn('w-7 shrink-0 select-none text-center',
              line.kind === 'add' ? 'text-[var(--status-success)]' : line.kind === 'remove' ? 'text-[var(--status-error)]' : 'text-muted-foreground')}>
              {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
            </span>
            {html?.[item.index] !== undefined
              ? <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]" dangerouslySetInnerHTML={{ __html: html[item.index]! }} />
              : <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{code}</span>}
          </div>;
        })}
        <div ref={ghostLayer} aria-hidden="true" className="pointer-events-none absolute inset-0" />
      </div>
    </div> : <p className="px-3 py-2 typography-meta text-muted-foreground">{t(file.operation === 'delete' ? 'chat.fileChange.deleteFile' : phase === 'generating' ? 'chat.fileChange.receivingContent' : 'chat.fileChange.empty')}</p>}
    <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 typography-micro text-muted-foreground">
      <span role="status" className={cn('min-w-0', failed && 'text-[var(--status-error)]')}><SwapText text={t(`chat.fileChange.${phase}`)} /></span>
      {file.operation === 'write' ? <span title={t('chat.fileChange.writeHint')}>{t('chat.fileChange.writeContent')}</span> : null}
      <span className="ml-auto flex items-center gap-2">
        {paused && overflowing ? <button type="button" className="workbench-status-arrival hover:text-foreground" onClick={follow}>{t('chat.fileChange.latest')}</button> : null}
        {expanded && file.counts ? <>
          <button type="button" aria-label={t('chat.fileChange.previous')} title={t('chat.fileChange.previous')} onClick={() => navigateChange(-1)}><Icon name="arrow-up-s" className="size-3.5" /></button>
          <button type="button" aria-label={t('chat.fileChange.next')} title={t('chat.fileChange.next')} onClick={() => navigateChange(1)}><Icon name="arrow-down-s" className="size-3.5" /></button>
        </> : null}
      </span>
    </footer>
  </section>;
};
