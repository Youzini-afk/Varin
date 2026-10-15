import type { Goal, Followup } from '@varin/protocol';
import type { ThreadsAPI, ThreadIdentity } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';

export function ThreadWorkStrips({ api, identity, goals, followups, pending, act, onGoal, onFollowups }: {
  api: ThreadsAPI; identity: ThreadIdentity; goals: Goal[]; followups: Followup[]; pending: boolean;
  act(work: () => Promise<unknown>): Promise<void>; onGoal(): void; onFollowups(): void;
}) {
  const { t } = useI18n();
  const goal = goals.find(goal => goal.control !== 'complete' && goal.control !== 'cancelled');
  const waiting = followups.filter(followup => followup.state === 'active' && !followup.exhausted && !followup.goal_id);
  if (!goal && !waiting.length) return null;
  return <div className="chat-input-column mb-2 space-y-2">
    {goal && <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/70 bg-muted/15 px-3 py-2 typography-meta">
      <Icon name="target" className="size-3.5 shrink-0 text-primary" />
      <button type="button" onClick={onGoal} className="min-w-0 flex-1 truncate text-left" title={goal.objective}>{goal.objective}</button>
      <span className="shrink-0 tabular-nums text-muted-foreground">{goal.usage.actual.output_tokens.known.toLocaleString()}{goal.usage.actual.output_tokens.unknown_receipts || goal.usage.missing_inferences ? ' + ?' : ''}{goal.budget && ` / ${goal.budget.maxOutputTokens.toLocaleString()}`}</span>
      <button type="button" disabled={pending} aria-label={t(goal.state === 'active' ? 'chat.goal.action.pause' : 'chat.goal.action.resume')} className="rounded p-1 text-muted-foreground hover:bg-interactive-hover" onClick={() => void act(() => api.goals.control({ ...identity, goalId: goal.id, expectedRevision: goal.revision, action: goal.state === 'active' ? 'pause' : 'resume' }))}><Icon name={goal.state === 'active' ? 'pause' : 'play'} className="size-3.5" /></button>
    </div>}
    {waiting.map(followup => <div key={followup.id} className="flex min-w-0 items-center gap-2 rounded-lg border border-border/70 bg-muted/15 px-3 py-2 typography-meta">
      <Icon name="timer" className="size-3.5 shrink-0 text-muted-foreground" />
      <button type="button" onClick={onFollowups} className="min-w-0 flex-1 truncate text-left">{followup.trigger.kind === 'at' ? new Date(followup.trigger.at_ms).toLocaleString() : t('tasksHub.title')}</button>
      <button type="button" disabled={pending} className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-interactive-hover" onClick={() => void act(() => api.followups.control({ ...identity, followupId: followup.id, expectedRevision: followup.revision, action: 'cancel' }))}>{t('chat.followup.action.cancel')}</button>
    </div>)}
  </div>;
}
