import { useI18n } from '@/lib/i18n';
import React from 'react';
import { getRuntimeEndpointGeneration, ThreadRequestError, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import type { ThreadIdentity, ThreadPlanAPI, ThreadPlanState } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { summarizePlan } from '@/lib/planSummary';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { Icon } from '@/components/icon/Icon';
import type { PlanSummary } from '@/lib/planSummary';

type Props = { api: ThreadPlanAPI; identity: ThreadIdentity; contextRevision?: number; onContentChange?(present: boolean): void; readOnly?: boolean;
  onSummaryChange?(summary: PlanSummary): void;
  summaryView?: { onInspect(): void } };
type ReadFailure = 'failed' | 'not-ready' | 'unsupported';
const scopeFailure = (error: unknown): Exclude<ReadFailure, 'failed'> | null => error instanceof ThreadRequestError
  ? error.code === 'plan-not-ready' ? 'not-ready' : error.code === 'plan-unsupported' ? 'unsupported' : null
  : null;

/** A draft belongs to one branch on one Host. Switching either discards it. */
export function ThreadPlan(props: Props) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  return <PlanCard key={JSON.stringify([host, props.identity.threadId, props.identity.branchId])} {...props} host={host} />;
}

function PlanCard({ api, identity, contextRevision, host, onContentChange, onSummaryChange, summaryView, readOnly }: Props & { host: number }) {
  const { t } = useI18n();
  const [state, setState] = React.useState<ThreadPlanState>();
  const [loading, setLoading] = React.useState(true);
  const [readError, setReadError] = React.useState<ReadFailure | null>(null);
  const [saveError, setSaveError] = React.useState('');
  const [conflict, setConflict] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [basis, setBasis] = React.useState<ThreadPlanState>();
  const [saving, setSaving] = React.useState(false);
  const editor = React.useRef<HTMLTextAreaElement>(null);
  const summaryOnly = Boolean(summaryView);
  React.useLayoutEffect(() => {
    const element = editor.current;
    if (!element || !editing || summaryOnly || readOnly
      || typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content')) return;
    // Older browser clients share the same full-height editing surface.
    const fit = () => {
      element.style.height = 'auto';
      element.style.height = `${element.scrollHeight}px`;
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      fit();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [draft, editing, summaryOnly, readOnly]);
  const hasContent = Boolean(state?.plan?.content.trim() || editing || saveError || readError === 'failed');
  React.useEffect(() => { onContentChange?.(hasContent); }, [hasContent, onContentChange]);
  const lifecycle = React.useRef(0);
  const reads = React.useRef(0);
  const request = React.useRef<Parameters<ThreadPlanAPI['update']>[0] | null>(null);
  const refresh = React.useCallback(async () => {
    const generation = lifecycle.current;
    const read = ++reads.current;
    setLoading(true);
    try {
      const next = await api.read({ runtime: 'agent', threadId: identity.threadId, branchId: identity.branchId });
      if (generation !== lifecycle.current || host !== getRuntimeEndpointGeneration() || read !== reads.current) return;
      if (next.identity.threadId !== identity.threadId || next.identity.branchId !== identity.branchId) throw new Error('Wrong plan identity');
      setState(next); setReadError(null);
    } catch (error) {
      if (generation === lifecycle.current && host === getRuntimeEndpointGeneration() && read === reads.current) {
        const scope = scopeFailure(error);
        setReadError(scope ?? 'failed');
        if (scope) setState(undefined);
      }
    } finally {
      if (generation === lifecycle.current && host === getRuntimeEndpointGeneration() && read === reads.current) setLoading(false);
    }
  }, [api, host, identity.threadId, identity.branchId]);
  React.useEffect(() => {
    lifecycle.current += 1;
    setState(undefined); setEditing(false); setDraft(''); setBasis(undefined); setSaving(false);
    setReadError(null); setSaveError(''); setConflict(false); request.current = null;
    void refresh();
    const remove = subscribeVarinEvents(event => {
      if (event.type === 'stream-ready' || (event.type === 'plan-changed'
        && event.threadId === identity.threadId && event.branchId === identity.branchId)) void refresh();
    });
    return () => { lifecycle.current += 1; reads.current += 1; remove(); };
  }, [refresh, identity.threadId, identity.branchId]);

  const previousContext = React.useRef(contextRevision);
  React.useEffect(() => {
    if (previousContext.current === contextRevision) return;
    previousContext.current = contextRevision;
    void refresh();
  }, [contextRevision, refresh]);

  const save = async () => {
    if (!basis || saving || loading || Boolean(readError) || conflict) return;
    const generation = lifecycle.current;
    const intent = { ...identity, expectedHeadId: basis.headId, expectedRef: basis.plan?.ref ?? null, content: draft };
    if (!request.current || JSON.stringify({ ...request.current, key: undefined }) !== JSON.stringify(intent)) {
      request.current = { ...intent, key: crypto.randomUUID() };
    }
    setSaving(true); setSaveError('');
    try {
      const result = await api.update(request.current);
      if (generation !== lifecycle.current || host !== getRuntimeEndpointGeneration()) return;
      if (result.receipt.status === 'conflict') throw new ThreadRequestError(409, 'plan-conflict');
      request.current = null;
      setEditing(false); setBasis(undefined); setDraft(''); setConflict(false);
      // A replay receipt is not necessarily today's revision.
      await refresh();
    } catch (error) {
      if (generation !== lifecycle.current || host !== getRuntimeEndpointGeneration()) return;
      const scope = scopeFailure(error);
      if (scope) {
        reads.current += 1; setLoading(false); setReadError(scope); setState(undefined); request.current = null;
        setSaveError(t('chat.plan.cannotSave'));
      } else if (error instanceof ThreadRequestError && error.status === 409) {
        request.current = null; setConflict(true);
        setSaveError(t('chat.plan.conflict'));
        await refresh();
      } else setSaveError(t('chat.plan.retrySave'));
    } finally { if (generation === lifecycle.current && host === getRuntimeEndpointGeneration()) setSaving(false); }
  };
  const summary = React.useMemo(() => summarizePlan(state?.plan?.content ?? ''), [state?.plan?.content]);
  React.useEffect(() => { onSummaryChange?.(summary); }, [summary, onSummaryChange]);
  const changed = editing && basis && state && (basis.headId !== state.headId || basis.plan?.ref !== state.plan?.ref);
  const cancelEdit = () => {
    setEditing(false); setDraft(''); setBasis(undefined); setConflict(false); setSaveError(''); request.current = null;
  };
  const startEdit = () => {
    setBasis(state); setDraft(state?.plan?.content ?? ''); setEditing(true); setSaveError('');
  };
  const currentPlan = state && <div aria-label="Current plan" className="thread-plan-content min-w-0">
    {!state.plan?.content ? <p>{t('chat.plan.empty')}</p>
      : <MarkdownRenderer messageId={`plan:${state.plan.ref}`} content={state.plan.content} />}
  </div>;
  // The overview is a reading shortcut. Keep the current step and its neighbours
  // in source order; the full plan and editing remain in the dedicated view.
  let focusIndex = summary.items.findIndex(item => item.status === 'in_progress');
  if (focusIndex < 0) focusIndex = summary.items.findIndex(item => item.status === 'blocked');
  if (focusIndex < 0) focusIndex = summary.items.findIndex(item => item.status !== 'completed');
  if (focusIndex < 0) focusIndex = summary.items.length - 1;
  const previewStart = Math.max(0, Math.min(focusIndex, summary.items.length - 3));
  const previewItems = summary.items.slice(previewStart, previewStart + 3);
  const omittedItems = summary.total - previewItems.length;
  if (summaryView) return hasContent ? <section className="thread-overview-section" aria-label={t('chat.plan.title')}>
    <button type="button" className="thread-plan-summary group block w-full min-w-0 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={t('harness.overview.planDetails')} onClick={summaryView.onInspect}>
      <span className="mb-2 flex min-w-0 items-center justify-between gap-2 typography-ui-label font-medium">
        {t('harness.overview.plan')}<span className="flex shrink-0 items-center gap-2 typography-micro font-normal tabular-nums text-muted-foreground">{summary.total > 0 && `${summary.done} / ${summary.total}`}<Icon name="arrow-right-s" className="size-3.5 transition-transform group-hover:translate-x-0.5" /></span>
      </span>
      <span className="block space-y-2">
        {readError === 'failed' && <span className="block typography-meta text-status-warning">{t('chat.plan.unavailable')}</span>}
        {previewItems.length ? previewItems.map((item, index) => <span key={previewStart + index} className={`flex min-w-0 items-start gap-2 typography-meta ${item.status === 'completed' ? 'text-muted-foreground' : ''}`}>
          <Icon name={item.status === 'completed' ? 'check' : item.status === 'in_progress' ? 'loader-4' : item.status === 'blocked' ? 'error-warning' : 'record-circle'} className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 line-clamp-2 [overflow-wrap:anywhere]" title={item.text}>{item.text}</span>
        </span>) : state?.plan && <span className="line-clamp-3 whitespace-pre-wrap typography-meta [overflow-wrap:anywhere]">{state.plan.content}</span>}
      </span>
      <span className="mt-2 block typography-micro text-muted-foreground transition-colors group-hover:text-foreground">
        {omittedItems > 0 && <>{t('harness.overview.planRemaining', { count: omittedItems })} · </>}{t('harness.overview.planDetails')}
      </span>
    </button>
  </section> : null;
  return <section aria-label="Conversation plan" className="thread-plan-detail mx-auto min-w-0 max-w-3xl space-y-3 text-sm">
    <div className="thread-plan-toolbar sticky top-0 z-10 flex min-w-0 flex-wrap items-center justify-between gap-2 py-2">
      <span className="typography-ui-label font-medium">{t('chat.plan.title')}{summary.total > 0 && <span className="ml-2 typography-micro font-normal tabular-nums text-muted-foreground">{summary.done}/{summary.total}</span>}</span>
      {!readOnly && (editing ? <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" disabled={saving} onClick={cancelEdit}>{t('chat.plan.cancel')}</Button>
        <Button size="sm" disabled={saving || loading || Boolean(readError) || conflict} onClick={() => void save()}>{t(saving ? 'chat.plan.saving' : 'chat.plan.save')}</Button>
      </div> : !readError || readError === 'failed' ? <Button variant="ghost" size="sm" disabled={!state || loading || Boolean(readError) || saving} onClick={startEdit}>
        {t(state?.plan ? 'chat.plan.edit' : 'chat.plan.create')}
      </Button> : null)}
    </div>
    {loading && <p role="status">{t('common.loading')}</p>}
    {readError === 'failed' && <p role="alert">{t('chat.plan.unavailable')} <Button variant="ghost" size="sm" onClick={() => void refresh()}>{t('chat.mcp.refresh')}</Button></p>}
    {readError === 'not-ready' && <p role="status">{t('chat.plan.notReady')}</p>}
    {readError === 'unsupported' && <p role="status">{t('chat.plan.unsupported')}</p>}
    {saveError && <p role="alert">{saveError}</p>}
    {editing && !readOnly ? <>
      {changed && !conflict && <p role="status">{t('chat.plan.conflict')}</p>}
      {(changed || conflict) && <div className="space-y-2">
        {state && <details className="min-w-0 rounded-md border border-border/60 p-2">
          <summary className="cursor-pointer typography-meta text-muted-foreground">{t('chat.plan.latest')}</summary>
          <div className="mt-2">{currentPlan}</div>
        </details>}
        <Button variant="outline" size="sm" className="h-auto max-w-full whitespace-normal text-left" disabled={saving || loading || Boolean(readError) || !state} onClick={() => {
          setBasis(state); setConflict(false); setSaveError(''); request.current = null;
        }}>{t('chat.plan.rebase')}</Button>
      </div>}
      <Textarea ref={editor} simple autoFocus rows={12} aria-label="Edit conversation plan" className="thread-plan-editor min-h-72 min-w-0 rounded-md px-1 py-2 leading-relaxed"
        value={draft} disabled={saving || readError === 'not-ready' || readError === 'unsupported'} onChange={event => setDraft(event.target.value)}
        onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void save(); } }} />
    </> : currentPlan}
  </section>;
}
