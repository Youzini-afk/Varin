import React from 'react';
import { getRuntimeEndpointGeneration, ThreadRequestError, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import type { ThreadIdentity, ThreadPlanAPI, ThreadPlanState } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { parseOverviewPlan } from '@/components/pi-session/harnessWorkOverviewPresentation';
import { subscribeVarinEvents } from '@/lib/varinEvents';

type Props = { api: ThreadPlanAPI; identity: ThreadIdentity; contextRevision?: number };
type ReadFailure = 'failed' | 'not-ready' | 'unsupported';
const scopeFailure = (error: unknown): Exclude<ReadFailure, 'failed'> | null => error instanceof ThreadRequestError
  ? error.code === 'plan-not-ready' ? 'not-ready' : error.code === 'plan-unsupported' ? 'unsupported' : null
  : null;

/** A draft belongs to one branch on one Host. Switching either discards it. */
export function ThreadPlan({ api, identity, contextRevision }: Props) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  return <PlanCard key={JSON.stringify([host, identity.threadId, identity.branchId])} api={api} identity={identity} contextRevision={contextRevision} host={host} />;
}

function PlanCard({ api, identity, contextRevision, host }: Props & { host: number }) {
  const [state, setState] = React.useState<ThreadPlanState>();
  const [loading, setLoading] = React.useState(true);
  const [readError, setReadError] = React.useState<ReadFailure | null>(null);
  const [saveError, setSaveError] = React.useState('');
  const [conflict, setConflict] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [basis, setBasis] = React.useState<ThreadPlanState>();
  const [saving, setSaving] = React.useState(false);
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
        setSaveError('This conversation cannot save a plan right now. Your draft is kept.');
      } else if (error instanceof ThreadRequestError && error.status === 409) {
        request.current = null; setConflict(true);
        setSaveError('The plan or conversation changed. Your draft is kept. Review the current plan before saving again.');
        await refresh();
      } else setSaveError('Could not confirm the save. Your draft is kept; retry uses the same request.');
    } finally { if (generation === lifecycle.current && host === getRuntimeEndpointGeneration()) setSaving(false); }
  };
  const summary = parseOverviewPlan(state?.plan?.content ?? '');
  const changed = editing && basis && state && (basis.headId !== state.headId || basis.plan?.ref !== state.plan?.ref);
  return <section aria-label="Conversation plan" className="mx-auto max-w-3xl space-y-2 rounded border p-3 text-sm">
    <div className="font-medium">Conversation plan{summary.total > 0 ? ` · ${summary.done}/${summary.total} completed` : ''}</div>
    {loading && <p role="status">Loading plan…</p>}
    {readError === 'failed' && <p role="alert">Could not read the current plan. <Button variant="ghost" size="sm" onClick={() => void refresh()}>Retry reading plan</Button></p>}
    {readError === 'not-ready' && <p role="status">The plan is not ready yet. Send the first message and wait for conversation setup; plan availability will refresh automatically.</p>}
    {readError === 'unsupported' && <p role="status">Conversation plans are unavailable for Bot or child conversations.</p>}
    {state && <div aria-label="Current plan">
      {state.plan === null ? <p>No plan yet.</p> : state.plan.content === '' ? <p>The plan is empty.</p>
        : <MarkdownRenderer messageId={`plan:${state.plan.ref}`} content={state.plan.content} />}
    </div>}
    {saveError && <p role="alert">{saveError}</p>}
    {editing ? <>
      <Textarea aria-label="Edit conversation plan" value={draft} disabled={saving || readError === 'not-ready' || readError === 'unsupported'} onChange={event => setDraft(event.target.value)} />
      <p className="text-xs text-muted-foreground">Switching conversation, branch, or Host discards this unsaved draft.</p>
      {changed && !conflict && <p role="status">The current plan or conversation changed while you were editing. Your draft is unchanged.</p>}
      {(changed || conflict) && <Button variant="outline" size="sm" disabled={saving || loading || Boolean(readError) || !state} onClick={() => {
        setBasis(state); setConflict(false); setSaveError(''); request.current = null;
      }}>Keep draft against current revision</Button>}
      <div className="flex gap-2">
        <Button size="sm" disabled={saving || loading || Boolean(readError) || conflict} onClick={() => void save()}>{saving ? 'Saving plan…' : 'Save plan'}</Button>
        <Button variant="ghost" size="sm" disabled={saving} onClick={() => { setEditing(false); setDraft(''); setBasis(undefined); setConflict(false); setSaveError(''); request.current = null; }}>Cancel edit</Button>
      </div>
    </> : !readError || readError === 'failed' ? <Button variant="outline" size="sm" disabled={!state || loading || Boolean(readError) || saving} onClick={() => {
      setBasis(state); setDraft(state?.plan?.content ?? ''); setEditing(true); setSaveError('');
    }}>{state?.plan ? 'Edit plan' : 'Create plan'}</Button> : null}
  </section>;
}
