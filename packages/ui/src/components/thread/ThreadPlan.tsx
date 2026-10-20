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
  summaryView?: { open: boolean; onToggle(): void; onInspect(): void } };
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
  if (summaryView) return hasContent ? <section className="thread-overview-section" aria-label={t('chat.plan.title')}>
    <div className="thread-overview-section-heading"><button type="button" className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left typography-ui-label font-medium" aria-expanded={summaryView.open} onClick={summaryView.onToggle}>
      {t('harness.overview.plan')}<span className="flex items-center gap-2 typography-micro font-normal tabular-nums text-muted-foreground">{summary.total > 0 && `${summary.done} / ${summary.total}`}<Icon name={summaryView.open ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5" /></span>
    </button><button type="button" aria-label={t('harness.overview.planDetails')} className="rounded p-1 text-muted-foreground hover:bg-interactive-hover" onClick={summaryView.onInspect}><Icon name="more" className="size-4" /></button></div>
    {summaryView.open && <div className="space-y-1.5">
      {readError === 'failed' && <button type="button" className="typography-meta text-status-warning" onClick={summaryView.onInspect}>{t('chat.plan.unavailable')}</button>}
      {summary.items.length ? summary.items.map((item, index) => <div key={index} className={`flex items-start gap-2 typography-meta ${item.status === 'completed' ? 'text-muted-foreground' : ''}`}>
        <Icon name={item.status === 'completed' ? 'check' : item.status === 'in_progress' ? 'loader-4' : item.status === 'blocked' ? 'error-warning' : 'record-circle'} className="mt-0.5 size-3.5 shrink-0" /><span>{item.text}</span>
      </div>) : state?.plan && <MarkdownRenderer messageId={`plan:${state.plan.ref}`} content={state.plan.content} />}
    </div>}
  </section> : null;
  return <section aria-label="Conversation plan" className="mx-auto max-w-3xl space-y-2 rounded border p-3 text-sm">
    <div className="font-medium">{t('chat.plan.title')}{summary.total > 0 ? ` · ${summary.done}/${summary.total}` : ''}</div>
    {loading && <p role="status">{t('common.loading')}</p>}
    {readError === 'failed' && <p role="alert">{t('chat.plan.unavailable')} <Button variant="ghost" size="sm" onClick={() => void refresh()}>{t('chat.mcp.refresh')}</Button></p>}
    {readError === 'not-ready' && <p role="status">{t('chat.plan.notReady')}</p>}
    {readError === 'unsupported' && <p role="status">{t('chat.plan.unsupported')}</p>}
    {state && <div aria-label="Current plan">
      {state.plan === null ? <p>{t('chat.plan.empty')}</p> : state.plan.content === '' ? <p>{t('chat.plan.empty')}</p>
        : <MarkdownRenderer messageId={`plan:${state.plan.ref}`} content={state.plan.content} />}
    </div>}
    {saveError && <p role="alert">{saveError}</p>}
    {!readOnly && (editing ? <>
      <Textarea aria-label="Edit conversation plan" value={draft} disabled={saving || readError === 'not-ready' || readError === 'unsupported'} onChange={event => setDraft(event.target.value)} />
      {changed && !conflict && <p role="status">{t('chat.plan.conflict')}</p>}
      {(changed || conflict) && <Button variant="outline" size="sm" disabled={saving || loading || Boolean(readError) || !state} onClick={() => {
        setBasis(state); setConflict(false); setSaveError(''); request.current = null;
      }}>{t('chat.plan.rebase')}</Button>}
      <div className="flex gap-2">
        <Button size="sm" disabled={saving || loading || Boolean(readError) || conflict} onClick={() => void save()}>{t(saving ? 'chat.plan.saving' : 'chat.plan.save')}</Button>
        <Button variant="ghost" size="sm" disabled={saving} onClick={() => { setEditing(false); setDraft(''); setBasis(undefined); setConflict(false); setSaveError(''); request.current = null; }}>{t('chat.plan.cancel')}</Button>
      </div>
    </> : !readError || readError === 'failed' ? <Button variant="outline" size="sm" disabled={!state || loading || Boolean(readError) || saving} onClick={() => {
      setBasis(state); setDraft(state?.plan?.content ?? ''); setEditing(true); setSaveError('');
    }}>{t(state?.plan ? 'chat.plan.edit' : 'chat.plan.create')}</Button> : null)}
  </section>;
}
