import React from 'react';
import type { ExploreProgressActivity, ExploreSearchSnippet, PiToolCall, PiToolResultMessage } from '@varin/protocol';
import type { PiToolExecutionState } from '@/stores/usePiSessionStore';
import { Icon } from '@/components/icon/Icon';
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
  const { phase, progress, snippets, details, running, final, returnedFiles } = presentation;
  const views = React.useContext(ExploreViews);
  const activities = progress?.activities ?? EMPTY_ACTIVITIES;
  const [view] = React.useState(() => views?.get(call.id) ?? { expanded: false, sequence: activities.at(-1)?.sequence ?? -1 });
  const [expanded, setExpanded] = React.useState(view.expanded);
  const [selectedKey, setSelectedKey] = React.useState<string>();
  const selected = snippets?.find(snippet => snippetKey(snippet) === selectedKey);
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
  const model = exploreRecord(details?.model);
  const warning = ['partial', 'failed', 'invalid', 'unavailable'].includes(phase);
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
  const activity = (item: ExploreProgressActivity, recent: boolean) => <li key={item.sequence}
    className={cn('relative flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1 typography-meta text-muted-foreground',
      recent && item.sequence > view.sequence && 'pi-explore-arrival')}
    data-explore-sequence={item.sequence} data-explore-active={recent && running && item.sequence === activities.at(-1)?.sequence || undefined}>
    <Icon name={item.kind === 'read' ? 'file-code' : item.kind === 'phase' ? 'arrow-right-s'
      : ['failed', 'unavailable', 'incomplete'].includes(item.source.status) ? 'error-warning'
        : ['running', 'pending'].includes(item.source.status) ? 'arrow-right-s' : item.source.status === 'ready' ? 'check' : 'subtract'}
      className="mt-0.5 size-3.5 shrink-0 self-start" />
    <span className="min-w-0 flex-1 break-words">
      {item.kind === 'phase' ? t(`chat.explore.phase.${item.phase}`) : item.kind === 'source'
        ? <>{t(`chat.explore.source.${item.source.family}`)} · {t(`chat.explore.sourceStatus.${item.source.status}`)}
          {item.source.targets?.length ? <span className={cn('block typography-micro', recent ? 'truncate' : 'break-all')}
            title={item.source.targets.join(' · ')}>{item.source.targets.join(' · ')}</span> : null}</>
        : <>{t('chat.explore.read')} <button type="button" className="text-left hover:text-foreground hover:underline" title={t('chat.explore.openCurrent', { path: item.path })}
            onClick={() => void open(item.path, item.startLine)}>{shortPath(item.path)}</button>
          <span className="ml-1 font-mono typography-micro">{item.startLine}–{item.endLine}</span></>}
    </span>
    {!recent ? <span className="shrink-0 typography-micro tabular-nums">{t('chat.explore.observedAt', { time: seconds(item.elapsedMs) })}</span> : null}
  </li>;

  return <section className="my-2 min-w-0" data-pi-explore={call.id}>
    <button type="button" onClick={toggle} aria-expanded={expanded} className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md py-1.5 text-left typography-meta hover:bg-muted/20">
      <Icon name="binoculars" className="size-4 shrink-0 text-muted-foreground" />
      <span className="font-medium">{t('chat.explore.title')}</span>
      <span className={cn('min-w-0 flex-1 text-muted-foreground', warning && (phase === 'failed' || phase === 'invalid' ? 'text-[var(--status-error)]' : 'text-[var(--status-warning)]'))}>{t(`chat.explore.phase.${phase}`)}</span>
      {elapsed !== undefined ? <span className="shrink-0 typography-micro tabular-nums text-muted-foreground">{seconds(elapsed)}</span> : null}
      <Icon name="arrow-down-s" className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
    </button>
    {question ? <p className={cn('ml-6 break-words typography-meta text-muted-foreground', !expanded && 'line-clamp-2')}
      title={expanded ? undefined : question}>{question}</p> : null}
    {!expanded && running && activities.length > 0 ? <ol className="relative my-2 ml-2 border-l border-border/60 pl-4" aria-label={t('chat.explore.process')}>
      {activities.slice(-4).map(item => activity(item, true))}
    </ol> : null}
    <div className="ml-6 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 typography-micro text-muted-foreground">
      <span role="status">{final && snippets ? t('chat.explore.returned', { snippets: snippets.length, files: returnedFiles ?? 0 })
        : progress ? t('chat.explore.received', { snippets: progress.receivedSnippets, files: progress.receivedFiles })
          : t(`chat.explore.phase.${phase}`)}</span>
      <button type="button" className="hover:text-foreground hover:underline" onClick={toggle} aria-expanded={expanded}>
        {t(expanded ? 'chat.explore.collapse' : final ? 'chat.explore.results' : 'chat.explore.process')}
      </button>
    </div>
    {expanded ? <div className="ml-6 mt-3 space-y-3">
      <div className="break-words typography-micro text-muted-foreground">{t('chat.explore.scope')} · {paths.join(' · ')}</div>
      {snippets && snippets.length > 0 ? <div className="space-y-1" aria-label={t('chat.explore.results')}>
        {snippets.map((snippet, index) => <div key={`${snippet.path}:${snippet.revision}:${snippet.startLine}:${index}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 typography-meta">
          <button type="button" className="min-w-0 break-all text-left hover:underline" title={t('chat.explore.openCurrent', { path: snippet.path })}
            onClick={() => void open(snippet.path, snippet.startLine)}>{shortPath(snippet.path)} <span className="font-mono typography-micro text-muted-foreground">{snippet.startLine}–{snippet.endLine}</span></button>
          <button type="button" className="typography-micro text-muted-foreground hover:text-foreground hover:underline"
            aria-expanded={selected === snippet} onClick={() => setSelectedKey(selected === snippet ? undefined : snippetKey(snippet))}>{t('chat.explore.excerpt')}</button>
        </div>)}
      </div> : null}
      {selected ? <div className="overflow-hidden rounded-lg border border-border/50">
        <div className="break-all bg-muted/20 px-3 py-2 typography-micro text-muted-foreground">
          {selected.path}:{selected.startLine}–{selected.endLine} · {t('chat.explore.snapshot')} · {selected.source} · {selected.revision}
        </div>
        <pre data-pi-tool-scroll="true" className="max-h-72 overflow-auto overscroll-contain whitespace-pre-wrap break-words px-3 py-2 font-mono typography-code"><code>{selected.text}</code></pre>
        {selected.why ? <p className="break-words px-3 pb-2 typography-micro text-muted-foreground">{selected.why}</p> : null}
      </div> : null}
      {details?.partial === true ? <p className="typography-meta text-[var(--status-warning)]">{t('chat.explore.partialNote')}</p> : null}
      {phase !== 'cancelled' && typeof details?.error === 'string' ? <p className="break-words typography-meta text-[var(--status-error)]">{details.error}</p> : null}
      {activities.length ? <div>
        <p className="typography-micro text-muted-foreground">{t('chat.explore.process')}</p>
        <ol data-pi-tool-scroll="true" className="mt-1 max-h-72 overflow-auto overscroll-contain border-l border-border/60 pl-3">{activities.map(item => activity(item, false))}</ol>
      </div> : null}
      {model ? <div className="flex flex-wrap gap-x-3 gap-y-1 typography-micro text-muted-foreground">
        {(['plan', 'select', 'followup', 'rerank', 'fastDecision'] as const).map(key => typeof model[key] === 'string'
          && ['used', 'skipped', 'unconfigured', 'disabled', 'failed', 'cancelled'].includes(model[key] as string)
          ? <span key={key}>{t(`chat.explore.model.${key}`)} · {t(`chat.explore.modelStatus.${model[key] as 'used' | 'skipped' | 'unconfigured' | 'disabled' | 'failed' | 'cancelled'}`)}</span> : null)}
        {typeof model.note === 'string' ? <p className="basis-full break-words">{model.note}</p> : null}
      </div> : null}
      <details><summary className="cursor-pointer typography-micro text-muted-foreground">{t('chat.explore.raw')}</summary><div className="mt-2 space-y-2">{rawDetails}</div></details>
    </div> : null}
  </section>;
};
