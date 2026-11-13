import { flushUiSessions } from '@/lib/interactive-ui/sessions';
import React from 'react';
import { getRuntimeEndpointGeneration, getThreadObservationBus, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import type { ThreadConversationTree, ThreadConversationTreeNode, ThreadIdentity, ThreadsAPI, ThreadTreePreview } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useThreadStore, threadComposerKey, threadHostKey } from '@/stores/useThreadStore';
import { EMPTY_TREE_VIEW, useConversationTreeStore } from '@/stores/useConversationTreeStore';
import { openThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { conversationTreePath, conversationTreeRows } from './conversationTreeLayout';
import { openConversationTree } from '@/lib/openConversationTree';
import { ConversationTimeline } from '../conversation/ConversationTimeline';
import type { ThreadHistoryItem } from '@varin/application-client';
import { prefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { useBotNavigation } from '@/lib/bots';
import { useWorkbenchProfileId } from '@/lib/workbench/profile-context';
import { VARIN_WORKBENCH_BOT_PROFILE_ID } from '@varin/extension-contract';

export function ConversationTreePanel({ active = true }: { active?: boolean }) {
  const { t } = useI18n();
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const selected = useThreadStore(state => state.selectedIdentity);
  const botEntry = useBotNavigation(state => state.entry);
  const profile = useWorkbenchProfileId();
  const api = useRuntimeAPIs().threads;
  const identity = profile === VARIN_WORKBENCH_BOT_PROFILE_ID ? botEntry : selected;
  if (!active) return null;
  return identity && api ? <ConversationTree key={`${host}:${identity.threadId}`} api={api} identity={identity} host={host} />
    : <p className="p-4 typography-meta text-muted-foreground">{t('chat.tree.openConversation')}</p>;
}

const previewKey = (node: ThreadConversationTreeNode) => JSON.stringify([node.firstItemId, node.lastItemId]);
function ConversationTree({ api, identity, host }: { api: ThreadsAPI; identity: ThreadIdentity; host: number }) {
  const { t } = useI18n();
  const key = JSON.stringify([threadHostKey(), identity.threadId]);
  const view = useConversationTreeStore(state => state.views[key] ?? EMPTY_TREE_VIEW);
  const [tree, setTree] = React.useState<ThreadConversationTree>();
  const [error, setError] = React.useState<string>();
  const [loading, setLoading] = React.useState(true);
  const [version, refresh] = React.useReducer(value => value + 1, 0);
  const [busy, setBusy] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [searching, setSearching] = React.useState(false);
  const [searchResults, setSearchResults] = React.useState<Record<string, ThreadTreePreview>>({});
  const previewCache = React.useRef(new Map<string, ThreadTreePreview>());
  const previewPending = React.useRef(new Map<string, Promise<ThreadTreePreview>>());
  const lifetime = React.useRef(new AbortController());
  const viewport = React.useRef<HTMLDivElement>(null);
  const identityRef = React.useRef(identity); identityRef.current = identity;
  const treeRef = React.useRef(tree); treeRef.current = tree;
  const readOnly = useThreadStore(state => state.threads.find(thread => thread.thread_id === identity.threadId)?.archived ?? false);
  const setView = (patch: Parameters<ReturnType<typeof useConversationTreeStore.getState>['setView']>[1]) => useConversationTreeStore.getState().setView(key, patch);
  React.useEffect(() => {
    if (lifetime.current.signal.aborted) lifetime.current = new AbortController();
    return () => lifetime.current.abort();
  }, []);
  React.useEffect(() => {
    const controller = new AbortController();
    let reading = false, again = false;
    setLoading(true);
    const read = async () => {
      if (reading) { again = true; return; }
      reading = true;
      try {
        do {
          again = false;
          const next = await api.conversationTree(identityRef.current, controller.signal);
          if (controller.signal.aborted || host !== getRuntimeEndpointGeneration()) return;
          setTree(next); setError(undefined);
        } while (again);
      } catch (cause) { if (!controller.signal.aborted) setError(String(cause)); }
      finally { reading = false; if (!controller.signal.aborted) setLoading(false); }
    };
    void read();
    const unsubscribe = getThreadObservationBus(api).subscribe({threadId: identityRef.current.threadId,
      kinds: ['branch.*', 'history.appended', 'run.*', 'child.*', 'thread.created', 'thread.updated', 'thread.deleted'],
    }, event => {
      if ('stream' in event) { if (event.stream === 'resync') void read(); return; }
      const routes = treeRef.current?.routes;
      if (event.kind === 'branch.created' || event.kind === 'branch.navigated' || event.kind === 'branch.deleted'
          || event.kind === 'history.appended' && routes?.some(route => route.branchId === event.subject)
          || event.kind === 'run.accepted'
          || event.kind.startsWith('run.') && (routes?.some(route => route.activeRunId === event.subject)
            || treeRef.current?.nodes.some(node => node.runId === event.subject))
          || /^(child\.|thread\.)/.test(event.kind)) void read();
    });
    return () => { unsubscribe(); controller.abort(); };
  }, [api, host, version]);
  const readPreview = React.useCallback((node: ThreadConversationTreeNode) => {
    const id = previewKey(node);
    const cached = previewCache.current.get(id);
    if (cached) return Promise.resolve(cached);
    const pending = previewPending.current.get(id);
    if (pending) return pending;
    const signal = lifetime.current.signal;
    const request = api.treePreview({ ...identityRef.current, branchId: node.branchId }, { firstItemId: node.firstItemId, lastItemId: node.lastItemId }, signal).then(result => {
      if (!signal.aborted && host === getRuntimeEndpointGeneration()) {
        previewCache.current.set(id, result);
      }
      return result;
    }).finally(() => previewPending.current.delete(id));
    previewPending.current.set(id, request);
    return request;
  }, [api, host]);
  React.useEffect(() => {
    if (!query.trim() || !tree) return;
    const controller = new AbortController();
    setSearching(true); setSearchResults({});
    void (async () => {
      for (const node of tree.nodes.slice().reverse()) {
        controller.signal.throwIfAborted();
        const result = await api.treePreview({ ...identityRef.current, branchId: node.branchId }, {
          firstItemId: node.firstItemId, lastItemId: node.lastItemId, query,
        }, controller.signal);
        if (!controller.signal.aborted && result.matched) setSearchResults(previous => ({ ...previous, [previewKey(node)]: result }));
      }
    })().catch(cause => { if (!controller.signal.aborted) setError(String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    return () => controller.abort();
  }, [query, tree, api]);
  const initialScroll = React.useRef(view.scrollTop);
  const restoredScroll = React.useRef(false);
  React.useLayoutEffect(() => {
    if (tree && viewport.current && !restoredScroll.current) {
      viewport.current.scrollTop = initialScroll.current;
      restoredScroll.current = true;
    }
  }, [tree]);
  const scrollPosition = React.useRef(view.scrollTop);
  React.useEffect(() => () => useConversationTreeStore.getState().setView(key, { scrollTop: scrollPosition.current }), [key]);
  const path = React.useMemo(() => tree ? conversationTreePath(tree, identity.branchId) : new Set<string>(), [tree, identity.branchId]);
  const rows = React.useMemo(() => tree ? conversationTreeRows(tree, view.expanded, view.selected) : [], [tree, view.expanded, view.selected]);
  const branchStarts = React.useMemo(() => {
    const counts = new Map<string | null, number>();
    for (const node of tree?.nodes ?? []) counts.set(node.parentId, (counts.get(node.parentId) ?? 0) + 1);
    return new Set((tree?.nodes ?? []).filter(node => (counts.get(node.parentId) ?? 0) > 1).map(node => node.id));
  }, [tree]);
  const selectedNode = tree?.nodes.find(node => node.id === view.selected);
  const search = query.trim().toLocaleLowerCase();
  const visibleRows = search && tree ? tree.nodes.filter(node => searchResults[previewKey(node)]?.matched)
    .map(node => ({ kind: 'node' as const, node, depth: 0 })) : rows;
  const action = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await work(); }
    catch (cause) { if (!lifetime.current.signal.aborted) setError(String(cause)); }
    finally { if (!lifetime.current.signal.aborted) setBusy(false); }
  };
  const navigationRequest = React.useRef(0);
  const navigate = async (node: ThreadConversationTreeNode, kind: 'reveal' | 'recover' = 'reveal', branchId?: string) => {
    const request = ++navigationRequest.current;
    const gap = rows.find(row => row.kind === 'gap' && row.nodes.some(item => item.id === node.id));
    setView({ selected: node.id, ...(gap?.kind === 'gap' ? { expanded: { ...view.expanded, [gap.id]: true } } : {}) });
    const target = { ...identity, branchId: branchId ?? (path.has(node.id) ? identity.branchId : node.branchId) };
    try {
      await openThreadFromNavigation(target);
      if (request !== navigationRequest.current || host !== getRuntimeEndpointGeneration() || lifetime.current.signal.aborted) return;
      useConversationTreeStore.getState().request(threadComposerKey(threadHostKey(), target), { kind, entryId: node.firstItemId, runId: node.runId });
    } catch (cause) {
      if (request === navigationRequest.current && !lifetime.current.signal.aborted) setError(String(cause));
    }
  };
  const forkKeys = React.useRef(new Map<string, string>());
  const fork = (node: ThreadConversationTreeNode) => action(async () => {
    let requestKey = forkKeys.current.get(node.lastItemId);
    if (!requestKey) { requestKey = crypto.randomUUID(); forkKeys.current.set(node.lastItemId, requestKey); }
    const selectedIdentity = { ...identity }, target = { ...identity, branchId: node.branchId };
    await flushUiSessions(target, host);
    if (host !== getRuntimeEndpointGeneration() || lifetime.current.signal.aborted
      || identityRef.current.threadId !== selectedIdentity.threadId || identityRef.current.branchId !== selectedIdentity.branchId) throw new Error(t('ui.content.actionsUnavailable'));
    const result = await api.fork({ ...target, key: requestKey, headId: node.lastItemId });
    forkKeys.current.delete(node.lastItemId);
    if (host !== getRuntimeEndpointGeneration() || lifetime.current.signal.aborted) return;
    await useThreadStore.getState().loadCatalog();
    if (host !== getRuntimeEndpointGeneration() || lifetime.current.signal.aborted) return;
    await openThreadFromNavigation(result);
    refresh();
  });
  const currentRoute = tree?.routes.find(route => route.branchId === identity.branchId);
  const openChild = (child: Pick<ThreadIdentity, 'threadId' | 'branchId'>) => action(async () => {
    await openThreadFromNavigation(child);
    openConversationTree();
  });
  const renderTurn = (node: ThreadConversationTreeNode, depth: number) => <TreeTurn key={node.id} node={node} depth={depth} branchStart={depth > 0 && branchStarts.has(node.id)} api={api} identity={identity} tree={tree!} preview={search ? searchResults[previewKey(node)] : previewCache.current.get(previewKey(node))}
    load={readPreview} active={path.has(node.id)} selected={view.selected === node.id} currentBranch={identity.branchId} busy={busy}
    open={view.expanded[node.id] ?? false} onOpen={open => setView({ expanded: { ...view.expanded, [node.id]: open } })}
    onRoute={branchId => void navigate(node, 'reveal', branchId)} onSelect={() => void navigate(node)}
    onChild={child => void openChild(child)} />;
  return <section className="flex h-full min-h-0 flex-col" aria-label={t('chat.tree.title')}>
    <div className="flex items-center gap-2 border-b border-border/50 px-4 py-3">
      <div className="relative min-w-0 flex-1"><Icon name="search" className="pointer-events-none absolute left-2 top-2.5 size-3.5 text-muted-foreground" />
        <Input className="h-9 pl-7" aria-label={t('chat.tree.search')} placeholder={t('chat.tree.search')} value={query} onChange={event => setQuery(event.target.value)} />
      </div>
      <Button variant="ghost" size="icon" aria-label={t('chat.tree.refresh')} onClick={refresh} disabled={loading}><Icon name="refresh" className={cn('size-4', loading && 'animate-spin')} /></Button>
      <Button variant="ghost" size="sm" onClick={() => {
        if (!currentRoute?.nodeId) return;
        setQuery(''); setView({ selected: currentRoute.nodeId });
        requestAnimationFrame(() => viewport.current?.querySelector(`[data-tree-node="${CSS.escape(currentRoute.nodeId!)}"]`)?.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' }));
      }}>{t('chat.tree.current')}</Button>
    </div>
    {error && <p role="alert" className="break-words px-4 py-2 typography-meta text-destructive">{error}</p>}
    <div ref={viewport} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3 [overflow-anchor:auto]" onScroll={event => { scrollPosition.current = event.currentTarget.scrollTop; }}>
      {!tree && loading && <p role="status" className="py-8 text-center text-muted-foreground">{t('common.loading')}</p>}
      {tree && !tree.nodes.length && <p className="py-8 text-center typography-meta text-muted-foreground">{t('chat.tree.empty')}</p>}
      {search && <p role="status" className="pb-3 typography-meta text-muted-foreground">{searching ? t('chat.tree.searching') : t('chat.tree.matches', { count: visibleRows.length })}</p>}
      {visibleRows.map(row => row.kind === 'gap' ? <Collapsible key={row.id} open={row.expanded}>
        <button type="button" aria-expanded={row.expanded} className="my-1 flex w-full items-center gap-2 rounded py-2 text-left typography-meta text-muted-foreground hover:text-foreground" style={{ paddingLeft: `min(${row.depth * 14 + 8}px, 25%)` }}
          onClick={() => setView({ expanded: { ...view.expanded, [row.id]: !row.expanded } })}><Icon name="arrow-right-s" className={cn('size-4 transition-transform', row.expanded && 'rotate-90')} />{t('chat.tree.middle', { count: row.nodes.length })}</button>
        <CollapsibleContent>{row.nodes.map(node => renderTurn(node, row.depth))}</CollapsibleContent>
      </Collapsible> : renderTurn(row.node, row.depth))}
      {tree?.routes.filter(route => !route.nodeId).map((route, index) => <button key={route.branchId} type="button" onClick={() => void action(async () => { await openThreadFromNavigation({ ...identity, branchId: route.branchId }); })}
        className="flex w-full items-center gap-2 rounded px-2 py-3 typography-meta hover:bg-interactive-hover"><Icon name="git-branch" className="size-4" />{t('thread.sidebar.branch', { number: index + 1 })} · {t('chat.tree.empty')}</button>)}
      {tree?.children.filter(child => !child.nodeId).map(child => <button key={child.threadId} type="button" className="mt-2 flex max-w-full items-center gap-2 rounded px-2 py-1 typography-meta text-muted-foreground hover:bg-interactive-hover"
        onClick={() => void openChild(child)}>
        <AgentAvatar identity={child.threadId} avatar={child.avatar ?? undefined} size={18} /><span className="truncate">{child.name}</span>
      </button>)}
    </div>
    {selectedNode && <div className="flex shrink-0 flex-wrap gap-2 border-t border-border/60 px-4 py-3">
      <Button size="sm" variant="outline" disabled={busy || readOnly} onClick={() => void fork(selectedNode)}><Icon name="git-branch" className="size-3.5" />{t('chat.tree.continue')}</Button>
      <Button size="sm" variant="ghost" disabled={busy || readOnly || Boolean(tree?.routes.find(route => route.branchId === (path.has(selectedNode.id) ? identity.branchId : selectedNode.branchId))?.activeRunId)} onClick={() => void navigate(selectedNode, 'recover')}>
        <Icon name="arrow-go-back" className="size-3.5" />{t('chat.tree.restore')}</Button>
    </div>}
  </section>;
}

function TreeTurn({ node, depth, branchStart, api, identity, tree, preview: suppliedPreview, load, active, selected, currentBranch, busy, open, onOpen, onSelect, onChild, onRoute }: {
  node: ThreadConversationTreeNode; depth: number; branchStart: boolean; api: ThreadsAPI; identity: ThreadIdentity; tree: ThreadConversationTree; preview?: ThreadTreePreview;
  load(node: ThreadConversationTreeNode): Promise<ThreadTreePreview>; active: boolean; selected: boolean; currentBranch: string; busy: boolean;
  open: boolean; onOpen(open: boolean): void; onSelect(): void; onChild(child: { threadId: string; branchId: string }): void;
  onRoute(branchId: string): void;
}) {
  const { t } = useI18n();
  const element = React.useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState<string>();
  const [retry, setRetry] = React.useState(0);
  const [loaded, setLoaded] = React.useState<{ key: string; value: ThreadTreePreview }>();
  const preview = suppliedPreview ?? (loaded?.key === previewKey(node) ? loaded.value : undefined);
  React.useEffect(() => {
    if (preview) return;
    let disposed = false;
    const read = () => void load(node).then(value => {
      if (!disposed) { setLoaded({ key: previewKey(node), value }); setError(undefined); }
    }).catch(cause => { if (!disposed) setError(String(cause)); });
    if (!element.current || typeof IntersectionObserver === 'undefined') { read(); return () => { disposed = true; }; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); read(); }
    }, { rootMargin: '160px' });
    observer.observe(element.current);
    return () => { disposed = true; observer.disconnect(); };
  }, [node, preview, load, retry]);
  const endpoints = tree.routes.filter(route => route.nodeId === node.id);
  const children = tree.children.filter(child => child.nodeId === node.id);
  return <div ref={element} data-tree-node={node.id} className="relative pb-2 [content-visibility:auto] [contain-intrinsic-size:auto_88px]" style={{ marginLeft: `min(${depth * 14}px, 25%)` }}>
    <span aria-hidden className={cn('absolute bottom-0 left-[7px] top-0 w-px transition-colors', active ? 'bg-primary/45' : 'bg-border')} />
    {branchStart && <span aria-hidden className={cn('absolute -left-[7px] top-[15px] h-px w-[14px]', active ? 'bg-primary/45' : 'bg-border')} />}
    <Collapsible open={open} onOpenChange={onOpen}>
      <div className={cn('relative flex min-h-16 items-start gap-2 rounded-lg py-2 pr-2 transition-colors', selected ? 'bg-primary/10' : 'hover:bg-interactive-hover/50')}>
        <span aria-hidden className={cn('relative mt-1.5 ml-1 size-2 shrink-0 rounded-full border bg-background', active ? 'border-primary bg-primary' : 'border-muted-foreground/60')} />
        <button type="button" disabled={busy} aria-current={selected ? 'location' : undefined} onClick={onSelect} className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <span className={cn('line-clamp-2 break-words typography-ui-label leading-relaxed', active ? 'text-foreground' : 'text-muted-foreground')}>
            {preview?.user || preview?.assistant || preview?.activity || t('chat.tree.turn')}
          </span>
          {preview?.user && preview.assistant && <span className="mt-1 line-clamp-2 break-words typography-meta leading-relaxed text-muted-foreground">{preview.assistant}</span>}
        </button>
        <button type="button" aria-label={t('chat.tree.expand')} aria-expanded={open} onClick={() => onOpen(!open)} className="mt-0.5 rounded p-1 text-muted-foreground hover:bg-interactive-hover"><Icon name="arrow-right-s" className={cn('size-3.5 transition-transform', open && 'rotate-90')} /></button>
      </div>
      {endpoints.length > 0 && <div className="mb-2 ml-6 flex flex-wrap gap-1 typography-micro">{endpoints.map(route => <button type="button" key={route.branchId}
        aria-current={route.branchId === currentBranch ? 'page' : undefined} disabled={busy} onClick={() => onRoute(route.branchId)}
        className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-interactive-hover', route.branchId === currentBranch ? 'bg-primary/10 text-primary' : 'text-muted-foreground')}>
        {route.activeRunId && <Icon name="loader-4" className="size-3 animate-spin" />}
        {route.branchId === currentBranch ? t('chat.tree.currentRoute') : route.preserved ? t('chat.tree.preserved') : route.branchId === tree.mainBranchId ? t('thread.sidebar.mainBranch') : t('thread.sidebar.branch', { number: tree.routes.indexOf(route) + 1 })}
      </button>)}</div>}
      <CollapsibleContent><div className="ml-6 border-l border-border/60 py-1 pl-3">
        <button type="button" className="typography-meta text-primary hover:underline" onClick={onSelect}>{t('chat.tree.readTurn')}</button>
        {preview?.activity && !preview.assistant && <p className="mt-1 typography-meta text-muted-foreground">{preview.activity}</p>}
        <TreeTurnDetails key={node.branchId} api={api} identity={{ ...identity, branchId: node.branchId }} node={node} />
      </div></CollapsibleContent>
    </Collapsible>
    {error && <button type="button" className="ml-6 typography-micro text-destructive" title={error} onClick={() => { setError(undefined); setRetry(value => value + 1); }}>{t('chat.tree.retryPreview')}</button>}
    {children.length > 0 && <div className="ml-6 mt-1 flex flex-wrap gap-2">{children.map(child => <button key={child.threadId} type="button" onClick={() => onChild(child)} className="flex max-w-full items-center gap-1.5 rounded px-1 py-1 typography-meta text-muted-foreground hover:bg-interactive-hover hover:text-foreground">
      <AgentAvatar identity={child.threadId} avatar={child.avatar ?? undefined} size={18} /><span className="truncate">{child.name}</span><Icon name="arrow-right-s" className="size-3" />
    </button>)}</div>}
  </div>;
}

function TreeTurnDetails({ api, identity, node }: { api: ThreadsAPI; identity: ThreadIdentity; node: ThreadConversationTreeNode }) {
  const { t } = useI18n();
  const [items, setItems] = React.useState<ThreadHistoryItem[]>([]);
  const [before, setBefore] = React.useState<string>();
  const [cursor, setCursor] = React.useState<string>();
  const [error, setError] = React.useState<string>();
  const [loading, setLoading] = React.useState(true);
  const [retry, setRetry] = React.useState(0);
  const [head, setHead] = React.useState(node.lastItemId);
  React.useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(undefined);
    void api.historyPage({ runtime: 'agent', threadId: identity.threadId, branchId: identity.branchId }, { headId: head, beforeId: cursor }, controller.signal).then(page => {
      if (controller.signal.aborted) return;
      const start = page.items.findIndex(item => item.id === node.firstItemId);
      const pageItems = start < 0 ? page.items : page.items.slice(start);
      setItems(previous => cursor ? [...pageItems, ...previous] : pageItems);
      setBefore(start < 0 ? page.previous ?? undefined : undefined);
    }).catch(cause => { if (!controller.signal.aborted) setError(String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, identity.threadId, identity.branchId, node.firstItemId, head, cursor, retry]);
  return <div className="mt-2 flex h-[min(26rem,55vh)] min-h-48 flex-col overflow-hidden rounded-lg border border-border/50 bg-background/50">
    {head !== node.lastItemId && <button type="button" className="p-2 typography-meta text-primary" onClick={() => { setCursor(undefined); setHead(node.lastItemId); }}>{t('chat.tree.refreshTurn')}</button>}
    {error && <button className="break-words p-2 text-xs text-destructive" onClick={() => setRetry(value => value + 1)}>{error} · {t('chat.tree.retryPreview')}</button>}
    {loading && !items.length ? <p className="p-3 typography-meta text-muted-foreground">{t('common.loading')}</p> : <ConversationTimeline api={api} identity={identity} history={items} historyReady progress={[]} cwd="" working={false} readOnly onQuote={() => {}}
      viewId={`tree:${node.id}`} earlierHistory={{ available: Boolean(before), loading, error, latencyMs: 0, load: async () => { setCursor(before); } }} />}
  </div>;
}
