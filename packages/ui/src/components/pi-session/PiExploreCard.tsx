import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { ExploreProgressActivity, ExploreSearchSnippet, PiToolCall, PiToolResultMessage } from '@varin/protocol';
import type { PiToolExecutionState } from '@/stores/usePiSessionStore';
import { Icon } from '@/components/icon/Icon';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import { getRuntimeKey } from '@varin/application-client';
import { ensureOutsideFileGrantForDesktop } from '@/lib/outsideFileGrants';
import { getDirectoryForFilePath, isFilePathWithinDirectory, toAbsoluteFilePath } from '@/lib/path-utils';
import { useUIStore } from '@/stores/useUIStore';
import { explorePresentation, exploreRecord } from './explorePresentation';

type ExploreView = { expanded: boolean; sequence: number };
const ExploreViews = React.createContext<Map<string, ExploreView> | undefined>(undefined);
export const PiExploreScope: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [views] = React.useState(() => new Map<string, ExploreView>());
  return <ExploreViews.Provider value={views}>{children}</ExploreViews.Provider>;
};

// UI clock advances only a mounted running card, from the latest Host elapsed
// receipt. Absolute server clocks may differ on a remote connection.
function useExploreElapsed(elapsed: number | undefined, running: boolean): number | undefined {
  const [clock, setClock] = React.useState({ receipt: elapsed, extra: 0 });
  React.useEffect(() => {
    if (!running || elapsed === undefined) return;
    const receivedAt = performance.now();
    const timer = window.setInterval(() => setClock({ receipt: elapsed, extra: performance.now() - receivedAt }), 1000);
    return () => window.clearInterval(timer);
  }, [elapsed, running]);
  return elapsed === undefined ? undefined : elapsed + (running && clock.receipt === elapsed ? clock.extra : 0);
}

const shortPath = (path: string) => path.replace(/\\/g, '/').split('/').at(-1) ?? path;
const snippetKey = (snippet: ExploreSearchSnippet) => JSON.stringify([snippet.path, snippet.revision, snippet.startLine, snippet.endLine]);
const EMPTY_ACTIVITIES: ExploreProgressActivity[] = [];
const PREVIEW_ROWS = 4;

export const PiExploreCard: React.FC<{
  call: PiToolCall;
  cwd: string;
  execution?: PiToolExecutionState;
  result?: PiToolResultMessage;
  generating?: boolean;
  rawDetails: React.ReactNode;
}> = ({ call, cwd, execution, result, generating, rawDetails }) => {
  const { t } = useI18n();
  const presentation = React.useMemo(() => explorePresentation(execution, result, generating), [execution, result, generating]);
  const { phase, progress, snippets, details, running, returnedFiles } = presentation;
  const contentId = React.useId();
  const views = React.useContext(ExploreViews);
  const activities = progress?.activities ?? EMPTY_ACTIVITIES;
  const [view] = React.useState(() => views?.get(call.id) ?? { expanded: false, sequence: activities.at(-1)?.sequence ?? -1 });
  const [expanded, setExpanded] = React.useState(view.expanded);
  const [selectedKey, setSelectedKey] = React.useState<string>();
  const selected = snippets?.find(snippet => snippetKey(snippet) === selectedKey);
  const reducedMotion = usePrefersReducedMotion();
  const alive = React.useRef(true);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  React.useLayoutEffect(() => {
    views?.set(call.id, view);
    view.sequence = activities.at(-1)?.sequence ?? view.sequence;
  }, [activities, call.id, view, views]);
  const elapsed = useExploreElapsed(progress?.elapsedMs, running);
  const args = exploreRecord(call.arguments);
  const question = typeof args?.question === 'string' ? args.question : '';
  const paths = Array.isArray(args?.paths) ? args.paths.filter((path): path is string => typeof path === 'string') : [cwd];
  const warning = ['partial', 'failed', 'invalid', 'unavailable'].includes(phase);
  const showResults = snippets !== undefined && !running;
  const visibleSnippets = expanded ? snippets : snippets?.slice(0, PREVIEW_ROWS);
  const visibleActivities = expanded ? activities : activities.slice(-PREVIEW_ROWS);
  const toggle = () => { view.expanded = !expanded; setExpanded(view.expanded); };
  const runtimeKey = getRuntimeKey();
  const open = async (path: string, line: number) => {
    try {
      const absolute = toAbsoluteFilePath(cwd, path);
      if (!isFilePathWithinDirectory(absolute, cwd)) await ensureOutsideFileGrantForDesktop(absolute, cwd);
      if (!alive.current || runtimeKey !== getRuntimeKey()) return;
      useUIStore.getState().openContextFileAtLine(cwd || getDirectoryForFilePath(cwd, absolute), absolute, line, 1);
    } catch (error) {
      if (alive.current && runtimeKey === getRuntimeKey()) toast.error(error instanceof Error ? error.message : String(error));
    }
  };
  const seconds = (ms: number) => t('chat.explore.seconds', { count: (ms / 1000).toFixed(1) });
  const activity = (item: ExploreProgressActivity, recent: boolean) => <motion.li key={item.sequence}
    layout={recent && !reducedMotion ? 'position' : false}
    initial={recent && !reducedMotion && item.sequence > view.sequence ? { opacity: 0, y: 8 } : false}
    animate={{ opacity: 1, y: 0 }} exit={recent ? { opacity: 0, y: -8 } : undefined}
    transition={{ duration: recent && !reducedMotion ? 0.22 : 0 }}
    className={cn('flex min-w-0 items-center gap-2 px-3 py-1 typography-meta text-muted-foreground',
      recent && item.sequence > view.sequence && 'pi-explore-arrival')}
    data-explore-sequence={item.sequence}>
    {item.kind === 'read' ? <FileTypeIcon filePath={item.path} className="size-3.5" /> : <Icon name={item.kind === 'phase' ? 'arrow-right-s'
      : ['failed', 'unavailable', 'incomplete'].includes(item.source.status) ? 'error-warning'
        : ['running', 'pending'].includes(item.source.status) ? 'arrow-right-s' : item.source.status === 'ready' ? 'check' : 'subtract'}
      className="size-3.5 shrink-0" />}
    {item.kind === 'read' ? <button type="button" className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left hover:text-foreground hover:underline"
      title={t('chat.explore.openCurrent', { path: item.path })} onClick={() => void open(item.path, item.startLine)}>
      <span className="truncate">{shortPath(item.path)}</span>
      <span className="shrink-0 font-mono typography-micro text-muted-foreground">L{item.startLine}–{item.endLine}</span>
    </button> : <span className="min-w-0 flex-1 truncate"
      title={item.kind === 'source' ? item.source.targets?.join(' · ') : undefined}>
      {item.kind === 'phase' ? t(`chat.explore.phase.${item.phase}`)
        : <>{t(`chat.explore.source.${item.source.family}`)}{item.source.targets?.length ? ` · ${item.source.targets.join(' · ')}` : ''}</>}
    </span>}
    {item.kind === 'source' ? <span className="shrink-0 typography-micro">{t(`chat.explore.sourceStatus.${item.source.status}`)}</span> : null}
  </motion.li>;

  return <section className="my-2 min-w-0 overflow-hidden rounded-xl border border-border/60 bg-muted/20" data-pi-explore={call.id}>
    <button type="button" onClick={toggle} aria-expanded={expanded} aria-controls={contentId}
      className="flex w-full min-w-0 items-center gap-2 bg-muted/35 px-3 py-2 text-left typography-meta transition-colors hover:bg-muted/50">
      <Icon name="binoculars" className="size-4 shrink-0 text-muted-foreground" />
      <span className="shrink-0 font-medium">{t('chat.explore.title')}</span>
      <span className={cn('min-w-0 flex-1 text-muted-foreground', expanded ? 'break-words' : 'truncate')} title={expanded ? undefined : question}>
        {question || t(`chat.explore.phase.${phase}`)}
      </span>
      {elapsed !== undefined ? <span className="shrink-0 typography-micro tabular-nums text-muted-foreground">{seconds(elapsed)}</span> : null}
      <Icon name="arrow-down-s" className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
    </button>
    <div id={contentId} className="min-w-0 py-1">
      {showResults && visibleSnippets?.length ? <ol data-pi-tool-scroll={expanded || undefined}
        tabIndex={expanded ? 0 : undefined}
        className={cn(expanded && 'max-h-72 overflow-auto overscroll-contain')} aria-label={t('chat.explore.results')}>
        {visibleSnippets.map((snippet, index) => <li key={`${snippetKey(snippet)}:${index}`}
          className="flex min-w-0 items-center gap-2 px-3 py-1 typography-meta transition-colors hover:bg-muted/35">
          <FileTypeIcon filePath={snippet.path} className="size-3.5" />
          <button type="button" className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left hover:underline"
            title={t('chat.explore.openCurrent', { path: snippet.path })} onClick={() => void open(snippet.path, snippet.startLine)}>
            <span className="truncate font-medium">{shortPath(snippet.path)}</span>
            <span className="shrink-0 font-mono typography-micro text-muted-foreground">L{snippet.startLine}–{snippet.endLine}</span>
          </button>
          {expanded ? <button type="button" className="shrink-0 typography-micro text-muted-foreground hover:text-foreground hover:underline"
            aria-expanded={selected === snippet} onClick={() => setSelectedKey(selected === snippet ? undefined : snippetKey(snippet))}>{t('chat.explore.excerpt')}</button> : null}
        </li>)}
      </ol> : running && visibleActivities.length > 0 ? <div className={cn('overflow-hidden', expanded && 'max-h-72 overflow-auto overscroll-contain')}
        tabIndex={expanded ? 0 : undefined} data-pi-tool-scroll={expanded || undefined}>
        <ol className="relative" aria-label={t('chat.explore.process')}>
          <AnimatePresence initial={false} mode="popLayout">{visibleActivities.map(item => activity(item, !expanded))}</AnimatePresence>
        </ol>
      </div> : <p className="px-3 py-2 typography-meta text-muted-foreground">{t(`chat.explore.phase.${phase}`)}</p>}
      {phase !== 'cancelled' && typeof details?.error === 'string' ? <p className={cn('break-words px-3 py-2 typography-meta text-[var(--status-error)]', !expanded && 'line-clamp-2')}>{details.error}</p> : null}
      {expanded && selected ? <div className="mx-3 my-2 overflow-hidden rounded-lg border border-border/50">
        <div className="break-all bg-muted/20 px-3 py-2 typography-micro text-muted-foreground">
          {selected.path}:{selected.startLine}–{selected.endLine} · {t('chat.explore.snapshot')} · {selected.source} · {selected.revision}
        </div>
        <pre data-pi-tool-scroll="true" className="max-h-72 overflow-auto overscroll-contain whitespace-pre-wrap break-words px-3 py-2 font-mono typography-code"><code>{selected.text}</code></pre>
        {selected.why ? <p className="break-words px-3 pb-2 typography-micro text-muted-foreground">{selected.why}</p> : null}
      </div> : null}
      {expanded ? <div className="space-y-2 px-3 py-2">
        {details?.partial === true ? <p className="typography-meta text-[var(--status-warning)]">{t('chat.explore.partialNote')}</p> : null}
        <div className="break-words typography-micro text-muted-foreground">{t('chat.explore.scope')} · {paths.join(' · ')}</div>
        <details><summary className="cursor-pointer typography-micro text-muted-foreground">{t('chat.explore.raw')}</summary><div className="mt-2 space-y-2">{rawDetails}</div></details>
      </div> : null}
    </div>
    <footer className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/40 px-3 py-1.5 typography-micro text-muted-foreground">
      <span role="status" className={cn('min-w-0 flex-1', warning && (phase === 'failed' || phase === 'invalid' ? 'text-[var(--status-error)]' : 'text-[var(--status-warning)]'))}>
        {warning || running ? <>{t(`chat.explore.phase.${phase}`)}{showResults || running && progress?.receivedSnippets ? ' · ' : ''}</> : null}
        {showResults ? t('chat.explore.returned', { snippets: snippets.length, files: returnedFiles ?? 0 })
          : running && progress?.receivedSnippets ? t('chat.explore.received', { snippets: progress.receivedSnippets, files: progress.receivedFiles })
            : !warning && !running ? t(`chat.explore.phase.${phase}`) : null}
      </span>
      <button type="button" className="ml-auto inline-flex shrink-0 items-center gap-0.5 hover:text-foreground" onClick={toggle}
        aria-expanded={expanded} aria-controls={contentId}>
        {t(expanded ? 'chat.explore.collapse' : 'chat.explore.expand')}
        <Icon name="arrow-down-s" className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />
      </button>
    </footer>
  </section>;
};
