import React from 'react';
import { getRuntimeEndpointGeneration, type ThreadIdentity, type ThreadSnapshot, type ThreadsAPI } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn, formatDirectoryName } from '@/lib/utils';
import { revealResourceInEditor } from '@/lib/agent-editor/navigation';
import { useUIStore } from '@/stores/useUIStore';
import { contextUsageKey, useThreadContextUsageStore } from '@/stores/useThreadContextUsageStore';
import { useWorkOverviewStore } from '@/stores/useWorkOverviewStore';
import { ChildTasks } from '../conversation/ChildTasks';
import { ChildState } from '../conversation/childPresentation';
import { childEnded, childTaskRows } from '../conversation/childTaskRows';
import { projectFileChanges } from '../conversation/fileChangePreview';
import { ChatFileChangePreview } from '../conversation/ChatFileChangePreview';
import type { PlanSummary } from '@/lib/planSummary';
import { ThreadPlan } from './ThreadPlan';
import { WorkOverviewControl, type OverviewPeekSection } from './WorkOverviewControl';
import { ThreadOperationDetails } from './ThreadOperationDetails';
import { canCancelOperation } from './threadOperations';
import { runFailureMessage } from '@/lib/agent-runtime/runFailure';
import { useThreadProducts, type ThreadProduct } from './useThreadProducts';

type Section = OverviewPeekSection;
type Props = {
  api: ThreadsAPI; identity: ThreadIdentity; sessionKey: string; snapshot?: ThreadSnapshot;
  request?: { section: Section }; details: Partial<Record<Section, React.ReactNode>>;
  pending: boolean; readOnly: boolean; workspacePath?: string; hasComputer: boolean;
  error?: string; recoveryAttention?: string; onAttention(): void;
  refresh(): Promise<void>; act(work: () => Promise<unknown>): Promise<void>;
  openProcess(operationId: string): Promise<unknown>;
};
const titles: Partial<Record<Section, I18nKey>> = {
  plan: 'harness.overview.plan', threads: 'harness.overview.threads', outputs: 'harness.overview.outputs',
  sources: 'harness.overview.workspace', memory: 'harness.overview.memory', context: 'harness.overview.context',
  goals: 'harness.overview.goals', followups: 'harness.overview.followups', recovery: 'harness.overview.recovery',
  research: 'harness.overview.research', computer: 'computer.automation.title', operations: 'harness.overview.operations',
};
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const operationLabel = (operation: ThreadSnapshot['operations'][number]) => {
  const args = record(record(record(operation.intent).call).arguments);
  const title = [args.title, args.command, args.query].find(value => typeof value === 'string' && value.trim());
  return typeof title === 'string' ? title : operation.host_job?.binding.subject.kind === 'mcp'
    ? operation.host_job.binding.subject.endpoint.server : (operation.executor ?? 'operation').replaceAll('_', ' ');
};
const emptyPlan: PlanSummary = { items: [], total: 0, done: 0, blocked: 0 };

/** A compact projection of current work. Detail editors keep their existing API owners. */
export function ThreadOverview({ api, identity, sessionKey, snapshot, request, details, pending, readOnly, workspacePath,
  hasComputer, error, recoveryAttention, onAttention, refresh, act, openProcess }: Props) {
  const { t } = useI18n();
  const open = useWorkOverviewStore(state => state.bySession[sessionKey]?.overview ?? false);
  const compact = useWorkOverviewStore(state => state.bySession[sessionKey]?.compact ?? false);
  const disclosure = useWorkOverviewStore(state => state.setDisclosure);
  const usage = useThreadContextUsageStore(state => state.views[contextUsageKey(identity)]?.usage);
  const [detail, setDetail] = React.useState<Section>();
  const [visited, setVisited] = React.useState<Set<Section>>(() => new Set());
  const [operationId, setOperationId] = React.useState<string>();
  const [childId, setChildId] = React.useState<string>();
  const [product, setProduct] = React.useState<ThreadProduct>();
  const [productError, setProductError] = React.useState<string>();
  const [plan, setPlan] = React.useState(emptyPlan);
  const [hasPlan, setHasPlan] = React.useState(false);
  const run = snapshot?.activeRun ?? snapshot?.thread.branches.find(branch => branch.branch_id === identity.branchId)?.latest_run;
  const rows = React.useMemo(() => childTaskRows(snapshot?.children ?? [], snapshot?.childExecutions ?? [], snapshot?.childActivity), [snapshot?.children, snapshot?.childExecutions, snapshot?.childActivity]);
  const currentChildren = rows.filter(row => snapshot?.childDirectory ? snapshot.childDirectory.members.some(member => member.current && member.threadId === row.child.child_thread_id) : !childEnded(row.state));
  const runningChildren = currentChildren.filter(row => !childEnded(row.state));
  const failedChildren = currentChildren.filter(row => row.state === 'failed' || row.state === 'preparation_failed');
  const hasChildren = Boolean(rows.length || snapshot?.childDirectory?.members.some(member => member.parentThreadId === identity.threadId));
  const products = useThreadProducts(api, identity, snapshot, open || compact);
  const { history: productHistory, loadEarlier } = products;
  const currentFiles = products.products.filter(item => item.kind === 'file' && item.runId === run?.id);
  const uiProducts = products.products.filter(item => item.kind === 'ui');
  const operations = snapshot?.operations ?? [];
  const background = operations.filter(operation => operation.executor !== 'dispatch' && operation.executor !== 'ask_user'
    && (operation.intent as { kind?: string } | null)?.kind !== 'inference_request_v1'
    && operation.id !== snapshot?.launch?.pause?.action_id && !operation.waiting_on?.startsWith('permission:') && canCancelOperation(operation, run?.waiting_on));
  const waiting = operations.find(operation => operation.waiting_on && operation.waiting_on === run?.waiting_on && operation.phase !== 'terminal');
  const question = waiting?.executor === 'ask_user';
  const permission = waiting?.waiting_on?.startsWith('permission:');
  const goal = snapshot?.goals.find(value => value.control !== 'complete' && value.control !== 'cancelled');
  const followups = snapshot?.followups.filter(value => value.actor.kind !== 'goal' && value.state !== 'cancelled' && !value.exhausted) ?? [];
  const attention = Boolean(question || permission || run?.state === 'failed' || failedChildren.length || recoveryAttention || error);
  const statusKey: I18nKey = question ? 'harness.overview.awaitAnswer' : permission ? 'harness.overview.awaitPermission'
    : run?.state === 'failed' ? 'harness.threads.state.failed' : failedChildren.length || error || recoveryAttention ? 'harness.overview.needsAttention'
      : run?.state === 'completed' ? 'harness.overview.completed' : run?.state === 'cancelled' ? 'harness.threads.state.cancelled'
        : run?.state === 'waiting' ? 'harness.threads.state.waiting' : run ? 'harness.overview.working' : 'harness.overview.ready';
  const statusDetail = error || recoveryAttention || (run?.state === 'failed' && snapshot?.runFailure?.runId === run.id ? runFailureMessage(snapshot.runFailure, t) : undefined)
    || (failedChildren.length ? failedChildren.map(row => row.child.name || row.child.input.name || row.task).join(' · ')
      : plan.items.find(item => item.status === 'in_progress')?.text || goal?.objective);
  const show = React.useCallback((section: Section) => {
    setDetail(section); setProduct(undefined); setOperationId(undefined); if (section === 'threads') setChildId(undefined); setProductError(undefined);
    setVisited(previous => previous.has(section) ? previous : new Set([...previous, section]));
    disclosure(sessionKey, 'overview', true);
  }, [disclosure, sessionKey]);
  React.useEffect(() => { if (request) show(request.section); }, [request, show]);
  const inspectOperation = (id: string) => { show('operations'); setOperationId(id); };
  const inspectProduct = (value: ThreadProduct) => {
    if (value.kind === 'ui') {
      const key = `${sessionKey}:${value.call.id}`;
      useUIStore.getState().openContextPanelTab(workspacePath ?? '', { mode: 'ui', targetPath: key, thread: identity, contentRef: value.receipt.ref, label: value.receipt.title, dedupeKey: key });
    } else { show('outputs'); setProduct(value); }
  };
  const currentScope = React.useRef(true);
  React.useEffect(() => { currentScope.current = true; return () => { currentScope.current = false; }; }, []);
  const openFile = async (value: Extract<ThreadProduct, { kind: 'file' }>) => {
    const host = getRuntimeEndpointGeneration(); setProductError(undefined);
    try {
      const target = await api.fileTarget({ ...identity, itemId: value.itemId, path: value.path });
      if (!currentScope.current || host !== getRuntimeEndpointGeneration()) return;
      if (target.kind === 'unavailable') throw new Error(t(`chat.files.${target.reason}`));
      revealResourceInEditor({ workspaceId: target.workspaceId, workspaceRoot: target.root, resourceId: target.resourceId, thread: identity, toolCallId: value.call.id });
    } catch (failure) { if (currentScope.current && host === getRuntimeEndpointGeneration()) setProductError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const status = <div className="mb-4 space-y-2">
    <div className="flex items-center gap-2 typography-ui-label font-medium"><span className={cn('size-1.5 shrink-0 rounded-full', attention ? 'bg-status-warning' : run?.state === 'completed' ? 'bg-status-success' : 'bg-primary')} />{t(statusKey)}</div>
    {statusDetail && <p className={cn('min-w-0 pl-3.5 typography-meta text-muted-foreground [overflow-wrap:anywhere]', !attention && 'line-clamp-2')} title={statusDetail}>{statusDetail}</p>}
    {(question || permission) && <button type="button" className="thread-overview-action typography-meta text-primary" onClick={onAttention}>{t('harness.overview.handleRequest')}<Icon name="external-link" className="size-3.5" /></button>}
    {failedChildren.length > 0 && <button type="button" className="thread-overview-action typography-meta" onClick={() => show('threads')}>{t('harness.overview.inspectTasks')}<Icon name="arrow-right-s" className="size-3.5" /></button>}
    {recoveryAttention && <button type="button" className="thread-overview-action typography-meta" onClick={() => show('recovery')}>{t('harness.overview.recovery')}<Icon name="arrow-right-s" className="size-3.5" /></button>}
  </div>;
  const action = (section: Section, icon: IconName, label: string, value?: React.ReactNode) => <button type="button" className="thread-overview-action typography-meta" onClick={() => show(section)}><Icon name={icon} className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{label}</span>{value}<Icon name="arrow-right-s" className="size-3.5 shrink-0 text-muted-foreground" /></button>;
  const outputSummary = <>
    {currentFiles.length > 0 && action('outputs', 'file-code', t('harness.overview.currentFiles', { count: currentFiles.length }))}
    {uiProducts.map(value => <button key={value.key} type="button" className="thread-overview-action typography-meta" onClick={() => inspectProduct(value)}><Icon name="window" className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{value.receipt.title}</span><Icon name="external-link" className="size-3.5 shrink-0 text-muted-foreground" /></button>)}
    {(products.products.some(value => value.kind === 'file' && value.runId !== run?.id) || products.history.previous) && action('outputs', 'history', t('harness.overview.earlierProducts'))}
    {products.history.error && <button type="button" className="thread-overview-action typography-meta text-status-warning" onClick={() => void products.loadEarlier(true)}>{t('chat.context.retry')}</button>}
  </>;
  const menuSections: Section[] = ['plan', 'goals', ...(api.collaboration || snapshot?.delegatedExecutions?.length ? ['threads' as const] : []), 'sources', 'context', 'memory', 'followups', 'recovery', ...(api.research ? ['research' as const] : []), ...(hasComputer ? ['computer' as const] : []), 'operations'];
  const more = <DropdownMenu><DropdownMenuTrigger asChild><button type="button" aria-label={t('harness.overview.more')} className="rounded-md p-1.5 text-muted-foreground hover:bg-interactive-hover"><Icon name="more" className="size-4" /></button></DropdownMenuTrigger><DropdownMenuContent align="end">{menuSections.filter(section => section === 'plan' ? Boolean(api.plan) : section === 'operations' || Boolean(details[section])).map(section => <DropdownMenuItem key={section} onSelect={() => show(section)}>{t(titles[section]!)}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>;
  const selectedOperation = operations.find(operation => operation.id === operationId);
  const back = () => { if (product || operationId) { setProduct(undefined); setOperationId(undefined); } else { setDetail(undefined); setChildId(undefined); } };
  const childTasks = snapshot && <ChildTasks api={api} identity={identity} children={snapshot.children ?? []} executions={snapshot.childExecutions ?? []} activity={snapshot.childActivity} directory={snapshot.childDirectory} pending={pending} readOnly={readOnly} onChanged={refresh} selectedId={childId}
    onSelect={id => { setChildId(id); setDetail(id ? 'threads' : undefined); disclosure(sessionKey, 'overview', true); }}
    cancel={!readOnly && api.collaboration ? operation => act(() => api.collaboration!.cancelChild(identity, operation)) : undefined} />;
  const sentinel = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open || detail !== 'outputs' || product || !productHistory.previous || productHistory.loading || productHistory.error || !sentinel.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void loadEarlier(); }, { root: sentinel.current.closest('.thread-work-overview'), rootMargin: '200px' });
    observer.observe(sentinel.current); return () => observer.disconnect();
  }, [open, detail, product, productHistory, loadEarlier]);
  return <WorkOverviewControl open={open} compactOpen={compact} attention={attention} rows={[]} onSelect={show} status={status}
    onOpenChange={value => { disclosure(sessionKey, 'overview', value); if (value) { setDetail(undefined); setChildId(undefined); } }} onCompactChange={value => disclosure(sessionKey, 'compact', value)}
    detailTitle={detail ? t(titles[detail] ?? 'harness.overview.title') : undefined} onBack={back} headerActions={more}
    compactContent={<>{hasPlan && action('plan', 'task', plan.items.find(item => item.status === 'in_progress')?.text ?? t('harness.overview.plan'), plan.total ? <span className="shrink-0 typography-micro text-muted-foreground">{plan.done}/{plan.total}</span> : undefined)}
      {runningChildren.map(row => <button type="button" key={row.child.operation_id} className="thread-overview-action typography-meta" onClick={() => show('threads')}><AgentAvatar identity={row.child.child_thread_id} avatar={row.child.avatar} size={22} /><span className="min-w-0 flex-1 truncate">{row.child.name || row.child.input.name || row.task}</span><ChildState state={row.state} /></button>)}{outputSummary}</>}>
    <div hidden={Boolean(detail)}>{status}</div>
    <div hidden={Boolean(detail && detail !== 'plan')}>{api.plan && <ThreadPlan api={api.plan} identity={identity} readOnly={readOnly} contextRevision={snapshot?.context.checkpoint?.revision} onContentChange={setHasPlan} onSummaryChange={setPlan}
      summaryView={detail === 'plan' ? undefined : { onInspect: () => show('plan') }} />}</div>
    {!detail && goal && <div className="thread-overview-section">{action('goals', 'target', goal.objective, <ChildState state={goal.state} />)}</div>}
    <section hidden={Boolean(detail && detail !== 'threads')} className="thread-overview-section">
      {(hasChildren || detail === 'threads') && <>{!detail && <div className="thread-overview-section-heading typography-ui-label font-medium"><span>{t('harness.overview.threads')}</span>{runningChildren.length > 0 && <span className="typography-micro font-normal text-muted-foreground">{t('harness.overview.activeTasks', { count: runningChildren.length })}</span>}</div>}{childTasks}</>}
      {detail === 'threads' && details.threads}
    </section>
    <div hidden={Boolean(detail)}>
      {(products.products.length > 0 || products.history.previous) && <section className="thread-overview-section"><div className="thread-overview-section-heading typography-ui-label font-medium">{t('harness.overview.outputs')}</div>{outputSummary}</section>}
      {(background.length > 0 || followups.length > 0 || hasComputer) && <section className="mt-5 border-t border-border/50 pt-3">
        {background.map(operation => <button key={operation.id} data-operation-id={operation.id} type="button" className="thread-overview-action typography-meta" onClick={() => inspectOperation(operation.id)}><Icon name="terminal-box" className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{operationLabel(operation)}</span><ChildState state={operation.phase} /></button>)}
        {followups.length > 0 && action('followups', 'timer', t('harness.overview.followups'), <span className="text-muted-foreground">{followups.length}</span>)}
        {hasComputer && action('computer', 'computer', t('computer.automation.title'))}
      </section>}
      <footer className="mt-6 flex flex-wrap gap-x-3 gap-y-2 border-t border-border/50 pt-3 typography-micro text-muted-foreground">
        <button type="button" onClick={() => show('sources')} className="flex min-w-0 items-center gap-1 rounded hover:text-foreground"><Icon name="folder" className="size-3.5" /><span className="truncate">{workspacePath ? formatDirectoryName(workspacePath) : t('harness.overview.chatOnly')}</span></button>
        <button type="button" onClick={() => show('context')} className="flex items-center gap-1 rounded hover:text-foreground"><Icon name="donut-chart-fill" className="size-3.5" />{t('harness.overview.context')}{usage ? ` · ${Math.round(usage.percentage)}%` : ''}</button>
        {details.memory && <button type="button" onClick={() => show('memory')} className="flex items-center gap-1 rounded hover:text-foreground"><Icon name="book-open" className="size-3.5" />{t('harness.overview.memory')}</button>}
      </footer>
    </div>
    {detail === 'outputs' && <div className="thread-overview-detail">
      {productError && <p role="alert" className="mb-3 typography-meta text-destructive">{productError}</p>}
      {product?.kind === 'file' ? <>
        <p className="mb-3 break-all typography-meta">{product.path}</p>
        {!product.deleted && <button type="button" className="thread-overview-action typography-meta" onClick={() => void openFile(product)}><Icon name="file-code" className="size-4" />{t('harness.overview.openFile')}</button>}
        {projectFileChanges(product.call).filter(file => file.path === product.path).map(file => <ChatFileChangePreview key={file.path} previewId={product.key} file={file} phase={product.phase} onOpen={product.deleted ? undefined : () => void openFile(product)} />)}
      </> : <>
        {products.products.map(value => <button key={value.key} type="button" className="thread-overview-action typography-meta" onClick={() => inspectProduct(value)}><Icon name={value.kind === 'ui' ? 'window' : 'file-code'} className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 break-words">{value.kind === 'ui' ? value.receipt.title : value.path}</span>{value.kind === 'file' && <span className="shrink-0 typography-micro text-muted-foreground">{t(value.deleted ? 'harness.overview.deleted' : value.phase === 'draft' ? 'harness.overview.draft' : value.phase === 'branch' ? 'harness.overview.branchChange' : 'harness.overview.changed')}</span>}</button>)}
        {!products.products.length && !products.history.loading && !products.history.previous && <p className="typography-meta text-muted-foreground">{t('harness.overview.noProducts')}</p>}
        {products.history.error && <button type="button" className="thread-overview-action typography-meta text-status-warning" onClick={() => void products.loadEarlier(true)}>{t('chat.context.retry')}</button>}<div ref={sentinel} className="h-px" />
      </>}
    </div>}
    {detail === 'operations' && <div className="thread-overview-detail">{selectedOperation ? <><div className="mb-3 flex items-center justify-between gap-3 typography-meta"><span className="break-words">{operationLabel(selectedOperation)}</span><ChildState state={selectedOperation.phase === 'terminal' ? selectedOperation.outcome === 'succeeded' ? 'completed' : selectedOperation.outcome ?? 'unknown' : selectedOperation.phase} /></div><ThreadOperationDetails api={api} identity={identity} operation={selectedOperation} readOnly={readOnly} pending={pending} waitingOn={run?.waiting_on} onCancel={() => void act(() => api.cancelOperation(selectedOperation.id))} onOpenTerminal={() => void act(() => openProcess(selectedOperation.id))} /></>
      : operations.map(operation => <button type="button" data-operation-id={operation.id} key={operation.id} className="thread-overview-action typography-meta" onClick={() => setOperationId(operation.id)}><span className="min-w-0 flex-1 truncate">{operationLabel(operation)}</span><ChildState state={operation.phase === 'terminal' ? operation.outcome === 'succeeded' ? 'completed' : operation.outcome ?? 'unknown' : operation.phase} /></button>)}</div>}
    {[...visited].filter(section => section !== 'plan' && section !== 'outputs' && section !== 'threads' && section !== 'operations').map(section => <div key={section} hidden={detail !== section} className="thread-overview-detail">
      {section === 'context' && <div className="mb-5 space-y-2">
        {usage && <><div className="flex justify-between gap-3 typography-meta"><span>{t('harness.overview.context')}</span><span className="tabular-nums text-muted-foreground">{usage.totalTokens.toLocaleString()} / {usage.contextLimit.toLocaleString()}</span></div><div className="h-1 overflow-hidden rounded bg-muted"><div className="h-full rounded bg-primary" style={{ width: `${Math.min(100, Math.max(0, usage.percentage))}%` }} /></div></>}
        <button type="button" className="thread-overview-action typography-meta" onClick={() => useUIStore.getState().openContextPanelTab(workspacePath ?? '', { mode: 'context', thread: identity })}>{t('harness.overview.contextDetails')}<Icon name="external-link" className="size-3.5" /></button>
      </div>}
      {section === 'sources' && <p className="mb-3 break-all typography-meta">{workspacePath ?? t('harness.overview.chatOnly')}</p>}
      {details[section]}
    </div>)}
  </WorkOverviewControl>;
}
