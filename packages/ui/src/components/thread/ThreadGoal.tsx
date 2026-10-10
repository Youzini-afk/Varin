import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, ThreadRequestError } from '@varin/application-client';
import type { ThreadGoalsAPI, ThreadIdentity } from '@varin/application-client';
import type { Goal, GoalBudget, GoalControlAction, GoalMeasuredUsage, GoalTokenAmount } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';

type Props = { api: ThreadGoalsAPI; identity: ThreadIdentity; goals: Goal[]; sourceRunId?: string; refresh(): Promise<void> };
type Draft = { objective: string; budget: string };
type Review = { message: string; current?: Goal; reading?: boolean };
const ended = (goal: Goal) => goal.control === 'complete' || goal.control === 'cancelled';
const status: Record<Goal['state'], string> = { active: 'Active', paused: 'Paused', blocked: 'Blocked', budget_limited: 'Budget limited', complete: 'Complete', cancelled: 'Cancelled' };
const blockReason: Record<NonNullable<Goal['blocked_reason']>, string> = {
  reported: 'Agent reported a blocker', dependency: 'Waiting for a dependency', run_failed: 'The run failed',
  waiting: 'Waiting for an answer, permission, or operation', unsettled: 'Waiting for original work to settle',
  context_changed: 'Conversation context changed', preparation_failed: 'Continuation preparation failed',
  usage_unknown: 'Actual output usage is incomplete. Further inference is blocked while a budget is set; remove the budget explicitly to continue.',
};
const draftFor = (goal: Goal): Draft => ({ objective: goal.objective, budget: goal.budget === null ? '' : String(goal.budget.maxOutputTokens) });
function budgetFor(value: string): GoalBudget | null {
  if (value.trim() === '') return null;
  const amount = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(amount)) throw new Error('Enter a non-negative whole output-token count that can be represented exactly, or leave the budget empty.');
  return { maxOutputTokens: amount };
}
const valid = (draft: Draft) => { try { budgetFor(draft.budget); return draft.objective.trim().length > 0; } catch { return false; } };
const count = (value: number) => value.toLocaleString();
const amount = (value: GoalTokenAmount) => `${count(value.known)} known tokens · ${count(value.unknown_receipts)} unknown receipts`;

/** Only edit drafts live here. The Thread snapshot remains the Goal authority. */
export function ThreadGoal(props: Props) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  return <GoalPanel key={JSON.stringify([host, props.identity.threadId, props.identity.branchId])} {...props} host={host} />;
}

function useCurrentScope(host: number) {
  const live = React.useRef(false);
  React.useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  return () => live.current && host === getRuntimeEndpointGeneration();
}

function DraftFields({ draft, change, disabled, prefix }: { draft: Draft; change(value: Draft): void; disabled: boolean; prefix: string }) {
  let budgetError = '';
  try { budgetFor(draft.budget); } catch (error) { budgetError = (error as Error).message; }
  return <div className="space-y-2">
    <label className="block">Objective
      <Textarea aria-label={`${prefix} objective`} value={draft.objective} disabled={disabled} onChange={event => change({ ...draft, objective: event.target.value })} />
    </label>
    <label className="block text-xs">Optional output-token budget
      <input aria-label={`${prefix} output-token budget`} inputMode="numeric" className="ml-2 rounded border bg-background px-2 py-1" value={draft.budget}
        disabled={disabled} onInput={event => change({ ...draft, budget: event.currentTarget.value })} />
    </label>
    {budgetError && <p role="alert">{budgetError}</p>}
    <p className="text-xs text-muted-foreground">Empty means no output-token limit. Zero allows no further output dispatch. Unsaved drafts are discarded on reload or when switching conversation, branch, or Host.</p>
  </div>;
}

function GoalPanel({ api, identity, goals, sourceRunId, refresh, host }: Props & { host: number }) {
  const current = useCurrentScope(host);
  const [creating, setCreating] = React.useState(false);
  const [draft, setDraft] = React.useState<Draft>({ objective: '', budget: '' });
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState('');
  const [refreshError, setRefreshError] = React.useState('');
  const [uncertain, setUncertain] = React.useState(false);
  const [awaitingView, setAwaitingView] = React.useState(false);
  const request = React.useRef<Parameters<ThreadGoalsAPI['start']>[0] | null>(null);
  const inFlight = React.useRef(false);
  const unfinished = goals.some(goal => !ended(goal));
  const refreshView = async () => {
    setRefreshError('');
    try { await refresh(); }
    catch { if (current()) setRefreshError('The current goal view could not be refreshed. Refresh again to read its state.'); }
  };
  React.useEffect(() => {
    if (request.current && goals.some(goal => goal.id === request.current?.key)) {
      request.current = null; setUncertain(false); setAwaitingView(false); setCreating(false); setDraft({ objective: '', budget: '' }); setError('');
    }
  }, [goals]);
  const start = async () => {
    if (inFlight.current || awaitingView || (!request.current && (!sourceRunId || unfinished || !valid(draft)))) return;
    const intent = request.current ?? { ...identity, key: crypto.randomUUID(), runId: sourceRunId!, objective: draft.objective, budget: budgetFor(draft.budget) };
    request.current = intent; inFlight.current = true; setPending(true); setError('');
    try {
      await api.start(intent);
      if (!current() || request.current !== intent) return;
      setUncertain(false); setAwaitingView(true);
      await refreshView();
    } catch (failure) {
      if (!current() || request.current !== intent) return;
      if (failure instanceof ThreadRequestError && failure.status >= 400 && failure.status < 500 && failure.status !== 408) {
        request.current = null; setUncertain(false);
        setError(`Goal was not started: ${failure.code}. Your draft is kept. Review the current work before trying again.`);
      } else {
        setUncertain(true);
        setError('Could not confirm goal creation. The original objective, budget, run, and request key are kept. Retry sends that same request.');
      }
      await refreshView();
    } finally { if (current()) { inFlight.current = false; setPending(false); } }
  };
  return <section aria-label="Continuing goals" className="mx-auto max-w-3xl space-y-3 rounded border p-3 text-sm">
    <div className="font-medium">Continuing goals</div>
    {goals.map(goal => <GoalCard key={goal.id} goal={goal} api={api} identity={identity} refresh={refresh} host={host} />)}
    {!goals.length && <p className="text-xs text-muted-foreground">No continuing goal. Sending a message does not create one.</p>}
    {error && <p role="alert">{error}</p>}
    {refreshError && <p role="alert">{refreshError}</p>}
    {creating ? <div className="space-y-2">
      <DraftFields draft={draft} change={setDraft} disabled={pending || uncertain || awaitingView} prefix="New goal" />
      {awaitingView && <p role="status">Goal creation was accepted. Waiting for its current state; refresh before starting other work.</p>}
      {!sourceRunId && <p role="status">Send a message first to create work this goal can continue. Your goal draft stays here.</p>}
      {unfinished && !uncertain && <p role="status">Complete or cancel the current goal before starting another.</p>}
      <p className="text-xs text-muted-foreground">Continues the latest run, including a finished run, until explicitly completed, paused, blocked, or budget limited.</p>
      <div className="flex flex-wrap gap-2">
        {awaitingView ? <Button size="sm" disabled={pending} onClick={() => void refreshView()}>Refresh current goals</Button> : <Button size="sm" disabled={pending || (!uncertain && (!sourceRunId || unfinished || !valid(draft)))} onClick={() => void start()}>{pending ? 'Starting goal…' : uncertain ? 'Retry starting same goal' : 'Start goal'}</Button>}
        <Button variant="ghost" size="sm" disabled={pending || uncertain || awaitingView} onClick={() => { setCreating(false); setDraft({ objective: '', budget: '' }); setError(''); }}>Discard new goal draft</Button>
      </div>
    </div> : <Button variant="outline" size="sm" disabled={unfinished || pending} onClick={() => { setCreating(true); setError(''); }}>Create goal</Button>}
  </section>;
}

function GoalCard({ goal, api, identity, refresh, host }: { goal: Goal; api: ThreadGoalsAPI; identity: ThreadIdentity; refresh(): Promise<void>; host: number }) {
  const current = useCurrentScope(host);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [basis, setBasis] = React.useState<number | null>(null);
  const [pending, setPending] = React.useState(false);
  const [review, setReview] = React.useState<Review | null>(null);
  const [controlIntent, setControlIntent] = React.useState<Parameters<ThreadGoalsAPI['control']>[0] | null>(null);
  const inFlight = React.useRef(false);
  const reads = React.useRef(0);
  const terminal = ended(goal);
  const readCurrent = async (message: string) => {
    const read = ++reads.current;
    setReview({ message, reading: true });
    try {
      const values = await api.list(identity);
      if (!current() || read !== reads.current) return;
      const latest = values.find(value => value.id === goal.id && value.thread_id === identity.threadId && value.branch_id === identity.branchId);
      setReview({ message: latest ? message : `${message} This goal was not found in the current view.`, current: latest });
      try { await refresh(); }
      catch {
        if (current() && read === reads.current) setReview(previous => previous && {
          ...previous, message: `${previous.message} The conversation view could not be refreshed; the Goal read above remains available.`,
        });
      }
    } catch {
      if (current() && read === reads.current) setReview({ message: `${message} Could not read the current goal. Check again before choosing a new revision.` });
    }
  };
  const mutate = async (action?: GoalControlAction, reviewed?: Goal) => {
    if (inFlight.current || terminal || (!action && (!draft || basis === null || !valid(draft) || review))) return;
    const control = action ? { ...identity, goalId: goal.id, expectedRevision: reviewed?.revision ?? goal.revision, action } : null;
    inFlight.current = true; setPending(true); setReview(null);
    if (control) setControlIntent(control);
    try {
      if (control) await api.control(control);
      else await api.update({ ...identity, goalId: goal.id, expectedRevision: basis!, objective: draft!.objective, budget: budgetFor(draft!.budget) });
      if (!current()) return;
      setControlIntent(null);
      if (!control) { setDraft(null); setBasis(null); }
      // Receipts contain admission facts, not a current Goal or current usage.
      try { await refresh(); }
      catch { if (current()) await readCurrent('The Goal change was accepted, but its current conversation view could not be refreshed.'); }
    } catch (failure) {
      if (!current()) return;
      const conflict = failure instanceof ThreadRequestError && failure.status === 409;
      await readCurrent(conflict
        ? 'The goal changed. Your draft and original revision are kept. Review the current goal before applying another change.'
        : 'Could not confirm the change. Your draft and original revision are kept. Read the current goal before deciding whether to apply it again.');
    } finally { if (current()) { inFlight.current = false; setPending(false); } }
  };
  const content = <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{status[goal.state]}</span><span className="text-xs text-muted-foreground">Revision {goal.revision}</span></div>
    <div aria-label="Current goal objective"><MarkdownRenderer messageId={`goal:${goal.id}:${goal.revision}`} content={goal.objective} /></div>
    {!terminal && goal.blocked_reason && <p role="status">{blockReason[goal.blocked_reason]}</p>}
    {goal.reason && <p className="whitespace-pre-wrap">{goal.reason}</p>}
    {goal.dependency_operation_id && <p className="break-all text-xs text-muted-foreground">Dependency operation: {goal.dependency_operation_id}</p>}
    <GoalUsage goal={goal} />
    {goal.state === 'budget_limited' && <p role="status">Increase or remove the output budget to allow further dispatch. Resume keeps the current budget and any unresolved waits.</p>}
    {review && <div className="space-y-2" role="alert">
      <p>{review.message}</p>
      {review.reading ? <p>Reading current goal…</p> : <Button variant="ghost" size="sm" disabled={pending} onClick={() => void readCurrent('Review the current goal before applying another change.')}>Read current goal again</Button>}
      {review.current && <div className="space-y-2">
        <p>Latest read: revision {review.current.revision} · {status[review.current.state]}</p>
        <p className="whitespace-pre-wrap">{review.current.objective}</p>
        <p>Output budget: {review.current.budget === null ? 'No limit' : count(review.current.budget.maxOutputTokens)}</p>
        {draft && !ended(review.current) && <Button variant="outline" size="sm" disabled={pending || terminal} onClick={() => { setBasis(review.current!.revision); setReview(null); setControlIntent(null); }}>Keep draft against current revision</Button>}
        {controlIntent && !ended(review.current) && <Button variant="outline" size="sm" disabled={pending || terminal} onClick={() => void mutate(controlIntent.action, review.current)}>Apply {controlIntent.action} at revision {review.current.revision}</Button>}
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => { setReview(null); setControlIntent(null); }}>Dismiss review</Button>
      </div>}
    </div>}
    {draft && <div className="space-y-2">
      <DraftFields draft={draft} change={setDraft} disabled={pending} prefix="Edit goal" />
      <p className="text-xs text-muted-foreground">Editing revision {basis}. {basis !== goal.revision ? 'The current goal changed; your draft and editing revision are unchanged.' : ''}</p>
      {terminal && <p role="status">This goal has ended. The unsaved draft is kept for review; create a new goal to authorize more work.</p>}
      {!review && basis !== goal.revision && !terminal && <Button variant="outline" size="sm" disabled={pending} onClick={() => setBasis(goal.revision)}>Keep draft against current revision</Button>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={pending || terminal || Boolean(review) || !valid(draft)} onClick={() => void mutate()}>{pending ? 'Applying goal change…' : 'Save goal'}</Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => { setDraft(null); setBasis(null); }}>Discard goal edits</Button>
      </div>
    </div>}
    {!terminal && <div className="flex flex-wrap gap-2">
      {!draft && <Button variant="outline" size="sm" disabled={pending} onClick={() => { setDraft(draftFor(goal)); setBasis(goal.revision); }}>Edit goal</Button>}
      {goal.control === 'active' && <Button variant="outline" size="sm" disabled={pending || Boolean(controlIntent)} onClick={() => void mutate('pause')}>Pause goal</Button>}
      {goal.state !== 'active' && <Button variant="outline" size="sm" disabled={pending || Boolean(controlIntent)} onClick={() => void mutate('resume')}>Resume goal</Button>}
      <Button variant="ghost" size="sm" disabled={pending || Boolean(controlIntent)} onClick={() => void mutate('complete')}>Complete goal</Button>
      <Button variant="ghost" size="sm" disabled={pending || Boolean(controlIntent)} onClick={() => void mutate('cancel')}>Cancel goal</Button>
    </div>}
    <p className="text-xs text-muted-foreground">Goal controls change future authorization. Already dispatched calls and independent processes still settle with their actual usage. Stop run also pauses its goal. A policy pause still needs its own exact resume.</p>
  </div>;
  return terminal ? <details className="rounded border p-2" aria-label="Past goal"><summary className="cursor-pointer">{status[goal.state]} goal · {goal.objective.split('\n')[0]}</summary>{content}</details>
    : <article className="space-y-2" aria-label="Current continuing goal">{content}</article>;
}

function GoalUsage({ goal }: { goal: Goal }) {
  const metrics: Array<[string, keyof Omit<GoalMeasuredUsage, 'inferences'>]> = [['Input', 'input_tokens'], ['Output', 'output_tokens'], ['Cache read', 'cached_input_tokens'], ['Cache write', 'cache_write_tokens'], ['Reasoning', 'reasoning_tokens']];
  return <div className="space-y-1 text-xs text-muted-foreground" aria-label="Goal usage">
    <p>Output budget: {goal.budget === null ? 'No limit' : `${count(goal.budget.maxOutputTokens)} tokens`}</p>
    <p>Reported output: {amount(goal.usage.actual.output_tokens)}</p>
    <p>Estimated output (separate): {amount(goal.usage.estimated.output_tokens)}</p>
    <p>{count(goal.usage.missing_inferences)} missing usage receipts · {count(goal.usage.pending_inferences)} pending inferences</p>
    <p>The budget checks provider-reported output before further dispatch. In-flight work can exceed it; estimates and unknown usage are not counted as zero or actual usage. A set budget blocks further inference when completed usage is incomplete.</p>
    <details><summary className="cursor-pointer">Usage details</summary>
      <p>Input, cache, and reasoning use the provider's original measurements. Providers differ in which counts overlap; do not add these fields into a token total.</p>
      {(['actual', 'estimated'] as const).map(kind => <div key={kind} className="my-2"><p>{kind === 'actual' ? 'Provider-reported' : 'Estimated'} · {count(goal.usage[kind].inferences)} inferences</p>
        {metrics.map(([label, key]) => <p key={key}>{label}: {amount(goal.usage[kind][key])}</p>)}
      </div>)}
    </details>
  </div>;
}
