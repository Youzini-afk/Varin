import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { getMarkdownSyntaxVars } from '@/components/chat/markdown/markdownSyntaxVars';
import { highlightLinesInWorker } from '@/components/chat/markdown/markdown-worker';
import type { FileChangeLine, FileChangePhase, FileChangePreview } from './fileChangePreview';

type PreviewView = { expanded: boolean; following: boolean; scrollTop: number };
const PreviewViews = React.createContext<Map<string, PreviewView> | undefined>(undefined);

/** The mounted turn keeps user navigation across live-to-persisted remounts. */
export const PiFileChangePreviewScope: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [views] = React.useState(() => new Map<string, PreviewView>());
  return <PreviewViews.Provider value={views}>{children}</PreviewViews.Provider>;
};

// Keep at most one highlighting job in flight per preview. New deltas replace
// the pending snapshot; they do not accumulate worker work behind the stream.
function useHighlightedDiff(lines: FileChangeLine[], language: string) {
  const latest = React.useRef({ lines, language });
  const running = React.useRef(false);
  const alive = React.useRef(true);
  const [highlighted, setHighlighted] = React.useState<{ lines: FileChangeLine[]; html: (string | undefined)[] }>();
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  React.useEffect(() => {
    latest.current = { lines, language };
    if (running.current) return;
    running.current = true;
    void (async () => {
      try {
        while (alive.current) {
          const job = latest.current;
          const before = job.lines.filter(line => line.kind === 'remove' || line.kind === 'context');
          const after = job.lines.filter(line => line.kind === 'add' || line.kind === 'context');
          const [oldHtml, newHtml] = await Promise.all([
            before.length ? highlightLinesInWorker(before.map(line => line.text).join('\n'), job.language) : null,
            after.length ? highlightLinesInWorker(after.map(line => line.text).join('\n'), job.language) : null,
          ]);
          if (!alive.current) break;
          if (job !== latest.current) continue;
          let oldIndex = 0;
          let newIndex = 0;
          const html = job.lines.map(line => {
            if (line.kind === 'hunk') return undefined;
            if (line.kind === 'remove') return oldHtml?.[oldIndex++];
            if (line.kind === 'context') oldIndex++;
            return newHtml?.[newIndex++];
          });
          setHighlighted({ lines: job.lines, html });
          break;
        }
      } catch {
        // Highlighting is optional; the current escaped text remains visible.
      } finally { running.current = false; }
    })();
  }, [lines, language]);
  // Preserve coloring of unchanged received lines while the next snapshot is
  // highlighted; appending a token must not flash the whole card back to plain.
  return lines.map((line, index) => {
    const previous = highlighted?.lines[index];
    return previous?.text === line.text && previous.kind === line.kind ? highlighted?.html[index] : undefined;
  });
}

export const PiFileChangePreview: React.FC<{
  previewId: string;
  file: FileChangePreview;
  phase: FileChangePhase;
  onOpen?: () => void;
}> = ({ previewId, file, phase, onOpen }) => {
  const { t } = useI18n();
  const theme = useOptionalThemeSystem();
  const syntaxVars = React.useMemo(() => theme ? getMarkdownSyntaxVars(theme.currentTheme) : {}, [theme]);
  const viewport = React.useRef<HTMLDivElement>(null);
  const views = React.useContext(PreviewViews);
  const [view] = React.useState(() => views?.get(previewId) ?? { expanded: false, following: true, scrollTop: 0 });
  const following = React.useRef(view.following);
  const previousTop = React.useRef(view.scrollTop);
  const [paused, setPaused] = React.useState(!view.following);
  const [expanded, setExpanded] = React.useState(view.expanded);
  const [rowHeight, setRowHeight] = React.useState(22);
  const html = useHighlightedDiff(file.lines, getLanguageFromExtension(file.path.replace(/\\/g, '/')) ?? 'text');
  const virtualizer = useVirtualizer({
    count: file.lines.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => rowHeight,
    initialRect: { width: 640, height: rowHeight * 8 },
    initialOffset: view.scrollTop,
  });
  const busy = phase === 'generating' || phase === 'applying';
  const failed = phase === 'failed' || phase === 'partial';
  const hasLines = file.lines.length > 0;
  const pause = () => { view.following = false; following.current = false; setPaused(true); };
  const follow = React.useCallback(() => {
    view.following = true;
    following.current = true;
    setPaused(false);
    const element = viewport.current;
    if (element) {
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      previousTop.current = element.scrollTop;
      view.scrollTop = element.scrollTop;
    }
  }, [view]);

  React.useLayoutEffect(() => {
    views?.set(previewId, view);
    const element = viewport.current;
    if (!element) return;
    element.scrollTop = view.scrollTop;
    const measure = () => {
      const size = Number.parseFloat(getComputedStyle(element).fontSize);
      if (Number.isFinite(size) && size > 0) setRowHeight(Math.ceil(size * 1.65));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [previewId, view, views, hasLines]);
  React.useLayoutEffect(() => { virtualizer.measure(); }, [rowHeight, virtualizer]);
  React.useLayoutEffect(() => {
    // This scroll owner moves only the inner preview. The timeline continues
    // to own page following and its extra manual-scrolling space.
    if (following.current) follow();
  }, [file.lines, rowHeight, expanded, follow]);

  const navigateChange = (direction: -1 | 1) => {
    const element = viewport.current;
    if (!element) return;
    const current = Math.round(element.scrollTop / rowHeight);
    const starts = file.lines.flatMap((line, index) => {
      const changed = line.kind === 'add' || line.kind === 'remove';
      const prior = file.lines[index - 1];
      return changed && (!prior || prior.kind === 'context' || prior.kind === 'hunk') ? [index] : [];
    });
    const target = direction > 0 ? starts.find(index => index > current) : starts.reverse().find(index => index < current);
    if (target === undefined) return;
    pause();
    element.scrollTop = target * rowHeight;
    previousTop.current = element.scrollTop;
  };

  return <section className="my-2 min-w-0 overflow-hidden rounded-xl border border-border/60 bg-muted/20"
    data-pi-file-preview={file.path} style={syntaxVars as React.CSSProperties}>
    <header className="flex min-w-0 items-center gap-2 bg-muted/35 px-3 py-2 typography-meta">
      <Icon name={busy ? 'loader-4' : failed ? 'error-warning' : 'file-code'}
        className={cn('size-3.5 shrink-0', busy && 'animate-spin', failed && 'text-[var(--status-error)]')} />
      <button type="button" title={file.path} data-varin-file-path={file.path}
        disabled={!onOpen || file.operation === 'delete'} onClick={onOpen}
        className="min-w-0 flex-1 truncate text-left text-muted-foreground enabled:hover:text-foreground enabled:hover:underline">
        {file.path.replace(/\\/g, '/').split('/').at(-1)}
      </button>
      {file.counts ? <span className="flex shrink-0 gap-1.5 font-mono typography-micro tabular-nums">
        <span className="text-[var(--status-success)]">+{file.counts.added}</span>
        <span className="text-[var(--status-error)]">−{file.counts.removed}</span>
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
    {file.lines.length ? <div ref={viewport} role="region" data-pi-file-scroll="true" aria-label={t('chat.fileChange.previewLabel', { path: file.path })}
      tabIndex={0} className="overflow-auto overscroll-contain font-mono typography-code outline-offset-[-2px]"
      style={{ height: Math.min(file.lines.length, expanded ? 24 : 8) * rowHeight, overflowAnchor: 'none' }}
      onWheel={event => { if (event.deltaY < 0) pause(); }}
      onPointerDown={pause}
      onKeyDown={event => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) pause(); }}
      onScroll={event => {
        const element = event.currentTarget;
        if (element.scrollTop < previousTop.current) pause();
        if (element.scrollTop > previousTop.current && element.scrollHeight - element.clientHeight - element.scrollTop <= 1) {
          following.current = true;
          view.following = true;
          setPaused(false);
        }
        previousTop.current = element.scrollTop;
        view.scrollTop = element.scrollTop;
      }}>
      <div style={{ height: virtualizer.getTotalSize(), minWidth: '100%', width: 'max-content', position: 'relative' }}>
        {virtualizer.getVirtualItems().map(item => {
          const line = file.lines[item.index]!;
          return <div key={item.key} data-change-kind={line.kind}
            className={cn('absolute left-0 flex w-max min-w-full whitespace-pre pr-3',
              line.kind === 'add' && 'bg-[var(--status-success)]/10',
              line.kind === 'remove' && 'bg-[var(--status-error)]/10',
              line.kind === 'hunk' && 'text-muted-foreground bg-muted/25')}
            style={{ top: item.start, height: rowHeight, lineHeight: `${rowHeight}px` }}>
            <span aria-hidden="true" className={cn('sticky left-0 w-7 shrink-0 select-none text-center',
              line.kind === 'add' ? 'text-[var(--status-success)]' : line.kind === 'remove' ? 'text-[var(--status-error)]' : 'text-muted-foreground')}>
              {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
            </span>
            {html?.[item.index] !== undefined
              ? <span dangerouslySetInnerHTML={{ __html: html[item.index]! }} />
              : <span>{line.text || ' '}</span>}
          </div>;
        })}
      </div>
    </div> : <p className="px-3 py-2 typography-meta text-muted-foreground">{t(file.operation === 'delete' ? 'chat.fileChange.deleteFile' : 'chat.fileChange.empty')}</p>}
    <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 typography-micro text-muted-foreground">
      <span role="status" className={cn(failed && 'text-[var(--status-error)]')}>{t(`chat.fileChange.${phase}`)}</span>
      {file.operation === 'write' ? <span title={t('chat.fileChange.writeHint')}>{t('chat.fileChange.writeContent')}</span> : null}
      <span className="ml-auto flex items-center gap-2">
        {paused && file.lines.length > 0 ? <button type="button" className="hover:text-foreground" onClick={follow}>{t('chat.fileChange.latest')}</button> : null}
        {expanded && file.counts ? <>
          <button type="button" aria-label={t('chat.fileChange.previous')} title={t('chat.fileChange.previous')} onClick={() => navigateChange(-1)}><Icon name="arrow-up-s" className="size-3.5" /></button>
          <button type="button" aria-label={t('chat.fileChange.next')} title={t('chat.fileChange.next')} onClick={() => navigateChange(1)}><Icon name="arrow-down-s" className="size-3.5" /></button>
        </> : null}
      </span>
    </footer>
  </section>;
};
